// collectChainSnapshot: shared read-path used by `automaton status` and
// the daemon's gauge-snapshot cadence. Covers the preflight short-circuit,
// per-field best-effort error capture (tryAsync), activeAutomatonCount
// sourced from the REGISTRY (not pool — see snapshot.ts comment), and the
// preflightProbe: false bypass for hot-path daemon calls.

import { Address, toNano } from '@ton/core';
import type { AutomatonInfo } from '@titon-network/forgeton-sdk';
import type { ChainRuntime } from '../src/chain';
import { collectChainSnapshot } from '../src/chain/snapshot';

const ADDR = Address.parse('0QBsK1tN7AiqL_Hovc1p6HdWC8tYFZ4wt-Jch1vg9arryx5N');

function makeRuntime(overrides: {
    preflightError?: Error;
    balance?: bigint | Error;
    automaton?: AutomatonInfo | null | Error;
    activeCount?: bigint | Error;
    jobCount?: bigint | Error;
    accumulatedFees?: bigint | Error;
    isPaused?: boolean | Error;
    registrySchema?: number | Error;
    poolSchema?: number | Error;
}): ChainRuntime {
    const client = {
        getMasterchainInfo: async () => {
            if (overrides.preflightError) throw overrides.preflightError;
            return { latestSeqno: 1 };
        },
        getBalance: async () => {
            if (overrides.balance instanceof Error) throw overrides.balance;
            return overrides.balance;
        },
    };
    const pool = {
        getAutomaton: async () => {
            if (overrides.automaton instanceof Error) throw overrides.automaton;
            return overrides.automaton ?? null;
        },
        getStorageVersion: async () => {
            if (overrides.poolSchema instanceof Error) throw overrides.poolSchema;
            return overrides.poolSchema ?? 1;
        },
    };
    const registry = {
        getActiveAutomatonCount: async () => {
            if (overrides.activeCount instanceof Error) throw overrides.activeCount;
            return overrides.activeCount ?? 0n;
        },
        getJobCount: async () => {
            if (overrides.jobCount instanceof Error) throw overrides.jobCount;
            return overrides.jobCount ?? 0n;
        },
        getAccumulatedFees: async () => {
            if (overrides.accumulatedFees instanceof Error) throw overrides.accumulatedFees;
            return overrides.accumulatedFees ?? 0n;
        },
        getIsPaused: async () => {
            if (overrides.isPaused instanceof Error) throw overrides.isPaused;
            return overrides.isPaused ?? false;
        },
        getStorageVersion: async () => {
            if (overrides.registrySchema instanceof Error) throw overrides.registrySchema;
            return overrides.registrySchema ?? 1;
        },
    };
    return {
        client: client as unknown as ChainRuntime['client'],
        deployment: { pool: ADDR, products: { kronos: { registry: ADDR } } },
        pool: pool as unknown as ChainRuntime['pool'],
        products: {
            kronos: { registry: registry as unknown as never },
        },
    };
}

describe('collectChainSnapshot', () => {
    it('returns all fields on a healthy chain', async () => {
        const automaton: AutomatonInfo = {
            schemaVersion: 1,
            stake: toNano('10'),
            isActive: true,
            slashCount: 0,
            registeredAt: 1_700_000_000,
            unstakeRequestedAt: 0,
        };
        const runtime = makeRuntime({
            balance: toNano('5'),
            automaton,
            activeCount: 3n,
            jobCount: 12n,
            accumulatedFees: toNano('0.5'),
            isPaused: false,
        });

        const snap = await collectChainSnapshot(runtime, ADDR, { includeSchema: true });
        expect(snap.errors).toEqual([]);
        expect(snap.preflightFailed).toBeUndefined();
        expect(snap.balance).toBe(toNano('5'));
        expect(snap.automaton).toBe(automaton);
        expect(snap.activeAutomatonCount).toBe(3n);
        expect(snap.jobCount).toBe(12n);
        expect(snap.accumulatedFees).toBe(toNano('0.5'));
        expect(snap.isPaused).toBe(false);
        expect(snap.registryStorageVersion).toBe(1);
        expect(snap.poolStorageVersion).toBe(1);
    });

    it('bails with preflightFailed when the preflight probe throws', async () => {
        const runtime = makeRuntime({ preflightError: new Error('ECONNRESET') });
        const snap = await collectChainSnapshot(runtime, ADDR);
        expect(snap.preflightFailed).toBe(true);
        expect(snap.errors).toEqual(['chain unreachable: ECONNRESET']);
        expect(snap.balance).toBeUndefined();
    });

    it('records per-field errors but continues on partial RPC failures', async () => {
        const runtime = makeRuntime({
            balance: new Error('balance rpc 503'),
            automaton: null,
            activeCount: 7n,
            jobCount: new Error('jobCount rpc 429'),
            accumulatedFees: 0n,
        });

        const snap = await collectChainSnapshot(runtime, ADDR);
        expect(snap.balance).toBeUndefined();
        expect(snap.jobCount).toBeUndefined();
        expect(snap.activeAutomatonCount).toBe(7n);
        expect(snap.automaton).toBeNull(); // null = not registered, distinct from undefined
        expect(snap.errors).toEqual(expect.arrayContaining([
            expect.stringContaining('balance: balance rpc 503'),
            expect.stringContaining('jobCount: jobCount rpc 429'),
        ]));
    });

    it('skips schema reads when includeSchema is false (default)', async () => {
        const runtime = makeRuntime({
            balance: toNano('1'),
            automaton: null,
        });
        const snap = await collectChainSnapshot(runtime, ADDR);
        expect(snap.registryStorageVersion).toBeUndefined();
        expect(snap.poolStorageVersion).toBeUndefined();
    });

    it('skips the preflight probe when preflightProbe is false', async () => {
        const runtime = makeRuntime({
            preflightError: new Error('should not be called'),
            balance: toNano('1'),
            automaton: null,
        });
        // If preflight ran, it would push an error. Skipping it means
        // the other reads happen directly.
        const snap = await collectChainSnapshot(runtime, ADDR, { preflightProbe: false });
        expect(snap.preflightFailed).toBeUndefined();
        expect(snap.balance).toBe(toNano('1'));
    });
});
