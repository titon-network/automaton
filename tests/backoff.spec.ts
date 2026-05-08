// Backoff math + sleep ref-ness. The retry loops live in their callers
// (FailoverTonClient, sendAndConfirm) — this file only pins the two
// shared primitives those callers depend on.

import { execFileSync } from 'child_process';
import { defaultSleep, jitteredBackoff } from '../src/errors/backoff';

describe('jitteredBackoff', () => {
    it('grows exponentially between attempts (random fixed at 0.5)', () => {
        const opts = { baseMs: 100, maxMs: 10_000, random: () => 0.5 };
        // exp = base * 2^(n-1); half = exp/2; delay = half + 0.5*half = 0.75*exp
        expect(jitteredBackoff({ ...opts, attempt: 1 })).toBe(Math.floor(0.75 * 100));
        expect(jitteredBackoff({ ...opts, attempt: 2 })).toBe(Math.floor(0.75 * 200));
        expect(jitteredBackoff({ ...opts, attempt: 3 })).toBe(Math.floor(0.75 * 400));
    });

    it('caps at maxMs', () => {
        const d = jitteredBackoff({ attempt: 20, baseMs: 1_000, maxMs: 500, random: () => 1 });
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

    it('throws when attempt is < 1 (1-indexed contract)', () => {
        // L2 fix: silently producing sub-base delays for attempt=0 or
        // negative is almost always a caller bug (off-by-one in a retry
        // loop). Loud failure beats a 50ms surprise sleep.
        expect(() => jitteredBackoff({ attempt: 0, baseMs: 100, maxMs: 10_000 })).toThrow(/>= 1/);
        expect(() => jitteredBackoff({ attempt: -1, baseMs: 100, maxMs: 10_000 })).toThrow(/>= 1/);
        expect(() => jitteredBackoff({ attempt: NaN, baseMs: 100, maxMs: 10_000 })).toThrow(/>= 1/);
    });
});

// One-shot CLI commands (`automaton status`, `automaton stake register`, …)
// fan out parallel chain reads. When the RPC rate-limits, every call backs
// off and the retry timer is the only thing keeping the process alive. An
// `.unref()`-ed timer would let Node exit cleanly mid-retry with no output;
// `defaultSleep` is a plain `setTimeout` to prevent that. This test pins
// the ref-ness so a regression can't quietly slip in.
describe('defaultSleep', () => {
    const backoffSrc = require.resolve('../src/errors/backoff');

    it('keeps the event loop alive — process waits the full duration', () => {
        // Sleep 1.5s; with a ref-ed timer the child stays alive that long
        // and prints "woke" at the end. Generous lower bound to absorb
        // ts-node load; tight upper bound rejects any `.unref()` regression.
        const t0 = Date.now();
        const stdout = execFileSync(
            process.execPath,
            [
                '-r',
                'ts-node/register/transpile-only',
                '-e',
                `(async () => {
                    const { defaultSleep } = require(${JSON.stringify(backoffSrc)});
                    await defaultSleep(1500);
                    process.stdout.write('woke');
                })();`,
            ],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
        );
        const elapsedMs = Date.now() - t0;
        expect(stdout).toBe('woke');
        expect(elapsedMs).toBeGreaterThanOrEqual(1500);
        expect(elapsedMs).toBeLessThan(8000);
    });
});
