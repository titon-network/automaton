// Orchestrator-level smoke: verify `tickOnce` composes drainEvents +
// product workers correctly. Full end-to-end coverage against a sandbox
// is in Integration.spec.ts; this spec pins the unit-level composition
// (counters / metrics increment wiring, no-op cycle identity, productWorkers
// iteration).

import { Address, toNano } from '@ton/core';
import type { JobData, RegistryConfigReply } from '@titon-network/kronos-sdk';
import type { ChainRuntime } from '../src/chain';
import type { AutomatonWallet } from '../src/wallet';
import { emptyCheckpointState } from '../src/worker/checkpoint';
import { createDaemonMetrics } from '../src/daemon/metrics';
import { tickOnce } from '../src/daemon/orchestrator';
import { SILENT_LOGGER } from '../src/worker/loop';
import { KronosWorker } from '../src/products/kronos';

const ME = Address.parse('0QBsK1tN7AiqL_Hovc1p6HdWC8tYFZ4wt-Jch1vg9arryx5N');
const TARGET = Address.parse('0QD7zcV7CJWCIPf728h3ill4hgCcQreptkVaaLJJGrMEh3Bb');

const CONFIG: RegistryConfigReply = {
    minReward: toNano('0.01'),
    minFunding: toNano('1'),
    minInterval: 60,
    maxInterval: 86_400,
    protocolFeeBps: 500,
    minStorageReserve: toNano('0.05'),
    minGasReserve: toNano('0.05'),
    primaryWindowSeconds: 30,
    slashGasCost: toNano('0.02'),
};

function fakeJob(): JobData {
    return {
        schemaVersion: 1,
        target: TARGET,
        interval: 3600,
        reward: toNano('0.1'),
        gasLimit: toNano('0.1'),
        maxExecutions: 0,
        executionCount: 0,
        windowBefore: 30,
        windowAfter: 600,
        expireAfter: 0,
        owner: ME,
        balance: toNano('10'),
        lastExecutedAt: 0,
        isActive: true,
    };
}

function fakeRuntime(overrides: { jobs?: Map<bigint, JobData> } = {}): ChainRuntime {
    const jobs = overrides.jobs ?? new Map<bigint, JobData>();
    const registry = {
        getConfig: async () => CONFIG,
        getJobCount: async () => BigInt(jobs.size),
        getIsPaused: async () => false,
        getJob: async (id: bigint) => jobs.get(id) ?? null,
        getActiveAutomatonCount: async () => 1n,
        getAutomatonAt: async (i: number) => (i === 0 ? ME : null),
    };
    const pool = { getAutomatonCount: async () => 1n };
    // Drain-side stub: drain calls client.call with a function referencing
    // getTransactions. Returning [] tells drain "no new events".
    const client = {
        call: async (fn: (c: unknown) => Promise<unknown>) => {
            const src = fn.toString();
            if (src.includes('getTransactions')) return [];
            if (src.includes('getBalance')) return toNano('5');
            throw new Error(`unexpected client.call: ${src}`);
        },
        currentEndpoint: 'https://fake.example/api',
        listEndpoints: () => ['https://fake.example/api'],
    };
    return {
        client: client as unknown as ChainRuntime['client'],
        deployment: {
            pool: ME,
            products: { kronos: { registry: ME } },
        },
        pool: pool as unknown as ChainRuntime['pool'],
        products: {
            kronos: { registry: registry as unknown as never },
        },
    };
}

// Baseline-only sources for tests that don't enable any product. The
// no-op decode `() => []` keeps drain a pure get-transactions check.
function baselineSourcesFor(runtime: ChainRuntime) {
    return [
        { source: 'pool' as const, address: runtime.deployment.pool, decode: () => [] },
    ];
}

function fakeWallet(): AutomatonWallet {
    return {
        address: ME,
        mnemonic: [],
        keyPair: { publicKey: Buffer.alloc(0), secretKey: Buffer.alloc(0) },
        walletContract: {} as AutomatonWallet['walletContract'],
        network: 'testnet',
    };
}

function buildKronosWorker(
    runtime: ChainRuntime,
    metrics: ReturnType<typeof createDaemonMetrics>,
    submitExecute?: (...args: unknown[]) => Promise<void>,
): KronosWorker {
    return new KronosWorker({
        registry: runtime.products.kronos!.registry as never,
        client: runtime.client,
        wallet: fakeWallet(),
        logger: SILENT_LOGGER,
        counters: metrics.counters,
        ...(submitExecute !== undefined ? { submitExecute: submitExecute as never } : {}),
    });
}

describe('tickOnce', () => {
    it('completes a no-op cycle without throwing and returns unchanged state', async () => {
        const runtime = fakeRuntime();
        const state = emptyCheckpointState();
        const metrics = createDaemonMetrics();
        const result = await tickOnce({
            runtime,
            wallet: fakeWallet(),
            handlers: [],
            sources: baselineSourcesFor(runtime),
            metrics,
            logger: SILENT_LOGGER,
            checkpointState: state,
            productWorkers: { kronos: buildKronosWorker(runtime, metrics, async () => {}) },
        });
        // Empty tx lists → no checkpoint advance → identity return.
        expect(result).toBe(state);
    });

    it('iterates jobs and invokes submitExecute for decide=execute cases', async () => {
        const runtime = fakeRuntime({
            jobs: new Map([[0n, fakeJob()]]),
        });
        const metrics = createDaemonMetrics();
        await tickOnce({
            runtime,
            wallet: fakeWallet(),
            handlers: [],
            sources: baselineSourcesFor(runtime),
            metrics,
            logger: SILENT_LOGGER,
            checkpointState: emptyCheckpointState(),
            productWorkers: { kronos: buildKronosWorker(runtime, metrics, async () => {}) },
        });
        // Job 0 is "never-executed" → decide=execute → attempt counter bumps.
        const output = await metrics.registry.metrics();
        expect(output).toMatch(
            /automaton_execute_attempts_total\{reason="never-executed"\} 1/,
        );
    });

    it('wires drainDispatched counters even when dispatched=0', async () => {
        const runtime = fakeRuntime();
        const metrics = createDaemonMetrics();
        await tickOnce({
            runtime,
            wallet: fakeWallet(),
            handlers: [],
            sources: baselineSourcesFor(runtime),
            metrics,
            logger: SILENT_LOGGER,
            checkpointState: emptyCheckpointState(),
            productWorkers: { kronos: buildKronosWorker(runtime, metrics, async () => {}) },
        });
        // No events dispatched, so the counter shouldn't emit a row at all.
        const output = await metrics.registry.metrics();
        expect(output).not.toMatch(/automaton_events_dispatched_total\{/);
    });
});
