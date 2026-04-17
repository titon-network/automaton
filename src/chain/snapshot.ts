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

import type { Address } from '@ton/core';
import type { AutomatonInfo } from 'forgeton-sdk';
import type { ChainRuntime } from './runtime';

export interface ChainSnapshot {
    balance?: bigint;
    /** `null` from `getAutomaton` means "not registered yet"; `undefined` means "RPC failed". */
    automaton?: AutomatonInfo | null;
    activeAutomatonCount?: bigint;
    syncesReceived?: bigint;
    slashesRequested?: bigint;
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

    // NB: activeAutomatonCount comes from the REGISTRY's mirror, not from
    // pool.getAutomatonCount. The pool's counter is zombie-inclusive
    // (includes fully-unstaked addresses still in the map); the registry's
    // is what `decide` uses for assignment rotation. See
    // src/worker/mirror.ts for the source-of-truth rationale.
    const coreReads = [
        tryAsync('balance', errors, () => runtime.client.getBalance(walletAddr)),
        tryAsync('automaton', errors, () => runtime.pool.getAutomaton(walletAddr)),
        tryAsync('active automaton count', errors, () => runtime.registry.getActiveAutomatonCount()),
        tryAsync('syncesReceived', errors, () => runtime.registry.getSyncesReceived()),
        tryAsync('slashesRequested', errors, () => runtime.registry.getSlashesRequested()),
    ] as const;
    const schemaReads = includeSchema
        ? ([
              tryAsync('registry schema', errors, () => runtime.registry.getStorageVersion()),
              tryAsync('pool schema', errors, () => runtime.pool.getStorageVersion()),
          ] as const)
        : ([
              Promise.resolve(undefined),
              Promise.resolve(undefined),
          ] as const);

    const [
        balance,
        automaton,
        activeCount,
        syncesReceived,
        slashesRequested,
        registrySchema,
        poolSchema,
    ] = await Promise.all([...coreReads, ...schemaReads] as const);

    const snapshot: ChainSnapshot = { errors };
    if (balance !== undefined) snapshot.balance = balance;
    if (automaton !== undefined) snapshot.automaton = automaton;
    if (activeCount !== undefined) snapshot.activeAutomatonCount = activeCount;
    if (syncesReceived !== undefined) snapshot.syncesReceived = syncesReceived;
    if (slashesRequested !== undefined) snapshot.slashesRequested = slashesRequested;
    if (registrySchema !== undefined) snapshot.registryStorageVersion = registrySchema;
    if (poolSchema !== undefined) snapshot.poolStorageVersion = poolSchema;
    return snapshot;
}
