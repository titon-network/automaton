// `automaton run` — the long-lived daemon.
//
// Composition (in order, because each step depends on the previous):
//
//   1. Load config + keystore from disk (fail fast if either is absent).
//   2. Acquire the single-instance lockfile — second daemon exits here
//      with LockHeldError.
//   3. Unlock the wallet (password prompt, or AUTOMATON_PASSWORD env).
//   4. Build the chain runtime (FailoverTonClient + opened contracts).
//   5. Run the startup schema check — refuses to start if the deployed
//      contract shape doesn't match the SDK this binary was built with.
//   6. Load the event-subscriber checkpoint — resume from where we left
//      off, or from latest on first run.
//   7. Wire the built-in event handlers (mirror patch, self-slash alert,
//      consumer watch).
//   8. Install signal handlers: SIGTERM/SIGINT abort the loop, SIGHUP
//      logs + ignores (reload is D.11+ scope).
//   9. Run the timer loop until abort: drain events, save checkpoint,
//      run a worker cycle, sleep pollIntervalMs.
//  10. On abort: wait up to `shutdownTimeoutMs` for in-flight Execute
//      txs to confirm, flush the checkpoint one more time, exit clean.
//  11. Release the lockfile (finally, even on crash).
//
// Error discipline: any throw aborts the loop but is still wrapped in
// the `finally { releaseLock() }` so we never leak a stale lock on a
// daemon crash. The process exits 1 on error, 0 on clean shutdown.
//
// Tested manually against testnet; the individual primitives have unit
// tests. Full end-to-end sandbox coverage lands in D.15.

import { loadConfig } from '../config';
import { lockPath } from '../config/paths';
import {
    buildChainRuntime,
    checkSchemaVersions,
    acquireLock,
    releaseLock,
    LockHeldError,
    type ChainRuntime,
} from '../chain';
import { getPassword, loadKeystore, unlockKeystore } from '../wallet';
import type { AutomatonWallet } from '../wallet';
import {
    AutomatonMirror,
    NOOP_COUNTERS,
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
import { createConsoleLogger } from './logger';
import { loopCycles, waitForDrain } from './loop';

export interface RunDaemonOptions {
    logger?: WorkerLogger;
    counters?: WorkerCounters;
    /** Max time to wait for in-flight Execute txs to confirm on shutdown. */
    shutdownTimeoutMs?: number;
    /** Override bounded concurrency for per-job fetches. Default 4. */
    jobFetchConcurrency?: number;
    /** Suppress signal-handler installation — tests pass an AbortController instead. */
    externalAbort?: AbortSignal;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

// Distinct exit code so systemd's `Restart=on-failure` can treat
// "another daemon is already running" differently from a crash.
// 75 = sysexits.h EX_TEMPFAIL (operator should wait / investigate).
export const EXIT_LOCK_HELD = 75;

export async function runDaemon(options: RunDaemonOptions = {}): Promise<number> {
    const config = loadConfig();
    const keystore = loadKeystore();

    // Logger level resolution precedence:
    //   explicit options.logger > config.logLevel > 'info' default.
    // The `--log-level` CLI flag is already folded into options.logger
    // by `run.ts` when set.
    const logger = options.logger ?? createConsoleLogger({ level: config.logLevel });
    const counters = options.counters ?? NOOP_COUNTERS;

    logger.info('loaded config + keystore', {
        network: config.network,
        address: keystore.address,
    });

    // Acquire BEFORE the password prompt — we don't want the operator to
    // type their passphrase only to learn another daemon is already
    // running. Lock contention is distinct from a crash: callers use
    // the returned exit code to distinguish.
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

    let exitCode = 0;
    const ac = new AbortController();
    const installedSignals: Array<[NodeJS.Signals, NodeJS.SignalsListener]> = [];

    try {
        const password = await getPassword({ prompt: 'Keystore password: ' });
        const wallet = await unlockKeystore(keystore, password);
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
        const handlers: EventHandler[] = buildHandlers(wallet, mirror, config.alertWebhookUrl, logger);

        // Install signal handlers unless the caller provided their own
        // abort signal (tests do).
        if (options.externalAbort === undefined) {
            installSignalHandlers(ac, logger, installedSignals);
        } else {
            // Forward the external abort to our internal controller so the
            // loop + drain use one consistent signal surface.
            options.externalAbort.addEventListener('abort', () => ac.abort(), { once: true });
        }

        logger.info('daemon starting main loop', {
            pollIntervalMs: config.pollIntervalMs,
            metricsPort: config.metricsPort,
        });

        await loopCycles({
            signal: ac.signal,
            intervalMs: config.pollIntervalMs,
            logger,
            onTick: async () => {
                checkpointState = await tickOnce({
                    runtime,
                    wallet,
                    mirror,
                    inFlight,
                    handlers,
                    counters,
                    logger,
                    checkpointState,
                    jobFetchConcurrency: options.jobFetchConcurrency,
                });
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
    let nextState = drain.state;
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

function buildHandlers(
    wallet: AutomatonWallet,
    mirror: AutomatonMirror,
    webhookUrl: string | undefined,
    logger: WorkerLogger,
): EventHandler[] {
    return [
        mirrorPatchHandler(mirror, logger),
        selfSlashHandler({ me: wallet.address, logger, webhookUrl }),
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
            // Operator hammering the signal — hard-exit with 130
            // (conventional SIGINT exit code) rather than leave them
            // waiting on the drain. Ordinary systemd SIGTERM won't hit
            // this path because systemd won't re-send; interactive
            // Ctrl-C will.
            logger.warn(`received second ${sig} — force-exiting (in-flight txs abandoned)`);
            process.exit(130);
        }
        logger.info(`received ${sig} — initiating graceful shutdown`);
        ac.abort();
    };
    const onHup: NodeJS.SignalsListener = () => {
        // Full config reload without restart is on the D.11+ roadmap.
        // For now log loudly so operators know to send SIGTERM + let
        // systemd's restart-on-exit pick up the new config.
        logger.warn('SIGHUP received — config reload not yet implemented; send SIGTERM to restart');
    };
    const termH: NodeJS.SignalsListener = () => onStop('SIGTERM');
    const intH: NodeJS.SignalsListener = () => onStop('SIGINT');

    process.on('SIGTERM', termH);
    process.on('SIGINT', intH);
    process.on('SIGHUP', onHup);
    track.push(['SIGTERM', termH], ['SIGINT', intH], ['SIGHUP', onHup]);
}
