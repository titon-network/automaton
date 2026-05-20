// Equal-jitter exponential backoff + the canonical sleep primitive.
//
// `FailoverTonClient` (`src/chain/ton-client.ts`) and `sendAndConfirm`
// (`src/chain/submit.ts`) drive their own retry loops because they need
// specific control over endpoint rotation and seqno polling. They share
// these two helpers so the math + the timer behaviour are identical
// across both call sites — and so any future retry path in the codebase
// uses the same building blocks instead of hand-rolling another one.

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
 *
 * `attempt` must be >= 1 (1-indexed). Passing 0 or negative would
 * compute `2^(-1)` or smaller and yield a sub-base delay — almost
 * certainly a caller bug, so we throw rather than silently silently
 * shrink the backoff.
 */
export function jitteredBackoff(options: JitterOptions): number {
    if (options.baseMs <= 0) return 0;
    if (!Number.isFinite(options.attempt) || options.attempt < 1) {
        throw new Error(`jitteredBackoff: attempt must be >= 1 (got ${options.attempt})`);
    }
    const rnd = options.random ?? Math.random;
    const exp = Math.min(options.maxMs, options.baseMs * 2 ** (options.attempt - 1));
    const half = exp / 2;
    return Math.floor(half + rnd() * half);
}

/**
 * Plain `setTimeout`-based sleep, kept ref-ed so a pending retry holds
 * the event loop open. One-shot CLI invocations (`automaton status`,
 * `automaton stake register`, …) fan out parallel chain reads — if the
 * RPC rate-limits, every call backs off and the retry timer is the only
 * thing keeping the process alive. An unref-ed timer would let Node
 * exit cleanly mid-retry with no output.
 *
 * Exported so every async primitive in the codebase uses the same
 * sleep impl. Don't add a private setTimeout-based sleep elsewhere.
 */
export function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
