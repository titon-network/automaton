import { Address, toNano } from '@ton/core';
import type { JobData, RegistryConfigReply } from 'kronos-sdk';
import type { ChainRuntime } from '../src/chain';
import type { AutomatonWallet } from '../src/wallet';
import { AutomatonMirror } from '../src/worker/mirror';
import { emptyCheckpointState } from '../src/worker/checkpoint';
import { createDaemonMetrics } from '../src/daemon/metrics';
import { tickOnce } from '../src/daemon/orchestrator';
import { NOOP_COUNTERS, SILENT_LOGGER } from '../src/worker/loop';

// Orchestrator-level smoke: verify `tickOnce` composes drainEvents +
// runWorkerCycle correctly. Full orchestrator integration against a
// sandbox is D.15 work; this is the unit-level confidence test.

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

function fakeRuntime(overrides: { jobs?: Map<bigint, JobData>; txsEmpty?: boolean } = {}): ChainRuntime {
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
        deployment: { registry: ME, pool: ME },
        registry: registry as unknown as ChainRuntime['registry'],
        pool: pool as unknown as ChainRuntime['pool'],
    };
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

describe('tickOnce', () => {
    it('completes a no-op cycle without throwing and returns unchanged state', async () => {
        const runtime = fakeRuntime();
        const state = emptyCheckpointState();
        const result = await tickOnce({
            runtime,
            wallet: fakeWallet(),
            mirror: new AutomatonMirror(runtime),
            inFlight: new Set(),
            handlers: [],
            counters: NOOP_COUNTERS,
            logger: SILENT_LOGGER,
            checkpointState: state,
            jobFetchConcurrency: 2,
        });
        // Empty tx lists → no checkpoint advance → identity return.
        expect(result).toBe(state);
    });

    it('iterates jobs and invokes submitExecute for decide=execute cases', async () => {
        const runtime = fakeRuntime({
            jobs: new Map([[0n, fakeJob()]]),
        });
        // runWorkerCycle uses submitExecute (on WorkerDeps) — but TickDeps
        // doesn't expose it. The production default sends via sendAndConfirm
        // which we can't exercise here without a wallet; verify the cycle
        // reaches runWorkerCycle by checking the counter side-effects.
        const metrics = createDaemonMetrics();
        await tickOnce({
            runtime,
            wallet: fakeWallet(),
            mirror: new AutomatonMirror(runtime),
            inFlight: new Set(),
            handlers: [],
            counters: metrics.counters,
            metrics,
            logger: SILENT_LOGGER,
            checkpointState: emptyCheckpointState(),
            jobFetchConcurrency: 2,
        });
        // Job 0 is "never-executed" → decide=execute → attempt counter bumps.
        // defaultSubmitExecute will throw (no real wallet signature), so
        // success=0 but attempt=1.
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
            mirror: new AutomatonMirror(runtime),
            inFlight: new Set(),
            handlers: [],
            counters: metrics.counters,
            metrics,
            logger: SILENT_LOGGER,
            checkpointState: emptyCheckpointState(),
            jobFetchConcurrency: 2,
        });
        // No events dispatched, so the counter shouldn't emit a row at all.
        const output = await metrics.registry.metrics();
        expect(output).not.toMatch(/automaton_events_dispatched_total\{/);
    });
});
