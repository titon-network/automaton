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
    baselineEventSources,
    consumerWatchHandler,
    drainEvents,
    forgetonAwarenessHandler,
    forgetonHealthHandler,
    loadCheckpointState,
    saveCheckpointState,
    selfSlashHandler,
    type CheckpointState,
    type EventHandler,
    type EventSource,
    type WorkerLogger,
} from '../worker';
import { enabledProducts } from '../products';
import type { ProductWorker } from '../products/types';
import { createPinoLogger, type LogFormat } from './logger';
import type { LogLevel } from '../config/schema';
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
    /** Max time to wait for in-flight Execute txs to confirm on shutdown. */
    shutdownTimeoutMs?: number;
    /**
     * @internal
     * Suppress signal-handler + uncaught-exception handler installation;
     * tests drive shutdown via their own AbortController instead. Production
     * always installs the signal handlers — do not pass this from CLI code.
     */
    externalAbort?: AbortSignal;
    /**
     * @internal
     * Suppress HTTP server startup — for tests that exercise the loop
     * without binding a metricsPort. Production always starts the server.
     */
    skipHealthServer?: boolean;
    /** Override config.logLevel when building the default logger. Ignored if `logger` is passed. */
    logLevel?: LogLevel;
    /** Pick json / pretty / auto for the default logger. Ignored if `logger` is passed. */
    logFormat?: LogFormat;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

// Distinct exit code so systemd's `Restart=on-failure` can treat
// "another daemon is already running" differently from a crash.
// 75 = sysexits.h EX_TEMPFAIL (operator should wait / investigate).
export const EXIT_LOCK_HELD = 75;

/**
 * Mutable liveness + readiness state. Readers (HTTP handlers) see a
 * live view; writers update fields as state changes. Keeping this as a
 * plain object — no events, no reactivity — because each field has
 * exactly one logical writer:
 *   - walletUnlocked    → startup sequencer (set once, stays true)
 *   - lastCycleCompletedAt → tick onTick success path
 *   - rpcReachable      → tick onTick finally (true on success, false on throw)
 *   - stakeActive       → snapshotGauges inside the tick
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

    // Logger resolution: explicit options.logger > constructed from flags.
    //   level  ← options.logLevel  ?? config.logLevel
    //   format ← options.logFormat ?? 'auto' (pretty on TTY, json otherwise)
    const logger =
        options.logger ??
        createPinoLogger({
            level: options.logLevel ?? config.logLevel,
            ...(options.logFormat !== undefined ? { format: options.logFormat } : {}),
        });
    const metrics = options.metrics ?? createDaemonMetrics();

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
    const installedProcessHandlers: Array<[string, (arg: unknown) => void]> = [];
    let healthServer: HealthServer | undefined;
    // Hoisted out of the try block so the finally can iterate workers
    // for dispose() (e.g. multi-op FortunaWorker closes its
    // share-exchange server here).
    let productWorkers: Record<string, ProductWorker> = {};

    // Uncaught exceptions + unhandled rejections must not crash a long-
    // running daemon silently. We log them via the pino logger (so the
    // redaction discipline applies) and signal the loop to exit
    // cleanly. systemd's Restart=on-failure picks up the exit code 1
    // and respawns.
    if (options.externalAbort === undefined) {
        installProcessErrorHandlers(ac, logger, installedProcessHandlers);
    }

    try {
        const password = await getPassword({ prompt: 'Keystore password: ' });
        const wallet = await unlockKeystore(keystore, password);
        state.walletUnlocked = true;
        logger.info('wallet unlocked');

        const runtime = buildChainRuntime(config);
        logger.info('chain runtime built', {
            endpoint: runtime.client.currentEndpoint,
            pool: runtime.deployment.pool.toString(),
            products: Object.keys(runtime.products),
        });

        await checkSchemaVersions({
            config,
            client: runtime.client,
            deployment: runtime.deployment,
            runtime,
        });
        logger.info('on-chain schema versions match SDK constants');

        let checkpointState = loadCheckpointState();

        const handlers: EventHandler[] = buildHandlers(
            wallet,
            config.alertWebhookUrl,
            logger,
            metrics,
        );

        // Per-product bootstrap. Each enabled ProductModule:
        //   1. (optionally) bootstraps a worker — FortunaWorker today
        //      and any future Phoebe / Argus equivalent.
        //   2. Contributes built-in handlers (config invalidator, awareness,
        //      protocol-health log) — composed alongside the baseline ones.
        //   3. Contributes event streams — drained per tick alongside
        //      the baseline registry+pool streams.
        // Iteration order = registration order in PRODUCTS, so
        // explainExitCode hint priority + handler dispatch sequence are
        // both deterministic.
        productWorkers = {};
        const productSources: EventSource[] = [];
        for (const product of enabledProducts(config)) {
            const addresses = runtime.deployment.products[product.name] ?? {};
            const contracts = runtime.products[product.name] ?? {};
            const worker = await product.bootstrapWorker?.({
                config,
                wallet,
                walletPassword: password,
                client: runtime.client,
                addresses,
                contracts,
                logger,
                metrics,
            });
            if (worker !== undefined) {
                productWorkers[product.name] = worker;
                handlers.push(worker.eventHandler());
            }
            handlers.push(
                ...product.buildHandlers({
                    config,
                    client: runtime.client,
                    wallet,
                    walletPassword: password,
                    addresses,
                    contracts,
                    worker,
                    logger,
                    metrics,
                }),
            );
            productSources.push(...product.eventStreams({ client: runtime.client, addresses, contracts }));
        }
        const sources: readonly EventSource[] = [
            ...baselineEventSources(runtime),
            ...productSources,
        ];

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
                let tickOk = false;
                try {
                    checkpointState = await tickOnce({
                        runtime,
                        wallet,
                        handlers,
                        sources,
                        metrics,
                        logger,
                        checkpointState,
                        productWorkers,
                    });
                    if (tickCount % gaugeEvery === 0) {
                        await snapshotGauges(runtime, wallet, metrics, state, logger);
                    }
                    tickCount++;
                    state.lastCycleCompletedAt = Math.floor(Date.now() / 1000);
                    metrics.gauges.lastCycleCompletedAt.set(state.lastCycleCompletedAt);
                    tickOk = true;
                } finally {
                    // Single write site for rpcReachable — success path sets
                    // it true before the try block's last statement; any throw
                    // bypasses that and the finally writes false. loopCycles
                    // observes the rethrown error and applies backoff.
                    state.rpcReachable = tickOk;
                    stopTimer();
                }
            },
        });

        logger.info('shutdown signal — waiting for in-flight txs to drain');
        await waitForDrain({
            isDrained: () =>
                Object.values(productWorkers).every((w) => !w.hasInFlight()),
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
        for (const [event, h] of installedProcessHandlers) {
            process.off(event as 'uncaughtException' | 'unhandledRejection', h);
        }
        if (healthServer !== undefined) {
            await safeCleanup('health server close', logger, () => healthServer!.close());
        }
        // Per-product cleanup. Today only the multi-op FortunaWorker uses
        // dispose() (closes its share-exchange server). Future products
        // (Phoebe / Argus) plug in here automatically via the
        // `ProductWorker.dispose?()` interface.
        for (const [name, w] of Object.entries(productWorkers)) {
            if (w.dispose !== undefined) {
                await safeCleanup(`${name} worker dispose`, logger, () => w.dispose!());
            }
        }
        await safeCleanup('lockfile release', logger, () => {
            releaseLock();
        });
    }

    return exitCode;
}

/** Run a cleanup function in the finally chain, logging success/failure
 *  but never throwing. Single shape so health-server / lockfile / future
 *  cleanups all surface uniformly. */
async function safeCleanup(label: string, logger: WorkerLogger, fn: () => unknown | Promise<unknown>): Promise<void> {
    try {
        await fn();
        logger.info(`${label}: ok`);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`${label}: failed`, { error: msg });
    }
}

/**
 * Inputs to `tickOnce` — exported so sandbox integration tests can call
 * individual ticks without spinning up signal handlers + lockfile +
 * loopCycles.
 */
export interface TickDeps {
    runtime: ChainRuntime;
    wallet: AutomatonWallet;
    handlers: readonly EventHandler[];
    /** Event streams to drain. Baseline (pool) + per-product. */
    sources: readonly EventSource[];
    /** Optional: when supplied, `drainDispatched` + `drainCapped` counters are incremented. */
    metrics?: DaemonMetrics;
    logger: WorkerLogger;
    checkpointState: CheckpointState;
    /**
     * Per-product workers, keyed by ProductModule.name. Each worker's
     * `tick()` runs once per cycle; `hasInFlight()` gates the shutdown
     * drain. Empty `{}` when no products are enabled. Production
     * constructs these via `ProductModule.bootstrapWorker`; tests
     * (sandbox harness) construct them directly with override deps
     * (`submitExecute`, `nowSec`, etc).
     */
    productWorkers?: Record<string, ProductWorker>;
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
        sources: deps.sources,
        handlers: deps.handlers,
        logger: deps.logger,
    });
    const nextState = drain.state;

    // Feed drain results into metrics. `dispatched` is per-source so the
    // counter stays at a small, bounded set of series regardless of how
    // many event kinds landed in this batch. Source set is data-driven
    // (baseline + per-product) — iterate the keys we got back rather
    // than enumerating known products here.
    let totalDispatched = 0;
    if (deps.metrics !== undefined) {
        for (const [source, count] of Object.entries(drain.dispatched)) {
            if (count > 0) {
                deps.metrics.eventCounters.drainDispatched.inc({ source }, count);
            }
            totalDispatched += count;
        }
        for (const [source, caughtUp] of Object.entries(drain.fullyCaughtUp)) {
            if (!caughtUp) {
                deps.metrics.eventCounters.drainCapped.inc({ source });
            }
        }
    } else {
        for (const count of Object.values(drain.dispatched)) totalDispatched += count;
    }

    if (totalDispatched > 0) {
        saveCheckpointState(nextState);
        deps.logger.debug('checkpoint advanced', { dispatched: drain.dispatched });
    }

    // Per-product worker cycles. Every enabled product (kronos, fortuna,
    // future phoebe / argus) runs independently — a Kronos miss doesn't
    // block a Fortuna fulfillment and vice versa. Adding a new product
    // worker just registers via ProductModule.bootstrapWorker — no
    // orchestrator change needed.
    for (const [name, worker] of Object.entries(deps.productWorkers ?? {})) {
        if (worker.tick !== undefined) {
            const result = await worker.tick();
            deps.logger.debug(`${name} cycle complete`, {
                ...(typeof result === 'object' && result !== null ? result : {}),
            });
        }
        // Each worker self-publishes its gauges to the shared metrics
        // registry — keeps product-specific names out of core.
        if (deps.metrics !== undefined) {
            worker.publishMetrics?.(deps.metrics);
        }
    }

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
    if (snap.jobCount !== undefined) {
        metrics.gauges.jobCount.set(Number(snap.jobCount));
    }
    if (snap.accumulatedFees !== undefined) {
        metrics.gauges.accumulatedFees.set(Number(fromNano(snap.accumulatedFees)));
    }
    if (snap.isPaused !== undefined) {
        metrics.gauges.registryPaused.set(snap.isPaused ? 1 : 0);
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
    webhookUrl: string | undefined,
    logger: WorkerLogger,
    metrics: DaemonMetrics,
): EventHandler[] {
    // BASELINE handlers — ForgeTON-only events that every operator cares
    // about regardless of which products are enabled. Per-product handlers
    // (kronos mirror patch + AssignedAutomatonMissed awareness, fortuna
    // config invalidator, future phoebe / argus equivalents) are contributed
    // via ProductModule.buildHandlers.
    return [
        // Self-slash alert (pool) — webhook + dedicated counter.
        selfSlashHandler({
            me: wallet.address,
            logger,
            webhookUrl,
            onSelfSlash: () => metrics.eventCounters.selfSlash.inc(),
        }),
        // Consumer set changes (pool) — informational log.
        consumerWatchHandler(logger),
        // ForgeTON events that name THIS automaton (stake lifecycle,
        // opt-in, prune, forceSync, pool pause flips).
        forgetonAwarenessHandler(wallet.address, logger),
        // ForgeTON protocol-health log (pool config / consumer cap /
        // upgrade lifecycle).
        forgetonHealthHandler(logger),
    ];
}

function installProcessErrorHandlers(
    ac: AbortController,
    logger: WorkerLogger,
    track: Array<[string, (arg: unknown) => void]>,
): void {
    const make = (event: 'uncaughtException' | 'unhandledRejection') => (cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        const stack = cause instanceof Error ? cause.stack : undefined;
        logger.error(`${event} — initiating graceful shutdown`, { error: message, stack });
        if (!ac.signal.aborted) ac.abort();
    };
    for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
        const handler = make(event);
        process.on(event, handler);
        track.push([event, handler]);
    }
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
