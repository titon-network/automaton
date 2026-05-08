// Shared best-effort chain-state snapshot. Used by `automaton status`
// (render into a human-readable report) AND the daemon's gauge
// snapshotter (populate prom-client gauges). One place to update when
// new fields are added; callers convert / format as they see fit.
//
// Every RPC is wrapped in `tryAsync` — a single failed call leaves its
// field `undefined` and pushes an error string onto `errors` instead of
// aborting the whole snapshot. The status command surfaces `errors` in
// a footer; the daemon logs them at debug level.
//
// `includeSchema` controls whether the registry + pool `storageVersion`
// getters fire. The daemon runs `checkSchemaVersions` once at startup
// so it skips them on every tick (saving 2 RPCs); `automaton status`
// opts in so operators see the values inline.

import type { Address, OpenedContract } from '@ton/core';
import type { AutomatonInfo } from '@titon-network/forgeton-sdk';
import type { KronosRegistry } from '@titon-network/kronos-sdk';
import type { ChainRuntime } from './runtime';

export interface ChainSnapshot {
    balance?: bigint;
    /** `null` from `getAutomaton` means "not registered yet"; `undefined` means "RPC failed". */
    automaton?: AutomatonInfo | null;
    activeAutomatonCount?: bigint;
    jobCount?: bigint;
    accumulatedFees?: bigint;
    isPaused?: boolean;
    registryStorageVersion?: number;
    poolStorageVersion?: number;
    /** Per-field failure reasons. Never throws — callers get partial snapshots on RPC blips. */
    errors: string[];
    /** Set when the preflight probe fails and we bail before fan-out. */
    preflightFailed?: boolean;
}

export interface CollectSnapshotOptions {
    /** Also fetch registry + pool `storageVersion`. Default false. */
    includeSchema?: boolean;
    /**
     * Run `getMasterchainInfo` once before the parallel fan-out. When the
     * endpoint is fully dead this short-circuits a retry storm. Default true.
     */
    preflightProbe?: boolean;
}

async function tryAsync<T>(
    label: string,
    errors: string[],
    fn: () => Promise<T>,
): Promise<T | undefined> {
    try {
        return await fn();
    } catch (err) {
        errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
    }
}

/**
 * Gather the automaton's view of on-chain state. Safe to call on every
 * tick (daemon gauge refresh) and from one-shot commands (`status`).
 * Never throws; check `errors` / `preflightFailed` for partial reads.
 */
export async function collectChainSnapshot(
    runtime: ChainRuntime,
    walletAddr: Address,
    options: CollectSnapshotOptions = {},
): Promise<ChainSnapshot> {
    const errors: string[] = [];
    const includeSchema = options.includeSchema ?? false;
    const preflightProbe = options.preflightProbe ?? true;

    if (preflightProbe) {
        try {
            await runtime.client.getMasterchainInfo();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            errors.push(`chain unreachable: ${message}`);
            return { errors, preflightFailed: true };
        }
    }

    // Kronos-specific reads gate on whether the kronos product opened a
    // registry contract — Kronos-only operators always have it; specialised
    // operators (Phoebe-only, Argus-only) may not. NB: activeAutomatonCount
    // comes from the REGISTRY's mirror, not pool.getAutomatonCount (the
    // pool's counter is zombie-inclusive; the registry's drives `decide`'s
    // assignment rotation — see src/worker/mirror.ts).
    const registry = runtime.products.kronos?.registry as
        | OpenedContract<KronosRegistry>
        | undefined;

    // Helper: only run `fn` when `registry` is open; otherwise yield undefined.
    const ifRegistry = <T>(label: string, fn: (r: OpenedContract<KronosRegistry>) => Promise<T>) =>
        registry === undefined ? Promise.resolve(undefined) : tryAsync(label, errors, () => fn(registry));

    const snapshot: ChainSnapshot = { errors };
    const assign = <K extends keyof ChainSnapshot>(key: K, value: ChainSnapshot[K] | undefined) => {
        if (value !== undefined) snapshot[key] = value;
    };

    const [balance, automaton, activeCount, jobCount, accumulatedFees, isPaused, registrySchema, poolSchema] = await Promise.all([
        tryAsync('balance', errors, () => runtime.client.getBalance(walletAddr)),
        tryAsync('automaton', errors, () => runtime.pool.getAutomaton(walletAddr)),
        ifRegistry('active automaton count', (r) => r.getActiveAutomatonCount()),
        ifRegistry('jobCount', (r) => r.getJobCount()),
        ifRegistry('accumulatedFees', (r) => r.getAccumulatedFees()),
        ifRegistry('isPaused', (r) => r.getIsPaused()),
        includeSchema ? ifRegistry('registry schema', (r) => r.getStorageVersion()) : Promise.resolve(undefined),
        includeSchema ? tryAsync('pool schema', errors, () => runtime.pool.getStorageVersion()) : Promise.resolve(undefined),
    ]);

    assign('balance', balance);
    assign('automaton', automaton);
    assign('activeAutomatonCount', activeCount);
    assign('jobCount', jobCount);
    assign('accumulatedFees', accumulatedFees);
    assign('isPaused', isPaused);
    assign('registryStorageVersion', registrySchema);
    assign('poolStorageVersion', poolSchema);
    return snapshot;
}
