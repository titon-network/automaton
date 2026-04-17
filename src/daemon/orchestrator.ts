// `automaton run` — the long-lived daemon.
//
// Composition (in order, because each step depends on the previous):
//
//   1. Load config + keystore from disk (fail fast if either is absent).
//   2. Acquire the single-instance lockfile — second daemon exits here
//      with `EXIT_LOCK_HELD` (distinct from crash exit 1).
//   3. Unlock the wallet (password prompt, or AUTOMATON_PASSWORD env).
//   4. Build the chain runtime (FailoverTonClient + opened contracts).
//   5. Run the startup schema check — refuses to start if the deployed
//      contract shape doesn't match the SDK this binary was built with.
//   6. Load the event-subscriber checkpoint — resume from where we left
//      off, or from latest on first run.
//   7. Create metrics (prom-client) + wire the built-in event handlers
//      (mirror patch, self-slash alert + metric, consumer watch).
//   8. Start the health/metrics HTTP server so Prometheus scrapes are
//      served from cycle 1.
//   9. Install signal handlers: SIGTERM/SIGINT abort the loop, SIGHUP
//      logs + ignores (reload is deferred).
//  10. Run the timer loop until abort: drain events, snapshot state,
//      save checkpoint, run a worker cycle, update gauges, sleep.
//  11. On abort: wait up to `shutdownTimeoutMs` for in-flight Execute
//      txs to confirm, flush the checkpoint one more time, close the
//      HTTP server, exit clean.
//  12. Release the lockfile (finally, even on crash).
//
// Error discipline: any throw aborts the loop but is still wrapped in
// the `finally { releaseLock() }` so we never leak a stale lock on a
// daemon crash. Distinct exit codes: 0 = clean, 1 = crash,
// `EXIT_LOCK_HELD` = lock contention.

import { fromNano } from '@ton/core';
import { loadConfig } from '../config';
import { lockPath } from '../config/paths';
import {
    buildChainRuntime,
    checkSchemaVersions,
    acquireLock,
    collectChainSnapshot,
    describeLock,
    releaseLock,
    LockHeldError,
    type ChainRuntime,
} from '../chain';
import { getPassword, loadKeystore, unlockKeystore } from '../wallet';
import type { AutomatonWallet } from '../wallet';
import {
    AutomatonMirror,
    consumerWatchHandler,
    drainEvents,
    loadCheckpointState,
    mirrorPatchHandler,
    runWorkerCycle,
    saveCheckpointState,
    selfSlashHandler,
    type CheckpointState,
    type EventHandler,
    type WorkerCounters,
    type WorkerLogger,
} from '../worker';
import { createPinoLogger } from './logger';
import { loopCycles, waitForDrain } from './loop';
import { createDaemonMetrics, type DaemonMetrics } from './metrics';
import {
    startHealthServer,
    type HealthServer,
    type ReadinessCheck,
} from './http';

export interface RunDaemonOptions {
    logger?: WorkerLogger;
    /** Pre-built metrics — tests inject their own Registry to assert on. */
    metrics?: DaemonMetrics;
    /** Override the default counters (bypasses metrics). Usually unused. */
    counters?: WorkerCounters;
    /** Max time to wait for in-flight Execute txs to confirm on shutdown. */
    shutdownTimeoutMs?: number;
    /** Override bounded concurrency for per-job fetches. Default 4. */
    jobFetchConcurrency?: number;
    /** Suppress signal-handler installation — tests pass an AbortController instead. */
    externalAbort?: AbortSignal;
    /** Suppress HTTP server startup — tests that don't need endpoints. */
    skipHealthServer?: boolean;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

// Distinct exit code so systemd's `Restart=on-failure` can treat
// "another daemon is already running" differently from a crash.
// 75 = sysexits.h EX_TEMPFAIL (operator should wait / investigate).
export const EXIT_LOCK_HELD = 75;

/**
 * Mutable liveness + readiness state. Readers (HTTP handlers) see a
 * live view; writers (tick loop, startup sequencer) update fields as
 * state changes. Keeping this as a plain object — no events, no
 * reactivity — because there's exactly one writer per field.
 */
interface DaemonState {
    lastCycleCompletedAt: number;
    walletUnlocked: boolean;
    stakeActive: boolean;
    rpcReachable: boolean;
}

export async function runDaemon(options: RunDaemonOptions = {}): Promise<number> {
    const config = loadConfig();
    const keystore = loadKeystore();

    // Logger level resolution: explicit options.logger > config.logLevel
    // > 'info' default. CLI `--log-level` folds into options.logger.
    const logger = options.logger ?? createPinoLogger({ level: config.logLevel });
    const metrics = options.metrics ?? createDaemonMetrics();
    const counters = options.counters ?? metrics.counters;

    logger.info('loaded config + keystore', {
        network: config.network,
        address: keystore.address,
    });

    let lockInfo;
    try {
        lockInfo = acquireLock();
    } catch (err) {
        if (err instanceof LockHeldError) {
            logger.error('another automaton daemon is already running', {
                pid: err.info.pid,
                startedAt: err.info.startedAt,
                path: err.path,
            });
            return EXIT_LOCK_HELD;
        }
        throw err;
    }
    logger.info('acquired lockfile', { path: lockPath(), pid: lockInfo.pid });

    const state: DaemonState = {
        lastCycleCompletedAt: 0,
        walletUnlocked: false,
        stakeActive: false,
        rpcReachable: false,
    };

    let exitCode = 0;
    const ac = new AbortController();
    const installedSignals: Array<[NodeJS.Signals, NodeJS.SignalsListener]> = [];
    let healthServer: HealthServer | undefined;

    try {
        const password = await getPassword({ prompt: 'Keystore password: ' });
        const wallet = await unlockKeystore(keystore, password);
        state.walletUnlocked = true;
        logger.info('wallet unlocked');

        const runtime = buildChainRuntime(config);
        logger.info('chain runtime built', {
            endpoint: runtime.client.currentEndpoint,
            registry: runtime.deployment.registry.toString(),
            pool: runtime.deployment.pool.toString(),
        });

        await checkSchemaVersions({
            client: runtime.client,
            registry: runtime.deployment.registry,
            pool: runtime.deployment.pool,
        });
        logger.info('on-chain schema versions match SDK constants');

        let checkpointState = loadCheckpointState();

        const mirror = new AutomatonMirror(runtime);
        const inFlight = new Set<bigint>();
        const handlers: EventHandler[] = buildHandlers(
            wallet,
            mirror,
            config.alertWebhookUrl,
            logger,
            metrics,
        );

        if (!options.skipHealthServer) {
            healthServer = await startHealthServer({
                port: config.metricsPort,
                host: config.metricsHost,
                registry: metrics.registry,
                liveness: () => ({
                    lastCycleCompletedAt: state.lastCycleCompletedAt,
                    pollIntervalMs: config.pollIntervalMs,
                }),
                readiness: () => readinessChecks(state),
                logger,
            });
        }

        if (options.externalAbort === undefined) {
            installSignalHandlers(ac, logger, installedSignals);
        } else {
            options.externalAbort.addEventListener('abort', () => ac.abort(), { once: true });
        }

        logger.info('daemon starting main loop', {
            pollIntervalMs: config.pollIntervalMs,
            metricsPort: config.metricsPort,
        });

        // Gauge snapshot cadence: operator state (balance / stake /
        // drift) changes slowly relative to the main poll interval, so
        // we refresh it every Nth tick instead of every tick. Keeps
        // toncenter public scrapes inside their 1 req/s budget while
        // still giving Grafana a meaningful data rate.
        let tickCount = 0;
        const gaugeEvery = Math.max(1, config.gaugeSnapshotEveryNTicks);

        await loopCycles({
            signal: ac.signal,
            intervalMs: config.pollIntervalMs,
            logger,
            onTick: async () => {
                const stopTimer = metrics.cycleDuration.startTimer();
                try {
                    checkpointState = await tickOnce({
                        runtime,
                        wallet,
                        mirror,
                        inFlight,
                        handlers,
                        counters,
                        metrics,
                        logger,
                        checkpointState,
                        jobFetchConcurrency: options.jobFetchConcurrency,
                    });
                    if (tickCount % gaugeEvery === 0) {
                        await snapshotGauges(runtime, wallet, metrics, state, logger);
                    }
                    tickCount++;
                    state.rpcReachable = true;
                    state.lastCycleCompletedAt = Math.floor(Date.now() / 1000);
                    metrics.gauges.lastCycleCompletedAt.set(state.lastCycleCompletedAt);
                } catch (err) {
                    state.rpcReachable = false;
                    throw err; // loopCycles logs + backs off
                } finally {
                    stopTimer();
                }
            },
        });

        logger.info('shutdown signal — waiting for in-flight txs to drain');
        await waitForDrain({
            isDrained: () => inFlight.size === 0,
            timeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
            logger,
            label: 'in-flight tx drain',
        });

        saveCheckpointState(checkpointState);
        logger.info('checkpoint flushed; exit 0');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('daemon crashed', { error: msg });
        exitCode = 1;
    } finally {
        for (const [sig, h] of installedSignals) process.off(sig, h);
        if (healthServer !== undefined) {
            try {
                await healthServer.close();
                logger.info('health server closed');
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.error('health server close failed', { error: msg });
            }
        }
        try {
            releaseLock();
            logger.info('lockfile released');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error('lockfile release failed', { error: msg });
        }
    }

    return exitCode;
}

/**
 * Inputs to `tickOnce` — exported so D.15 sandbox tests can call
 * individual ticks without spinning up signal handlers + lockfile +
 * loopCycles.
 */
export interface TickDeps {
    runtime: ChainRuntime;
    wallet: AutomatonWallet;
    mirror: AutomatonMirror;
    inFlight: Set<bigint>;
    handlers: readonly EventHandler[];
    counters: WorkerCounters;
    /** Optional: when supplied, `drainDispatched` + `drainCapped` counters are incremented. */
    metrics?: DaemonMetrics;
    logger: WorkerLogger;
    checkpointState: CheckpointState;
    jobFetchConcurrency: number | undefined;
}

/**
 * Run one daemon tick: drain events → (maybe) persist checkpoint →
 * run worker cycle. Returns the updated checkpoint state. Pure in the
 * sense that no signal handlers or lockfile are touched; callers can
 * exercise it directly in sandbox tests.
 */
export async function tickOnce(deps: TickDeps): Promise<CheckpointState> {
    // Events first — handler `onCycleEnd` (e.g. mirror refresh) must
    // settle before `decide` runs against the mirror snapshot.
    const drain = await drainEvents({
        runtime: deps.runtime,
        state: deps.checkpointState,
        handlers: deps.handlers,
        logger: deps.logger,
    });
    const nextState = drain.state;

    // Feed drain results into metrics. `dispatched` is per-source so the
    // counter label stays bounded (2 series) regardless of how many
    // event kinds landed in this batch.
    if (deps.metrics !== undefined) {
        if (drain.dispatched.registry > 0) {
            deps.metrics.gauges.drainDispatched.inc(
                { source: 'registry', kind: 'all' },
                drain.dispatched.registry,
            );
        }
        if (drain.dispatched.pool > 0) {
            deps.metrics.gauges.drainDispatched.inc(
                { source: 'pool', kind: 'all' },
                drain.dispatched.pool,
            );
        }
        if (!drain.fullyCaughtUp.registry) {
            deps.metrics.gauges.drainCapped.inc({ source: 'registry' });
        }
        if (!drain.fullyCaughtUp.pool) {
            deps.metrics.gauges.drainCapped.inc({ source: 'pool' });
        }
    }

    if (drain.dispatched.registry + drain.dispatched.pool > 0) {
        saveCheckpointState(nextState);
        deps.logger.debug('checkpoint advanced', {
            registry: drain.dispatched.registry,
            pool: drain.dispatched.pool,
        });
    }

    const cycle = await runWorkerCycle({
        runtime: deps.runtime,
        wallet: deps.wallet,
        mirror: deps.mirror,
        inFlight: deps.inFlight,
        counters: deps.counters,
        logger: deps.logger,
        jobFetchConcurrency: deps.jobFetchConcurrency,
    });
    deps.logger.debug('cycle complete', {
        jobs: cycle.jobCount,
        decisions: cycle.decisions.length,
        success: cycle.executeSuccesses,
        failed: cycle.executeFailures,
        skipped: cycle.skipped,
        skippedInFlight: cycle.skippedInFlight,
    });

    return nextState;
}

async function snapshotGauges(
    runtime: ChainRuntime,
    wallet: AutomatonWallet,
    metrics: DaemonMetrics,
    state: DaemonState,
    logger: WorkerLogger,
): Promise<void> {
    // Shared helper — same reads `automaton status` uses. Skip the
    // preflight probe (we're called right after tickOnce, which already
    // proved the RPC is reachable) and schema fields (checked once at
    // startup).
    const snap = await collectChainSnapshot(runtime, wallet.address, {
        includeSchema: false,
        preflightProbe: false,
    });

    if (snap.balance !== undefined) {
        metrics.gauges.walletBalance.set(Number(fromNano(snap.balance)));
    }
    if (snap.automaton !== undefined) {
        if (snap.automaton === null) {
            // null means "not registered yet" — daemon can still run
            // (first-run executes are permissionless). /readyz reflects
            // the unstaked state so operators know to register.
            metrics.gauges.automatonActive.set(0);
            state.stakeActive = false;
        } else {
            const info = snap.automaton;
            metrics.gauges.automatonStake.set(Number(fromNano(info.stake)));
            metrics.gauges.automatonActive.set(info.isActive ? 1 : 0);
            metrics.gauges.automatonSlashCount.set(info.slashCount);
            state.stakeActive = info.isActive;
        }
    }
    if (snap.activeAutomatonCount !== undefined) {
        metrics.gauges.activeAutomatonCount.set(Number(snap.activeAutomatonCount));
    }
    if (snap.syncesReceived !== undefined) {
        metrics.gauges.syncesReceived.set(Number(snap.syncesReceived));
    }
    if (snap.slashesRequested !== undefined) {
        metrics.gauges.slashesRequested.set(Number(snap.slashesRequested));
    }
    if (snap.errors.length > 0) {
        logger.debug('gauge snapshot partial', { errors: snap.errors });
    }
}

function readinessChecks(state: DaemonState): ReadinessCheck[] {
    const desc = describeLock();
    return [
        {
            name: 'lockfile-held',
            ok: desc.kind === 'held-by-us',
            detail: desc.detail,
        },
        {
            name: 'wallet-unlocked',
            ok: state.walletUnlocked,
            detail: state.walletUnlocked ? 'ok' : 'wallet has not been unlocked yet',
        },
        {
            name: 'stake-active',
            ok: state.stakeActive,
            detail: state.stakeActive
                ? 'ok'
                : 'not registered or inactive in the pool — run `automaton stake register`',
        },
        {
            name: 'rpc-reachable',
            ok: state.rpcReachable,
            detail: state.rpcReachable ? 'ok' : 'last cycle did not complete successfully',
        },
    ];
}

function buildHandlers(
    wallet: AutomatonWallet,
    mirror: AutomatonMirror,
    webhookUrl: string | undefined,
    logger: WorkerLogger,
    metrics: DaemonMetrics,
): EventHandler[] {
    return [
        mirrorPatchHandler(mirror, logger),
        selfSlashHandler({
            me: wallet.address,
            logger,
            webhookUrl,
            onSelfSlash: () => metrics.gauges.selfSlashCount.inc(),
        }),
        consumerWatchHandler(logger),
    ];
}

function installSignalHandlers(
    ac: AbortController,
    logger: WorkerLogger,
    track: Array<[NodeJS.Signals, NodeJS.SignalsListener]>,
): void {
    const onStop = (sig: string): void => {
        if (ac.signal.aborted) {
            logger.warn(`received second ${sig} — force-exiting (in-flight txs abandoned)`);
            process.exit(130);
        }
        logger.info(`received ${sig} — initiating graceful shutdown`);
        ac.abort();
    };
    const onHup: NodeJS.SignalsListener = () => {
        logger.warn('SIGHUP received — config reload not yet implemented; send SIGTERM to restart');
    };
    const termH: NodeJS.SignalsListener = () => onStop('SIGTERM');
    const intH: NodeJS.SignalsListener = () => onStop('SIGINT');

    process.on('SIGTERM', termH);
    process.on('SIGINT', intH);
    process.on('SIGHUP', onHup);
    track.push(['SIGTERM', termH], ['SIGINT', intH], ['SIGHUP', onHup]);
}
