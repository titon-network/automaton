// Retry + backoff primitives: jitteredBackoff growth/cap/bounds behaviour,
// abortableRetry happy path + shouldRetry + onRetry observer + AbortSignal
// cancellation + injected sleep/random for determinism.

import {
    abortableRetry,
    jitteredBackoff,
    RetryAbortedError,
} from '../src/errors/backoff';

describe('jitteredBackoff', () => {
    it('grows exponentially between attempts (random fixed at 0.5)', () => {
        const opts = { baseMs: 100, maxMs: 10_000, random: () => 0.5 };
        // exp = base * 2^(n-1); half = exp/2; delay = half + 0.5*half = 0.75*exp
        expect(jitteredBackoff({ ...opts, attempt: 1 })).toBe(Math.floor(0.75 * 100));
        expect(jitteredBackoff({ ...opts, attempt: 2 })).toBe(Math.floor(0.75 * 200));
        expect(jitteredBackoff({ ...opts, attempt: 3 })).toBe(Math.floor(0.75 * 400));
    });

    it('caps at maxMs', () => {
        const d = jitteredBackoff({
            attempt: 20,
            baseMs: 1_000,
            maxMs: 500,
            random: () => 1,
        });
        expect(d).toBeLessThanOrEqual(500);
    });

    it('returns 0 when baseMs is 0 (disabled)', () => {
        expect(jitteredBackoff({ attempt: 5, baseMs: 0, maxMs: 10_000 })).toBe(0);
    });

    it('delays stay in [half, exp) bounds with random jitter', () => {
        const opts = { baseMs: 100, maxMs: 10_000 };
        for (let i = 0; i < 100; i++) {
            const d = jitteredBackoff({ ...opts, attempt: 3 });
            // exp = 400, half = 200. delay ∈ [200, 400)
            expect(d).toBeGreaterThanOrEqual(200);
            expect(d).toBeLessThan(400);
        }
    });
});

describe('abortableRetry', () => {
    it('returns the first successful result', async () => {
        let calls = 0;
        const result = await abortableRetry(
            async () => {
                calls++;
                return 'ok';
            },
            { maxAttempts: 3, baseBackoffMs: 0, maxBackoffMs: 0 },
        );
        expect(result).toBe('ok');
        expect(calls).toBe(1);
    });

    it('retries failing attempts until success', async () => {
        let attempts = 0;
        const result = await abortableRetry(
            async () => {
                attempts++;
                if (attempts < 3) throw new Error(`try ${attempts}`);
                return 'eventually';
            },
            { maxAttempts: 5, baseBackoffMs: 0, maxBackoffMs: 0 },
        );
        expect(result).toBe('eventually');
        expect(attempts).toBe(3);
    });

    it('rethrows the last error after maxAttempts', async () => {
        let attempts = 0;
        await expect(
            abortableRetry(
                async () => {
                    attempts++;
                    throw new Error(`fail ${attempts}`);
                },
                { maxAttempts: 3, baseBackoffMs: 0, maxBackoffMs: 0 },
            ),
        ).rejects.toThrow('fail 3');
        expect(attempts).toBe(3);
    });

    it('does not retry when shouldRetry returns false', async () => {
        let attempts = 0;
        await expect(
            abortableRetry(
                async () => {
                    attempts++;
                    throw new Error('permanent');
                },
                {
                    maxAttempts: 5,
                    baseBackoffMs: 0,
                    maxBackoffMs: 0,
                    shouldRetry: () => false,
                },
            ),
        ).rejects.toThrow('permanent');
        expect(attempts).toBe(1);
    });

    it('fires the onRetry hook before each sleep', async () => {
        const calls: Array<{ attempt: number; sleepMs: number }> = [];
        await abortableRetry(
            async () => {
                throw new Error('always');
            },
            {
                maxAttempts: 3,
                baseBackoffMs: 0,
                maxBackoffMs: 0,
                onRetry: (info) => calls.push({ attempt: info.attempt, sleepMs: info.sleepMs }),
            },
        ).catch(() => {});

        // 3 attempts → 2 retries → 2 onRetry calls
        expect(calls).toHaveLength(2);
        expect(calls.map((c) => c.attempt)).toEqual([1, 2]);
    });

    it('rejects with RetryAbortedError when the signal fires between attempts', async () => {
        const ac = new AbortController();
        let attempts = 0;
        const probe = abortableRetry(
            async () => {
                attempts++;
                if (attempts === 1) {
                    ac.abort();
                }
                throw new Error('transient');
            },
            {
                maxAttempts: 5,
                baseBackoffMs: 0,
                maxBackoffMs: 0,
                signal: ac.signal,
            },
        );
        await expect(probe).rejects.toBeInstanceOf(RetryAbortedError);
    });

    it('surfaces RetryAbortedError on the final attempt when abort fires mid-fn', async () => {
        // Previously this returned the raw error; now the abort check
        // runs before the maxAttempts check so callers' `instanceof
        // RetryAbortedError` shutdown handling is uniform regardless of
        // attempt count.
        const ac = new AbortController();
        const probe = abortableRetry(
            async () => {
                ac.abort();
                throw new Error('transient');
            },
            {
                maxAttempts: 1,
                baseBackoffMs: 0,
                maxBackoffMs: 0,
                signal: ac.signal,
            },
        );
        await expect(probe).rejects.toBeInstanceOf(RetryAbortedError);
    });

    it('rejects immediately with RetryAbortedError if the signal is already aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        let called = 0;
        await expect(
            abortableRetry(
                async () => {
                    called++;
                    return 'x';
                },
                {
                    maxAttempts: 3,
                    baseBackoffMs: 0,
                    maxBackoffMs: 0,
                    signal: ac.signal,
                },
            ),
        ).rejects.toBeInstanceOf(RetryAbortedError);
        expect(called).toBe(0);
    });

    it('uses the injected sleep (tests can observe delays without wall time)', async () => {
        const sleeps: number[] = [];
        await abortableRetry(
            async () => {
                throw new Error('x');
            },
            {
                maxAttempts: 3,
                baseBackoffMs: 100,
                maxBackoffMs: 10_000,
                sleep: async (ms) => {
                    sleeps.push(ms);
                },
                random: () => 0.5,
            },
        ).catch(() => {});

        expect(sleeps).toHaveLength(2);
        expect(sleeps[0]).toBeGreaterThan(0);
    });
});
