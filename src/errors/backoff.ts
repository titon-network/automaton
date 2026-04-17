// Generic retry + backoff primitives for any `() => Promise<T>`.
//
// FailoverTonClient already retries per-call with endpoint rotation,
// which covers the common RPC-blip path. These helpers are for
// everything ELSE: state-machine operations where we want bounded
// retries without reaching for a new client. Concrete consumers today
// are sparse (nothing in hot paths uses it yet), but the primitive is
// exported so future code (e.g. deferred alert POSTs, file-lock
// acquisition, third-party webhook callers) has a single reusable
// pattern instead of hand-rolling yet another while-loop + setTimeout.
//
// Design:
//   - `jitteredBackoff` mirrors the formula FailoverTonClient uses
//     (equal jitter — `sleep = base*2^n/2 + rand[0, base*2^n/2)`,
//     capped). One formula, two call sites.
//   - `abortableRetry` runs `fn()` up to `maxAttempts` times; on
//     failure, calls `shouldRetry(err, attempt)` — if true, sleeps and
//     retries; if false or exhausted, re-throws. Respects AbortSignal
//     so the daemon's SIGTERM path drops pending retries immediately.

export interface JitterOptions {
    attempt: number;
    baseMs: number;
    maxMs: number;
    /** Test-only override for deterministic backoff in tests. */
    random?: () => number;
}

/**
 * Equal-jitter exponential backoff. Given `attempt` (1-indexed, first
 * retry = 1), `baseMs`, and `maxMs`, returns a delay in ms:
 *
 *   exp = min(maxMs, baseMs * 2^(attempt-1))
 *   delay = floor(exp/2 + random*exp/2)
 *
 * "Equal jitter" keeps delays bounded below `exp` but away from zero,
 * which is the usual correlation-avoidance sweet spot.
 */
export function jitteredBackoff(options: JitterOptions): number {
    if (options.baseMs <= 0) return 0;
    const rnd = options.random ?? Math.random;
    const exp = Math.min(options.maxMs, options.baseMs * 2 ** (options.attempt - 1));
    const half = exp / 2;
    return Math.floor(half + rnd() * half);
}

export interface RetryOptions<E = unknown> {
    maxAttempts: number;
    baseBackoffMs: number;
    maxBackoffMs: number;
    signal?: AbortSignal;
    /**
     * Called when `fn` throws. Return true to retry; false to re-throw.
     * Default: retry on every error. Consumers classify transient vs
     * permanent here (e.g. `err instanceof AuthError ? false : true`).
     */
    shouldRetry?: (err: E, attempt: number) => boolean;
    /** Observer hook for logs / metrics. Fires before each retry sleep. */
    onRetry?: (info: { attempt: number; error: E; sleepMs: number }) => void;
    /** Test-only sleep injection. Defaults to setTimeout. */
    sleep?: (ms: number) => Promise<void>;
    /** Test-only random injection. Forwarded to jitteredBackoff. */
    random?: () => number;
}

/**
 * Thrown when an `abortableRetry` run was cancelled via its AbortSignal.
 * `attempts` is the number of `fn()` invocations that actually executed
 * before abort — 0 when the signal was already aborted before the first
 * attempt, N when abort fired after N executions. Callers can
 * `instanceof RetryAbortedError` to distinguish "we shut down mid-retry"
 * from "the underlying op failed permanently".
 */
export class RetryAbortedError extends Error {
    constructor(public readonly attempts: number) {
        super(`retry aborted after ${attempts} attempt(s)`);
        this.name = 'RetryAbortedError';
    }
}

/**
 * Run `fn` with bounded retries + jittered backoff. Promise resolves
 * with the first success; rejects with the last error on exhaustion
 * or a `shouldRetry(false)` decision. Aborted retries reject with
 * `RetryAbortedError` carrying the attempt count.
 */
export async function abortableRetry<T>(
    fn: () => Promise<T>,
    options: RetryOptions,
): Promise<T> {
    const shouldRetry = options.shouldRetry ?? ((): boolean => true);
    const sleep = options.sleep ?? defaultSleep;
    let lastError: unknown;

    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
        if (options.signal?.aborted) throw new RetryAbortedError(attempt - 1);
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            // Check abort BEFORE deciding whether to re-throw on exhaustion —
            // an aborted run whose fn() throws should surface as a retry
            // cancellation, not a raw transient error. Keeps callers' abort
            // handling uniform regardless of attempt count.
            if (options.signal?.aborted) throw new RetryAbortedError(attempt);
            if (attempt === options.maxAttempts) throw err;
            if (!shouldRetry(err, attempt)) throw err;

            const sleepMs = jitteredBackoff({
                attempt,
                baseMs: options.baseBackoffMs,
                maxMs: options.maxBackoffMs,
                random: options.random,
            });
            options.onRetry?.({ attempt, error: err, sleepMs });

            if (sleepMs > 0) {
                await sleep(sleepMs);
            }
            if (options.signal?.aborted) throw new RetryAbortedError(attempt);
        }
    }

    // Unreachable — the loop returns on success, throws on final attempt.
    // TypeScript wants it.
    throw lastError;
}

/**
 * Default sleep — `setTimeout` with `.unref()` so a pending retry can
 * never prevent the daemon process from exiting. Callers that provide
 * their own `options.sleep` / `options.signal` control cleanup
 * themselves.
 *
 * Exported so every async primitive in the codebase (FailoverTonClient
 * retry loop, etc.) uses the same unref-ed sleep. Don't add a private
 * setTimeout-based sleep elsewhere — pending timers without `.unref()`
 * can hold Node's event loop open past the daemon's graceful shutdown.
 */
export function unrefSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms).unref();
    });
}

function defaultSleep(ms: number): Promise<void> {
    return unrefSleep(ms);
}
