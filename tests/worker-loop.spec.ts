// runWorkerCycle: single-iteration worker loop exercised with injected
// runtime + submit stub. Covers single-flight guard, per-job fetch-error
// isolation, counter calls on every decision (attempts/success/failure/skip),
// paused-registry gate, classifyExecuteFailure taxonomy (incl. the
// PoolRejectedError verify-failed unwrap), and bounded-label cardinality.

import { Address, toNano } from '@ton/core';
import type { JobData, RegistryConfigReply } from 'kronos-sdk';
import type { AutomatonWallet } from '../src/wallet';
import { PoolRejectedError, type ChainRuntime } from '../src/chain';
import { AutomatonMirror } from '../src/worker/mirror';
import { NOOP_COUNTERS, runWorkerCycle } from '../src/worker/loop';

// Base shape for counter tests — lets each test override just the counter
// they care about instead of redefining the whole surface every time.
const NOOP_COUNTERS_SHAPE = NOOP_COUNTERS;

const ME = Address.parse('0QBsK1tN7AiqL_Hovc1p6HdWC8tYFZ4wt-Jch1vg9arryx5N');
const OTHER = Address.parse('0QC52I0pIiF_041o-njvpvjc3UzrnzhMCW3T41IoVhllyHhA');
const TARGET = Address.parse('0QD7zcV7CJWCIPf728h3ill4hgCcQreptkVaaLJJGrMEh3Bb');

const NOW_SEC = 1_712_000_000;

const REGISTRY_CONFIG: RegistryConfigReply = {
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

function mkJob(overrides: Partial<JobData> = {}): JobData {
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
        owner: OTHER,
        balance: toNano('10'),
        lastExecutedAt: 0,
        isActive: true,
        ...overrides,
    };
}

interface FakeRuntimeOverrides {
    jobs?: Map<bigint, JobData>;
    activeCount?: bigint;
    mirror?: Address[];
    configError?: Error;
    jobCountError?: Error;
    jobFetchError?: (jobId: bigint) => Error | null;
    paused?: boolean;
}

function buildFakeRuntime(overrides: FakeRuntimeOverrides = {}): ChainRuntime {
    const jobs = overrides.jobs ?? new Map();
    const mirror = overrides.mirror ?? [ME];
    const activeCount = overrides.activeCount ?? BigInt(mirror.length);

    const registry = {
        getConfig: async () => {
            if (overrides.configError) throw overrides.configError;
            return REGISTRY_CONFIG;
        },
        getJobCount: async () => {
            if (overrides.jobCountError) throw overrides.jobCountError;
            return BigInt(jobs.size);
        },
        getIsPaused: async () => overrides.paused ?? false,
        getJob: async (jobId: bigint) => {
            if (overrides.jobFetchError) {
                const err = overrides.jobFetchError(jobId);
                if (err !== null) throw err;
            }
            return jobs.get(jobId) ?? null;
        },
        getActiveAutomatonCount: async () => activeCount,
        getAutomatonAt: async (i: number) => mirror[i] ?? null,
        sendExecute: async () => {
            throw new Error('sendExecute should be shortcircuited by submitExecute override');
        },
    };
    const pool = {
        getAutomatonCount: async () => activeCount,
        getIsPaused: async () => false,
    };
    return {
        client: {} as ChainRuntime['client'],
        deployment: { registry: OTHER, pool: ME },
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

describe('runWorkerCycle', () => {
    it('records decisions for every job and reports jobCount', async () => {
        const runtime = buildFakeRuntime({
            jobs: new Map([
                [0n, mkJob()],
                [1n, mkJob({ isActive: false })], // will be skip
            ]),
            mirror: [ME],
        });

        const result = await runWorkerCycle({
            runtime,
            wallet: fakeWallet(),
            mirror: new AutomatonMirror(runtime),
            inFlight: new Set(),
            nowSec: () => NOW_SEC,
            submitExecute: async () => {
                // no-op — we just want to see execute attempts
            },
        });

        expect(result.jobCount).toBe(2);
        expect(result.decisions).toHaveLength(2);
    });

    it('calls submitExecute for each execute decision', async () => {
        const runtime = buildFakeRuntime({
            jobs: new Map([
                [0n, mkJob()], // never-executed → execute
                [1n, mkJob()], // never-executed → execute
            ]),
            mirror: [ME],
        });

        const executed: bigint[] = [];
        const result = await runWorkerCycle({
            runtime,
            wallet: fakeWallet(),
            mirror: new AutomatonMirror(runtime),
            inFlight: new Set(),
            nowSec: () => NOW_SEC,
            submitExecute: async (_deps, _cfg, jobId) => {
                executed.push(jobId);
            },
        });

        expect(executed).toEqual([0n, 1n]);
        expect(result.executeSuccesses).toBe(2);
        expect(result.executeFailures).toBe(0);
    });

    it('skips jobs that are already in-flight (no double-submit)', async () => {
        const runtime = buildFakeRuntime({
            jobs: new Map([[0n, mkJob()]]),
            mirror: [ME],
        });

        let callCount = 0;
        const result = await runWorkerCycle({
            runtime,
            wallet: fakeWallet(),
            mirror: new AutomatonMirror(runtime),
            inFlight: new Set([0n]),
            nowSec: () => NOW_SEC,
            submitExecute: async () => {
                callCount++;
            },
        });

        expect(callCount).toBe(0);
        expect(result.executeSuccesses).toBe(0);
        expect(result.skippedInFlight).toBe(1);
    });

    it('releases the in-flight slot after execute failure', async () => {
        const runtime = buildFakeRuntime({
            jobs: new Map([[0n, mkJob()]]),
            mirror: [ME],
        });
        const inFlight = new Set<bigint>();

        const result = await runWorkerCycle({
            runtime,
            wallet: fakeWallet(),
            mirror: new AutomatonMirror(runtime),
            inFlight,
            nowSec: () => NOW_SEC,
            submitExecute: async () => {
                throw new Error('RPC timeout');
            },
        });

        expect(result.executeFailures).toBe(1);
        expect(inFlight.has(0n)).toBe(false);
    });

    it('counts a skip decision as skipped, not as an execute attempt', async () => {
        const runtime = buildFakeRuntime({
            jobs: new Map([[0n, mkJob({ isActive: false })]]),
            mirror: [ME],
        });

        const executed: bigint[] = [];
        const result = await runWorkerCycle({
            runtime,
            wallet: fakeWallet(),
            mirror: new AutomatonMirror(runtime),
            inFlight: new Set(),
            nowSec: () => NOW_SEC,
            submitExecute: async (_deps, _cfg, jobId) => {
                executed.push(jobId);
            },
        });

        expect(executed).toEqual([]);
        expect(result.skipped).toBe(1);
        expect(result.decisions[0]?.decision.reason).toBe('inactive');
    });

    it('returns cycleError when setup fails; no decisions submitted', async () => {
        const runtime = buildFakeRuntime({
            configError: new Error('RPC down'),
        });

        const result = await runWorkerCycle({
            runtime,
            wallet: fakeWallet(),
            mirror: new AutomatonMirror(runtime),
            inFlight: new Set(),
            nowSec: () => NOW_SEC,
            submitExecute: async () => {
                throw new Error('should not be called');
            },
        });

        expect(result.cycleError).not.toBeNull();
        expect(result.cycleError?.message).toMatch(/RPC down/);
        expect(result.decisions).toHaveLength(0);
    });

    it('tolerates per-job fetch errors and keeps processing the rest', async () => {
        const runtime = buildFakeRuntime({
            jobs: new Map([
                [0n, mkJob()],
                [1n, mkJob()],
                [2n, mkJob()],
            ]),
            mirror: [ME],
            jobFetchError: (id) => (id === 1n ? new Error('flaky rpc') : null),
        });

        const executed: bigint[] = [];
        const result = await runWorkerCycle({
            runtime,
            wallet: fakeWallet(),
            mirror: new AutomatonMirror(runtime),
            inFlight: new Set(),
            nowSec: () => NOW_SEC,
            submitExecute: async (_deps, _cfg, jobId) => {
                executed.push(jobId);
            },
        });

        expect(executed).toEqual([0n, 2n]);
        expect(result.jobCount).toBe(3);
        expect(result.decisions).toHaveLength(2); // job 1 skipped due to fetch error
    });

    it('skips the whole cycle when the registry is paused', async () => {
        const runtime = buildFakeRuntime({
            jobs: new Map([
                [0n, mkJob()],
                [1n, mkJob()],
            ]),
            mirror: [ME],
            paused: true,
        });

        const executed: bigint[] = [];
        const result = await runWorkerCycle({
            runtime,
            wallet: fakeWallet(),
            mirror: new AutomatonMirror(runtime),
            inFlight: new Set(),
            nowSec: () => NOW_SEC,
            submitExecute: async (_d, _c, id) => {
                executed.push(id);
            },
        });

        expect(executed).toEqual([]);
        expect(result.decisions).toHaveLength(0);
        expect(result.jobCount).toBe(2);
        expect(result.cycleError).toBeNull();
    });

    it('fires the in-flight-collision counter when a jobId is skipped for being in-flight', async () => {
        const runtime = buildFakeRuntime({
            jobs: new Map([[0n, mkJob()]]),
            mirror: [ME],
        });

        let collisions = 0;
        await runWorkerCycle({
            runtime,
            wallet: fakeWallet(),
            mirror: new AutomatonMirror(runtime),
            inFlight: new Set([0n]),
            nowSec: () => NOW_SEC,
            counters: {
                ...NOOP_COUNTERS_SHAPE,
                incrementInFlightCollision: () => {
                    collisions++;
                },
            },
            submitExecute: async () => {},
        });

        expect(collisions).toBe(1);
    });

    it('classifies a PoolRejectedError (generic internal-message revert) as "pool-rejected"', async () => {
        const runtime = buildFakeRuntime({
            jobs: new Map([[0n, mkJob()]]),
            mirror: [ME],
        });

        const classes: string[] = [];
        await runWorkerCycle({
            runtime,
            wallet: fakeWallet(),
            mirror: new AutomatonMirror(runtime),
            inFlight: new Set(),
            nowSec: () => NOW_SEC,
            counters: {
                ...NOOP_COUNTERS_SHAPE,
                incrementExecuteFailure: (_reason, errorClass) => {
                    classes.push(errorClass);
                },
            },
            submitExecute: async () => {
                // Real PoolRejectedError — classifyExecuteFailure checks
                // `instanceof`, not string-equality on `.name`, so a
                // minifier renaming the class can't silently break it.
                throw new PoolRejectedError(new Error('pool said no'), 'abc123');
            },
        });

        expect(classes).toEqual(['pool-rejected']);
    });

    it('classifies a PoolRejectedError WRAPPING a verify-callback throw as "verify-failed"', async () => {
        // Production path: defaultSubmitExecute's verify callback throws
        // Error("executionCount did not advance …"), sendAndConfirm catches +
        // wraps it in PoolRejectedError. Without unwrapping the reason, every
        // verify-failed reverted Execute would be misclassified as 'pool-rejected'.
        const runtime = buildFakeRuntime({
            jobs: new Map([[0n, mkJob()]]),
            mirror: [ME],
        });

        const classes: string[] = [];
        await runWorkerCycle({
            runtime,
            wallet: fakeWallet(),
            mirror: new AutomatonMirror(runtime),
            inFlight: new Set(),
            nowSec: () => NOW_SEC,
            counters: {
                ...NOOP_COUNTERS_SHAPE,
                incrementExecuteFailure: (_reason, errorClass) => {
                    classes.push(errorClass);
                },
            },
            submitExecute: async () => {
                throw new PoolRejectedError(
                    new Error('executionCount did not advance (pre=0, post=0) — Execute reverted'),
                    'abc123',
                );
            },
        });

        expect(classes).toEqual(['verify-failed']);
    });

    it('invokes the counters hook on every decision', async () => {
        const runtime = buildFakeRuntime({
            jobs: new Map([
                [0n, mkJob()], // execute
                [1n, mkJob({ isActive: false })], // skip
            ]),
            mirror: [ME],
        });

        const attempts: string[] = [];
        const successes: string[] = [];
        const skips: string[] = [];

        await runWorkerCycle({
            runtime,
            wallet: fakeWallet(),
            mirror: new AutomatonMirror(runtime),
            inFlight: new Set(),
            nowSec: () => NOW_SEC,
            counters: {
                ...NOOP_COUNTERS_SHAPE,
                incrementExecuteAttempt: (r) => attempts.push(r),
                incrementExecuteSuccess: (r) => successes.push(r),
                incrementSkip: (r) => skips.push(r),
            },
            submitExecute: async () => {},
        });

        expect(attempts).toEqual(['never-executed']);
        expect(successes).toEqual(['never-executed']);
        expect(skips).toEqual(['inactive']);
    });
});

describe('AutomatonMirror', () => {
    it('refreshes on first ensureFresh call', async () => {
        const runtime = buildFakeRuntime({
            mirror: [ME, OTHER],
        });
        const mirror = new AutomatonMirror(runtime);

        expect(mirror.snapshot).toHaveLength(0);
        await mirror.ensureFresh();
        expect(mirror.snapshot).toHaveLength(2);
        expect(mirror.activeCount).toBe(2n);
    });

    it('skips the per-slot refetch when count is unchanged', async () => {
        let slotFetches = 0;
        const registry = {
            getActiveAutomatonCount: async () => 2n,
            getAutomatonAt: async (i: number) => {
                slotFetches++;
                return [ME, OTHER][i] ?? null;
            },
        };
        const pool = { getAutomatonCount: async () => 2n };
        const runtime = {
            client: {} as ChainRuntime['client'],
            deployment: { registry: OTHER, pool: ME },
            registry: registry as unknown as ChainRuntime['registry'],
            pool: pool as unknown as ChainRuntime['pool'],
        } as ChainRuntime;
        const mirror = new AutomatonMirror(runtime);

        await mirror.ensureFresh();
        expect(slotFetches).toBe(2);

        await mirror.ensureFresh();
        // Count is still 2 and we have 2 addresses — no re-fetch.
        expect(slotFetches).toBe(2);
    });

    it('re-fetches when activeCount changes', async () => {
        let count = 2n;
        let slotFetches = 0;
        const registry = {
            getActiveAutomatonCount: async () => count,
            getAutomatonAt: async (i: number) => {
                slotFetches++;
                return [ME, OTHER, TARGET][i] ?? null;
            },
        };
        const pool = { getAutomatonCount: async () => count };
        const runtime = {
            client: {} as ChainRuntime['client'],
            deployment: { registry: OTHER, pool: ME },
            registry: registry as unknown as ChainRuntime['registry'],
            pool: pool as unknown as ChainRuntime['pool'],
        } as ChainRuntime;
        const mirror = new AutomatonMirror(runtime);

        await mirror.ensureFresh();
        expect(slotFetches).toBe(2);

        count = 3n;
        await mirror.ensureFresh();
        expect(slotFetches).toBe(5); // 2 + 3
        expect(mirror.snapshot).toHaveLength(3);
    });

    it('throws when the mirror is inconsistent (slot returns null)', async () => {
        const registry = {
            getActiveAutomatonCount: async () => 3n,
            getAutomatonAt: async (i: number) => (i < 2 ? [ME, OTHER][i]! : null),
        };
        const pool = { getAutomatonCount: async () => 3n };
        const runtime = {
            client: {} as ChainRuntime['client'],
            deployment: { registry: OTHER, pool: ME },
            registry: registry as unknown as ChainRuntime['registry'],
            pool: pool as unknown as ChainRuntime['pool'],
        } as ChainRuntime;
        const mirror = new AutomatonMirror(runtime);

        await expect(mirror.ensureFresh()).rejects.toThrow(/mirror inconsistent/);
    });

});
