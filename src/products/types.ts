// Product module interface — the unit of pluggability for the entire
// automaton stack.
//
// ForgeTON pool is the only true BASELINE: every operator stakes there
// regardless of which products they enable. Kronos automation, Fortuna
// VRF, and any future product (Phoebe price oracle, Argus indexer, …)
// are ALL `ProductModule` instances. A specialised operator can disable
// Kronos and run only Phoebe; the daemon adapts.
//
// Adding a new product (worked example: Phoebe price oracle):
//   1. `pnpm add @titon-network/phoebe-sdk` (or `file:../phoebe/sdk`).
//   2. Add `phoebe: z.boolean()` to ConfigSchema.products in
//      src/config/schema.ts; default to `false` in defaultConfig.
//   3. Create src/products/phoebe.ts implementing ProductModule. Copy
//      kronos.ts (poll-driven worker) or fortuna.ts (event-driven worker)
//      as a template.
//   4. Add it to PRODUCTS in src/products/index.ts.
// Done — every other file (orchestrator, events, deployment, schema-check,
// explain, doctor, status) iterates PRODUCTS and picks it up automatically.

import type { Address, OpenedContract } from '@ton/core';
import type { Config } from '../config/schema';
import type { FailoverTonClient } from '../chain/ton-client';
import type { AutomatonWallet } from '../wallet';
import type { WorkerLogger } from '../worker/loop';
import type { EventHandler, EventSource } from '../worker/events';
import type { DaemonMetrics } from '../daemon/metrics';

// Re-export so importers don't have to reach into worker/events.ts —
// EventSource is part of every product's eventStreams() return type.
export type { EventSource };

// ===== Building blocks =====

/** A bag of named addresses contributed by a product. Keys are stable identifiers
 *  (e.g. `atlas`, `fortuna` for the fortuna product), used as the suffix in
 *  per-contract status lines and schema-mismatch messages. */
export type ProductAddresses = Record<string, Address>;

/** Opened contract handles parallel to ProductAddresses — same keys, same shape. */
export type ProductContracts = Record<string, OpenedContract<unknown>>;

/** Schema-version reconciliation contributed by a product. checkSchemaVersions
 *  iterates these alongside the baseline pool check. */
export interface SchemaCheckTask {
    /** Stable identifier for the contract. Used in mismatch error messages. */
    readonly contract: string;
    readonly address: Address;
    /** SDK constant value the daemon was built against. */
    readonly expected: number;
    /** Variable name printed in mismatch messages, e.g. 'FORTUNA_STORAGE_VERSION'. */
    readonly sdkVariable: string;
    /** Read the live on-chain schema version. */
    readonly read: () => Promise<number>;
}

/** Operator-action worker contributed by a product. KronosWorker (poll-driven)
 *  and FortunaWorker (event-driven) are the two canonical reference implementations. */
export interface ProductWorker {
    /** One operator-action cycle. Pure observers (e.g. Argus) leave this undefined. */
    tick?(): Promise<unknown>;
    /** True iff there are in-flight on-chain submissions. Orchestrator's shutdown
     *  drain waits on this so a SIGTERM doesn't abandon a half-sent message. */
    hasInFlight(): boolean;
    /** EventHandler this worker contributes (request enqueue, etc.). */
    eventHandler(): EventHandler;
    /**
     * Push current state (pending queue size, etc.) to per-product gauges
     * on the shared `DaemonMetrics` registry. Called by orchestrator's
     * tickOnce after `tick()` so /metrics reads live values instead of
     * carry-over from the prior drain. Optional — workers without
     * post-tick gauges leave this undefined.
     */
    publishMetrics?(metrics: DaemonMetrics): void;
    /**
     * Release any owned resources (HTTP servers, file handles, peer
     * connections). Called by the orchestrator in the shutdown finally
     * block, after `hasInFlight()` reports drained. Optional — workers
     * with no owned resources omit it. Today only the multi-op
     * `FortunaWorker` uses this (closes its share-exchange server).
     */
    dispose?(): Promise<void>;
}

/** Doctor's install-layer check (typically: "X-sdk resolves with non-zero exports"). */
export interface InstallCheck {
    readonly name: string;
    run(): Promise<InstallCheckResult> | InstallCheckResult;
}

export interface InstallCheckResult {
    status: 'ok' | 'warn' | 'fail' | 'skip';
    detail: string;
}

/**
 * Helper for `ProductModule.doctorInstallChecks` — emits the canonical
 * "<package> resolves" check that every product wants. Verifies the SDK
 * package can be `import()`-ed at runtime AND that it has at least one
 * export (sibling SDKs are file: deps; an empty barrel typically means
 * a missing `pnpm run sync:sdks` after editing source).
 *
 * @example
 *   doctorInstallChecks: () => [
 *       makeSdkResolveCheck('@titon-network/phoebe-sdk'),
 *   ],
 */
export function makeSdkResolveCheck(packageName: string): InstallCheck {
    return {
        name: `${packageName} resolves`,
        async run() {
            const mod = (await import(packageName)) as Record<string, unknown>;
            const count = Object.keys(mod).length;
            if (count === 0) {
                return {
                    status: 'fail',
                    detail: `${packageName} has zero exports — run \`pnpm run sync:sdks\``,
                };
            }
            return { status: 'ok', detail: `${count} exports` };
        },
    };
}

/** Unified error explanation shape. Each product's table uses its own `origin`
 *  string — the set is open (kronos / forgeton / atlas / fortuna / phoebe / …)
 *  but well-known origins ('kronos', 'forgeton', 'tvm') get special handling
 *  for backward-compat with the legacy ExitOrigin union. */
export interface ErrorExplanation {
    code: number;
    origin: string;
    name: string;
    message: string;
    hint?: string;
}

// ===== Context =====

/**
 * Data-only handle passed to the lightweight methods (openContracts /
 * schemaChecks / eventStreams). They produce values from chain identity
 * + opened contracts; they don't need wallet / logger / metrics.
 *
 * `contracts` is `{}` for openContracts (it RETURNS the contracts) and
 * populated for schemaChecks / eventStreams.
 */
export interface ProductHandle {
    client: FailoverTonClient;
    addresses: ProductAddresses;
    contracts: ProductContracts;
}

/**
 * Full deps bag for the worker-bearing methods (bootstrapWorker /
 * buildHandlers). Extends `ProductHandle` with everything the daemon
 * knows at startup.
 */
export interface ProductContext extends ProductHandle {
    config: Config;
    wallet: AutomatonWallet;
    /** Already-validated wallet password. Reused for per-product keystores
     *  (e.g. fortuna's bls.enc). */
    walletPassword: string;
    logger: WorkerLogger;
    /** Daemon metrics bundle. Optional — sandbox tests may construct workers
     *  directly. Production always passes this. */
    metrics?: DaemonMetrics;
    /** The bootstrapped worker for this product. Populated for buildHandlers
     *  (after bootstrapWorker has run); undefined for observational products. */
    worker?: ProductWorker;
}

/**
 * The complete pluggability surface for a product.
 *
 * Implementations:
 *   - src/products/kronos.ts  — poll-driven worker (registry → execute jobs)
 *   - src/products/fortuna.ts — event-driven worker (request queue → fulfill)
 *   - src/products/phoebe.ts  (when Phoebe lands)
 *   - src/products/argus.ts   (observational — bootstrapWorker undefined)
 */
export interface ProductModule {
    /** Lower-case stable identifier. Used as config flag, deployment key,
     *  metric label, etc. */
    readonly name: string;

    /** True iff the operator opted into this product via config.products[name]. */
    isEnabled(config: Config): boolean;

    /**
     * Resolve every address contributed by this product. Returns an empty
     * record when the product is disabled. Throws DeploymentNotAvailableError
     * (from chain/deployment.ts) when enabled but no address can be resolved
     * (e.g. SDK constant null AND no config override).
     */
    resolveAddresses(config: Config): ProductAddresses;

    /**
     * Open the contracts this product talks to. Keys mirror resolveAddresses.
     * Returned handles flow to bootstrapWorker + buildHandlers + schemaChecks
     * via runtime.products[name].
     */
    openContracts(handle: ProductHandle): ProductContracts;

    /**
     * Schema-version reconciliation tasks. Bundled with the baseline
     * pool check at daemon startup; mismatch on any throws
     * SchemaMismatchError and refuses to start.
     */
    schemaChecks(handle: ProductHandle): SchemaCheckTask[];

    /**
     * Event streams to drain per tick. One per emitting contract. The drain
     * dispatches each decoded event to handlers via `event-handler.on[source]`.
     */
    eventStreams(handle: ProductHandle): EventSource[];

    /**
     * Bootstrap the operator-action worker, if this product needs one.
     * Observational products (e.g. Argus, a pure-event indexer) return
     * undefined and contribute only event handlers + addresses.
     */
    bootstrapWorker?(ctx: ProductContext): Promise<ProductWorker | undefined>;

    /**
     * Built-in event handlers contributed by this product. Composed
     * alongside the baseline ForgeTON handlers (selfSlash / consumerWatch /
     * forgetonAwareness / forgetonHealth) by orchestrator.buildHandlers.
     */
    buildHandlers(ctx: ProductContext): EventHandler[];

    /**
     * Resolve a TVM exit code in this product's table. Returns
     * `origin: 'unknown'` for codes outside its range so the unified
     * explainer can fall through.
     */
    explainError(code: number): ErrorExplanation;

    /**
     * Doctor's install-layer check (typically: "@titon-network/<name>-sdk
     * resolves with N exports"). Always-run; not gated on isEnabled —
     * operators benefit from knowing the SDK is reachable even before they
     * flip the product flag.
     */
    doctorInstallChecks(): InstallCheck[];
}
