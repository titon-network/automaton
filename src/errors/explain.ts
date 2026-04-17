// Unified error explanation across both SDKs + our own typed errors.
//
// Contract reverts surface as numeric TVM exit codes. Each SDK knows
// its own code range (kronos 100-119, pool 160-182, TVM 1-100 for
// both) and emits `origin: 'unknown'` for codes outside. We try kronos
// first, then forgeton, then fall back to a generic "unknown code".
//
// Our own typed errors (PoolRejectedError, LockHeldError, etc.) are
// already self-describing via `.message`; the CLI top-level handler
// prefers their formatted output over the generic stack trace. This
// module handles the "numeric code from a revert" translation only.

import { explainError as explainKronos } from 'kronos-sdk';
import { explainError as explainForgeton } from 'forgeton-sdk';

export type ExitOrigin = 'kronos' | 'forgeton' | 'tvm' | 'unknown';

export interface Explanation {
    code: number;
    origin: ExitOrigin;
    name: string;
    message: string;
    hint?: string;
}

/**
 * Resolve a TVM exit code to the most informative explanation available
 * from either SDK. Preference order:
 *   1. kronos-sdk (covers registry codes 100-119 + shared TVM 1-100)
 *   2. forgeton-sdk (covers pool codes 160-182)
 *   3. fallback {origin: 'unknown', name, message}
 *
 * Returns our own `Explanation` type instead of either SDK's to avoid
 * the `ErrorOrigin` union collision ('kronos' vs 'forgeton').
 */
export function explainExitCode(code: number): Explanation {
    const kronos = explainKronos(code);
    if (kronos.origin !== 'unknown') return normalise(kronos);
    const forgeton = explainForgeton(code);
    if (forgeton.origin !== 'unknown') return normalise(forgeton);
    return normalise(kronos);
}

function normalise(e: {
    code: number;
    origin: string;
    name: string;
    message: string;
    hint?: string;
}): Explanation {
    const origin: ExitOrigin =
        e.origin === 'kronos' || e.origin === 'forgeton' || e.origin === 'tvm'
            ? (e.origin as ExitOrigin)
            : 'unknown';
    const out: Explanation = {
        code: e.code,
        origin,
        name: e.name,
        message: e.message,
    };
    if (e.hint !== undefined) out.hint = e.hint;
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
 *   - `err.exitCode` (kronos-sdk / forgeton-sdk convention on KronosError / ForgetonError)
 *   - `err.code` when it's a finite number (SDKs that wrap natively)
 *   - string messages containing `exit code N` (sandbox errors)
 * Returns `null` when no code can be identified.
 */
export function extractExitCode(err: unknown): number | null {
    if (err === null || typeof err !== 'object') return null;
    const e = err as { exitCode?: unknown; code?: unknown; message?: unknown };
    if (typeof e.exitCode === 'number' && Number.isFinite(e.exitCode)) return e.exitCode;
    if (typeof e.code === 'number' && Number.isFinite(e.code)) return e.code;
    if (typeof e.message === 'string') {
        // Word-boundary anchors so the match only fires on phrases like
        // "reverted with exit code 160" — not on an operator's stray
        // "exit code 9999 found" appearing in unrelated prose.
        const m = /\bexit code\s+(\d+)\b/i.exec(e.message);
        if (m !== null) return Number(m[1]);
    }
    return null;
}
