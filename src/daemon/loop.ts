// Small cancellable primitives the orchestrator uses to run the main
// poll loop and drain in-flight work on shutdown. Kept pure (no chain,
// no side channels) so unit tests exercise them with real timers +
// AbortControllers — no mocks required.

import type { WorkerLogger } from '../observability';

/**
 * Sleep for `ms` milliseconds. Rejects with an AbortError if the signal
 * fires first. Unlike a bare `setTimeout`, this cleans up the timer on
 * abort so a shutdown during a long idle doesn't leak a handle.
 */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new AbortError());
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(new AbortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

export class AbortError extends Error {
    constructor() {
        super('aborted');
        this.name = 'AbortError';
    }
}

export function isAbortError(err: unknown): err is AbortError {
    return err instanceof Error && err.name === 'AbortError';
}

export interface LoopCyclesOptions {
    signal: AbortSignal;
    intervalMs: number;
    logger: WorkerLogger;
    /** Runs once per tick. Thrown errors are logged and the loop continues — one bad tick must not bring the daemon down. */
    onTick: () => Promise<void>;
    /** Called once before the first tick. Throwing here aborts startup cleanly. */
    onStart?: () => Promise<void>;
    /** Max backoff delay applied after consecutive tick failures. Default 60s. */
    maxBackoffMs?: number;
}

const DEFAULT_MAX_BACKOFF_MS = 60_000;

/**
 * Run `onTick` in a loop, sleeping `intervalMs` between iterations, until
 * `signal` aborts. Resolves cleanly on abort — callers then flush + exit.
 *
 * Per-tick try/catch: the daemon must survive transient errors (RPC
 * blips, bad event payloads, handler bugs). Cycle errors log at `error`
 * level and the loop continues; the operator learns via logs or metrics.
 *
 * Exponential backoff on consecutive failures (2× per fail, capped at
 * `maxBackoffMs`) prevents a wedged upstream — dead RPC, corrupt
 * on-chain state — from flooding logs and burning quota. First success
 * resets the backoff. Non-failing ticks sleep `intervalMs` as normal.
 */
export async function loopCycles(options: LoopCyclesOptions): Promise<void> {
    const maxBackoff = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    let consecutiveFailures = 0;

    if (options.onStart) {
        await options.onStart();
    }
    while (!options.signal.aborted) {
        let tickFailed = false;
        try {
            await options.onTick();
        } catch (err) {
            tickFailed = true;
            consecutiveFailures++;
            const msg = err instanceof Error ? err.message : String(err);
            options.logger.error('cycle threw — continuing loop', {
                error: msg,
                consecutiveFailures,
            });
        }
        if (!tickFailed) consecutiveFailures = 0;
        if (options.signal.aborted) return;

        const nextDelay = tickFailed
            ? Math.min(maxBackoff, options.intervalMs * 2 ** (consecutiveFailures - 1))
            : options.intervalMs;
        try {
            await abortableSleep(nextDelay, options.signal);
        } catch (err) {
            if (isAbortError(err)) return;
            throw err;
        }
    }
}

export interface WaitForDrainOptions {
    isDrained: () => boolean;
    timeoutMs: number;
    pollIntervalMs?: number;
    logger: WorkerLogger;
    /** What we're waiting on — used in log messages. */
    label: string;
    /**
     * Optional abort signal — when supplied, a second shutdown signal aborts
     * the drain wait and returns false immediately (without waiting for the
     * timeout). Production's orchestrator wires this so operators pressing
     * ^C twice don't have to sit through the full grace window.
     */
    signal?: AbortSignal;
}

/**
 * Poll `isDrained()` until it returns true or `timeoutMs` elapses.
 * Returns `true` if drained, `false` on timeout or external abort.
 * Shutdown callers use this to give in-flight txs a chance to confirm
 * before killing the process, but we do NOT block forever — a wedged RPC
 * must not prevent the daemon from exiting.
 */
export async function waitForDrain(options: WaitForDrainOptions): Promise<boolean> {
    const poll = options.pollIntervalMs ?? 100;
    const start = Date.now();
    while (!options.isDrained()) {
        if (options.signal?.aborted) {
            options.logger.warn(`${options.label}: aborted before drain completed`);
            return false;
        }
        if (Date.now() - start >= options.timeoutMs) {
            options.logger.warn(
                `${options.label}: did not drain within ${options.timeoutMs}ms — abandoning`,
            );
            return false;
        }
        try {
            if (options.signal !== undefined) {
                await abortableSleep(poll, options.signal);
            } else {
                await new Promise((r) => setTimeout(r, poll).unref());
            }
        } catch (err) {
            if (isAbortError(err)) {
                options.logger.warn(`${options.label}: aborted before drain completed`);
                return false;
            }
            throw err;
        }
    }
    return true;
}
