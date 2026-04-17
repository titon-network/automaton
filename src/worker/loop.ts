// One iteration of the automaton's poll cycle.
//
// D.8 builds a single-shot `runWorkerCycle(deps)` that does one pass
// through the registry: ensure mirror is fresh, fetch config, iterate
// [0, jobCount), run `decide()` on each, and submit Execute for every
// "execute" decision. D.10 wraps this in `setInterval` + signal
// handling + lockfile to become the daemon.
//
// Single-flight: a Set<bigint> of jobIds currently submitting keeps a
// slow RPC round-trip from racing the next tick into a double-submit.
// The guard releases on both success AND failure (finally), so a
// persistently-failing job doesn't block its own retry forever.
//
// Metrics are no-op counters here; D.11 wires them to prom-client.

import { Address } from '@ton/core';
import type { JobData, RegistryConfigReply } from 'kronos-sdk';
import {
    AllEndpointsFailedError,
    ConfirmationTimeoutError,
    PoolRejectedError,
    TxAttributionError,
    sendAndConfirm,
    senderFor,
    type ChainRuntime,
} from '../chain';
import type { AutomatonWallet } from '../wallet';
import { AutomatonMirror } from './mirror';
import { decide, type Decision } from './decide';

// Bounded error-class tags — these become Prometheus labels, so
// cardinality must stay finite. Do NOT add raw RPC messages here.
export type ExecuteFailureClass =
    | 'rpc-timeout'
    | 'pool-rejected'
    | 'tx-attribution'
    | 'confirmation-timeout'
    | 'verify-failed'
    | 'other';

export interface WorkerCounters {
    incrementExecuteAttempt(reason: Decision['reason']): void;
    incrementExecuteSuccess(reason: Decision['reason']): void;
    /** `reason` is the decide-tree tag; `errorClass` is a bounded failure taxonomy. */
    incrementExecuteFailure(reason: Decision['reason'], errorClass: ExecuteFailureClass): void;
    incrementSkip(reason: Decision['reason']): void;
    incrementInFlightCollision(): void;
}

export const NOOP_COUNTERS: WorkerCounters = {
    incrementExecuteAttempt: () => {},
    incrementExecuteSuccess: () => {},
    incrementExecuteFailure: () => {},
    incrementSkip: () => {},
    incrementInFlightCollision: () => {},
};

export interface WorkerLogger {
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
}

export const SILENT_LOGGER: WorkerLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
};

export interface WorkerDeps {
    runtime: ChainRuntime;
    wallet: AutomatonWallet;
    mirror: AutomatonMirror;
    /** Tracks in-flight jobIds — one instance per worker process. */
    inFlight: Set<bigint>;
    counters?: WorkerCounters;
    logger?: WorkerLogger;
    /**
     * Injected clock (seconds since epoch). Tests override for deterministic
     * decisions against fixed job states.
     */
    nowSec?: () => number;
    /**
     * Execute submission — injected for tests so the decision path can be
     * exercised without a live sandbox. Production default does the real
     * `sendAndConfirm` + post-state verify (see defaultSubmitExecute).
     */
    submitExecute?: SubmitExecuteFn;
    /**
     * Max concurrent `getJob` round-trips per cycle. Default 4. Toncenter
     * public RPC rate-limits at ~1 req/s without an API key; pushing this
     * higher requires your own endpoint.
     */
    jobFetchConcurrency?: number;
}

export type SubmitExecuteFn = (
    deps: WorkerDeps,
    registryConfig: RegistryConfigReply,
    jobId: bigint,
    /** executionCount observed during `decide` — used to verify the post-send delta. */
    preExecutionCount: number,
) => Promise<void>;

export interface WorkerCycleResult {
    jobCount: number;
    decisions: Array<{ jobId: bigint; decision: Decision }>;
    executeSuccesses: number;
    executeFailures: number;
    skipped: number;
    skippedInFlight: number;
    /** Top-level failures (e.g. mirror refresh blew up) — nothing submitted. */
    cycleError: Error | null;
}

/** Run exactly one poll iteration. Safe to call on a timer. */
export async function runWorkerCycle(deps: WorkerDeps): Promise<WorkerCycleResult> {
    const counters = deps.counters ?? NOOP_COUNTERS;
    const logger = deps.logger ?? SILENT_LOGGER;
    const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));

    const result: WorkerCycleResult = {
        jobCount: 0,
        decisions: [],
        executeSuccesses: 0,
        executeFailures: 0,
        skipped: 0,
        skippedInFlight: 0,
        cycleError: null,
    };

    let registryConfig: RegistryConfigReply;
    let jobCount: bigint;
    let registryPaused: boolean;
    try {
        await deps.mirror.ensureFresh();
        [registryConfig, jobCount, registryPaused] = await Promise.all([
            deps.runtime.registry.getConfig(),
            deps.runtime.registry.getJobCount(),
            deps.runtime.registry.getIsPaused(),
        ]);
    } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        result.cycleError = e;
        logger.error('cycle-setup failed', { error: e.message });
        return result;
    }

    // Global pause: every Execute reverts with E_PAUSED. Don't burn gas + noise
    // retrying every job on every tick during emergency pause — skip the
    // whole cycle cleanly and let `automaton status` / logs surface the state.
    if (registryPaused) {
        logger.warn('registry is paused — skipping execute decisions this cycle');
        result.jobCount = Number(jobCount);
        return result;
    }

    result.jobCount = Number(jobCount);
    const mirror = deps.mirror.snapshot;
    const me = deps.wallet.address;
    const now = nowSec();

    // Fetch jobs with bounded concurrency. Fully-serial at N=50 with 100ms
    // round-trips costs 5s per cycle; unbounded parallelism floods rate-
    // limited RPC endpoints. 4 concurrent reads is a reasonable middle
    // ground — cycle time scales as N/4, toncenter's 1 req/s budget still
    // holds for small N. Configurable via `jobFetchConcurrency` if needed.
    const concurrency = deps.jobFetchConcurrency ?? 4;
    const jobs = await fetchJobsBounded(deps.runtime, jobCount, concurrency, logger);

    for (let i = 0n; i < jobCount; i++) {
        const jobId = i;
        const job = jobs.get(jobId);
        if (job === undefined) continue; // fetch-error already logged

        const decision = decide({ jobId, job, registryConfig, mirror, me, now });
        result.decisions.push({ jobId, decision });

        if (decision.action === 'skip') {
            result.skipped++;
            counters.incrementSkip(decision.reason);
            logger.debug(`job=${jobId} skip`, { reason: decision.reason, detail: decision.detail });
            continue;
        }

        if (deps.inFlight.has(jobId)) {
            result.skippedInFlight++;
            counters.incrementInFlightCollision();
            logger.debug(`job=${jobId} already in-flight, skipping this tick`);
            continue;
        }

        deps.inFlight.add(jobId);
        counters.incrementExecuteAttempt(decision.reason);
        const submit = deps.submitExecute ?? defaultSubmitExecute;
        try {
            await submit(deps, registryConfig, jobId, job.executionCount);
            result.executeSuccesses++;
            counters.incrementExecuteSuccess(decision.reason);
            logger.info(`job=${jobId} execute success`, { reason: decision.reason });
        } catch (err) {
            result.executeFailures++;
            const msg = err instanceof Error ? err.message : String(err);
            const errorClass = classifyExecuteFailure(err);
            counters.incrementExecuteFailure(decision.reason, errorClass);
            logger.warn(`job=${jobId} execute failed`, {
                reason: decision.reason,
                errorClass,
                error: msg,
            });
        } finally {
            deps.inFlight.delete(jobId);
        }
    }

    return result;
}

async function fetchJobsBounded(
    runtime: ChainRuntime,
    jobCount: bigint,
    concurrency: number,
    logger: WorkerLogger,
): Promise<Map<bigint, JobData>> {
    const result = new Map<bigint, JobData>();
    const ids: bigint[] = [];
    for (let i = 0n; i < jobCount; i++) ids.push(i);

    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
        while (true) {
            const idx = cursor++;
            if (idx >= ids.length) return;
            const jobId = ids[idx]!;
            const job = await safeFetchJob(runtime, jobId, logger);
            if (job !== null) result.set(jobId, job);
        }
    });
    await Promise.all(workers);
    return result;
}

function classifyExecuteFailure(err: unknown): ExecuteFailureClass {
    if (err instanceof PoolRejectedError) return 'pool-rejected';
    if (err instanceof TxAttributionError) return 'tx-attribution';
    if (err instanceof ConfirmationTimeoutError) return 'confirmation-timeout';
    if (err instanceof AllEndpointsFailedError) return 'rpc-timeout';
    if (
        err instanceof Error &&
        (err.message.includes('lastExecutedAt') || err.message.includes('executionCount'))
    ) {
        return 'verify-failed';
    }
    return 'other';
}

async function safeFetchJob(
    runtime: ChainRuntime,
    jobId: bigint,
    logger: WorkerLogger,
): Promise<JobData | null> {
    try {
        return await runtime.registry.getJob(jobId);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`job=${jobId} fetch failed`, { error: msg });
        return null;
    }
}

export const defaultSubmitExecute: SubmitExecuteFn = async (
    deps,
    config,
    jobId,
    preExecutionCount,
) => {
    const sender = senderFor(deps.runtime.client, deps.wallet);
    await sendAndConfirm(
        deps.runtime.client,
        deps.wallet,
        () => deps.runtime.registry.sendExecute(sender, { value: config.minGasReserve, jobId }),
        {
            verify: async () => {
                // Post-state verification via executionCount delta — the
                // registry bumps it atomically on accepted Execute, so
                // `post.executionCount > pre` is a clean, clock-free
                // proof the send wasn't reverted. A wall-clock comparison
                // against `lastExecutedAt` would false-flag on skewed
                // operator clocks (common on Raspberry Pi hosts).
                const post = await deps.runtime.registry.getJob(jobId);
                if (post === null) {
                    throw new Error(
                        `job vanished post-execute — likely cancelled or swept between our ` +
                            `send and verify read. Tx may have reverted before housekeeping ran.`,
                    );
                }
                if (post.executionCount <= preExecutionCount) {
                    throw new Error(
                        `executionCount did not advance (pre=${preExecutionCount}, ` +
                            `post=${post.executionCount}) — the internal Execute reverted ` +
                            `(likely E_NOT_ASSIGNED, E_JOB_NOT_DUE, or E_INSUFFICIENT_GAS).`,
                    );
                }
            },
        },
    );
};
