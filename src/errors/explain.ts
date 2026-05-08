// Unified error explanation across the baseline SDKs (kronos, forgeton)
// and every registered ProductModule (fortuna today; phoebe / argus next).
//
// Contract reverts surface as numeric TVM exit codes. Each SDK owns its
// own table; several ranges overlap with DIFFERENT meanings across SDKs
// (e.g. 161 means `E_NOT_REGISTERED` in forgeton, `E_INVALID_BLS_SIGNATURE`
// in fortuna). Pass `hint` when the call site knows which contract emitted
// the revert (the worker / submit machinery does — Kronos `Execute` reverts
// route through kronos, Fortuna `FulfillRandomness` through fortuna, etc.).
// Without a hint we walk all SDKs in priority order; first non-unknown wins.
//
// Adding a new product = drop a ProductModule with an `explainError`
// implementation in src/products/<name>.ts; this file picks it up
// automatically by iterating `PRODUCTS`.
//
// Our own typed errors (PoolRejectedError, LockHeldError, etc.) are
// already self-describing via `.message`; the CLI top-level handler
// prefers their formatted output over the generic stack trace. This
// module handles the "numeric code from a revert" translation only.

import { explainError as explainKronos } from '@titon-network/kronos-sdk';
import { explainError as explainForgeton } from '@titon-network/forgeton-sdk';
import { explainError as explainAtlas } from '@titon-network/atlas-sdk';
import { PRODUCTS, findProduct } from '../products';
import type { ErrorExplanation as ProductErrorExplanation } from '../products/types';

/** Open-string origin: well-known baseline + tvm + every registered product. */
export type ExitOrigin = 'kronos' | 'forgeton' | 'tvm' | 'unknown' | string;

export interface Explanation {
    code: number;
    origin: ExitOrigin;
    name: string;
    message: string;
    hint?: string;
}

/** Caller-supplied hint when the originating contract is known. Open-string
 *  — accepts any baseline name ('kronos' / 'forgeton') OR any registered
 *  product name ('fortuna' / 'phoebe' / …). Unknown hints fall through to
 *  the priority walk. */
export type ExplainHint = string;

/**
 * Resolve a TVM exit code to the most informative explanation available.
 *
 * Priority without `hint`:  kronos → fortuna → atlas → forgeton → TVM-only.
 * With `hint`: the named SDK is consulted first; if it returns origin=unknown
 * the walk continues with the others as a fallback.
 *
 * Atlas is consulted directly (not via a ProductModule) because Atlas isn't
 * a product operators opt into — it's the substrate Fortuna's BLS share
 * registry sits on. Reverts from `automaton bls register` come back as
 * Atlas exit codes (e.g. `OperatorNotFound = 120`), which fortuna-sdk
 * doesn't fully cover (its atlasRangeHint only spans 210-229).
 *
 * Returns our own `Explanation` type instead of any SDK's to normalize the
 * `ErrorOrigin` union (the SDKs each declare overlapping but non-identical
 * unions).
 */
export function explainExitCode(code: number, hint?: ExplainHint): Explanation {
    if (hint !== undefined) {
        const direct = explainViaHint(code, hint);
        if (direct !== null && direct.origin !== 'unknown') return direct;
        // Hinted SDK didn't recognise the code — fall through to the
        // priority walk to surface a TVM hit or another SDK's owned range.
    }

    // Baseline first: kronos owns 100-159 of titon's stack, forgeton 100-179.
    // Then every product in registration order — fortuna is the only one
    // today, with codes 100-249 (fortuna's own ranges) plus TVM 0-100.
    // Atlas after products (for the BLS-register revert path), forgeton last.
    const explainers: Array<(c: number) => unknown> = [
        explainKronos,
        ...PRODUCTS.map((p) => (c: number) => p.explainError(c)),
        explainAtlas,
        explainForgeton,
    ];
    for (const ex of explainers) {
        const r = ex(code) as { origin: string };
        if (r.origin !== 'unknown') return normalise(r);
    }
    // Nothing claimed it — return the kronos default 'unknown' shape.
    return normalise(explainKronos(code) as { origin: string; code: number; name: string; message: string });
}

function explainViaHint(code: number, hint: ExplainHint): Explanation | null {
    if (hint === 'kronos') return normalise(explainKronos(code));
    if (hint === 'forgeton') return normalise(explainForgeton(code));
    if (hint === 'atlas') return normalise(explainAtlas(code));
    const product = findProduct(hint);
    if (product !== undefined) return normalise(product.explainError(code));
    return null;
}

function normalise(e: unknown): Explanation {
    const r = e as ProductErrorExplanation;
    const origin: ExitOrigin =
        r.origin === 'kronos'
        || r.origin === 'forgeton'
        || r.origin === 'tvm'
            ? r.origin
            : r.origin === 'unknown'
                ? 'unknown'
                : r.origin; // open-string: passes through product origins ('fortuna', 'atlas', 'phoebe', …)
    const out: Explanation = {
        code: r.code,
        origin,
        name: r.name,
        message: r.message,
    };
    if (r.hint !== undefined) out.hint = r.hint;
    return out;
}

/**
 * Render an explanation in the project's standard operator-facing
 * format: first line is the code + name + message; subsequent lines
 * (if any) carry the hint, each prefixed with `  hint: `.
 */
export function formatExplanation(e: Explanation): string {
    const head = `exit ${e.code} (${e.origin}) ${e.name}: ${e.message}`;
    return e.hint === undefined ? head : `${head}\n  hint: ${e.hint}`;
}

/**
 * Try to extract a numeric exit code from an error object. Handles:
 *   - `err.exitCode` (SDK convention on KronosError / ForgetonError / etc.)
 *   - `err.code` when it's a finite number (SDKs that wrap natively)
 *   - string messages containing `exit code N` (sandbox errors)
 *   - `err.reason` (and `err.cause`) — recursively peek through one level
 *     of wrapping, so `PoolRejectedError` / similar wrappers don't bury
 *     a verify-callback exit code. Bounded depth so we can't loop on a
 *     self-referential cycle.
 *
 * Returns `null` when no code can be identified.
 */
export function extractExitCode(err: unknown): number | null {
    return extractExitCodeBounded(err, 4);
}

function extractExitCodeBounded(err: unknown, depth: number): number | null {
    if (depth <= 0 || err === null || typeof err !== 'object') return null;
    const e = err as { exitCode?: unknown; code?: unknown; message?: unknown; reason?: unknown; cause?: unknown };
    if (typeof e.exitCode === 'number' && Number.isFinite(e.exitCode)) return e.exitCode;
    if (typeof e.code === 'number' && Number.isFinite(e.code)) return e.code;
    if (typeof e.message === 'string') {
        // Word-boundary anchors so the match only fires on phrases like
        // "reverted with exit code 160" — not on an operator's stray
        // "exit code 9999 found" appearing in unrelated prose.
        const m = /\bexit code\s+(\d+)\b/i.exec(e.message);
        if (m !== null) return Number(m[1]);
    }
    // Wrapper unwrap: PoolRejectedError stores the inner verify-callback
    // exception in .reason; native ES errors use .cause. Walk both —
    // bounded so a cycle (err.reason === err) can't trap us.
    const fromReason = extractExitCodeBounded(e.reason, depth - 1);
    if (fromReason !== null) return fromReason;
    return extractExitCodeBounded(e.cause, depth - 1);
}

/**
 * Try to extract a contract-origin hint from an error chain. Hints come
 * from:
 *   - `err.explainHint` (set by `sendAndConfirm` callers + PoolRejectedError)
 *   - `err.origin` (the field SDKs use on their ErrorExplanation shape;
 *     useful when an SDK error bubbles up directly without a wrapper)
 *   - recursively through `err.reason` / `err.cause` — same bounded walk
 *     as extractExitCode, so wrappers don't lose the routing info.
 *
 * Returns `undefined` when no hint can be identified. The CLI top-level
 * catch passes this to `explainExitCode(code, hint)` so a code that
 * overlaps across multiple SDKs (e.g. 120 means three different things
 * in kronos / fortuna / atlas) resolves to the right interpretation.
 */
export function extractExplainHint(err: unknown): ExplainHint | undefined {
    return extractExplainHintBounded(err, 4);
}

function extractExplainHintBounded(err: unknown, depth: number): ExplainHint | undefined {
    if (depth <= 0 || err === null || typeof err !== 'object') return undefined;
    const e = err as { explainHint?: unknown; origin?: unknown; reason?: unknown; cause?: unknown };
    if (typeof e.explainHint === 'string' && e.explainHint.length > 0) return e.explainHint;
    // SDK ErrorExplanation shape uses `.origin`. Skip 'unknown' and 'tvm'
    // — those don't disambiguate; let the priority walk handle them.
    if (typeof e.origin === 'string' && e.origin.length > 0 && e.origin !== 'unknown' && e.origin !== 'tvm') {
        return e.origin;
    }
    const fromReason = extractExplainHintBounded(e.reason, depth - 1);
    if (fromReason !== undefined) return fromReason;
    return extractExplainHintBounded(e.cause, depth - 1);
}
