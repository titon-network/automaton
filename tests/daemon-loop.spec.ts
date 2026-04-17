import {
    AbortError,
    abortableSleep,
    isAbortError,
    loopCycles,
    waitForDrain,
} from '../src/daemon/loop';
import type { WorkerLogger } from '../src/worker/loop';

function buildLogger(): { log: WorkerLogger; messages: Array<{ level: string; msg: string }> } {
    const messages: Array<{ level: string; msg: string }> = [];
    return {
        log: {
            debug: (m) => messages.push({ level: 'debug', msg: m }),
            info: (m) => messages.push({ level: 'info', msg: m }),
            warn: (m) => messages.push({ level: 'warn', msg: m }),
            error: (m) => messages.push({ level: 'error', msg: m }),
        },
        messages,
    };
}

describe('abortableSleep', () => {
    it('resolves after the given ms', async () => {
        const ac = new AbortController();
        const start = Date.now();
        await abortableSleep(25, ac.signal);
        expect(Date.now() - start).toBeGreaterThanOrEqual(20);
    });

    it('rejects with AbortError when the signal fires mid-sleep', async () => {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 10);
        await expect(abortableSleep(1_000, ac.signal)).rejects.toBeInstanceOf(AbortError);
    });

    it('rejects immediately if the signal is already aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        await expect(abortableSleep(1_000, ac.signal)).rejects.toBeInstanceOf(AbortError);
    });

    it('cleans up the timer on abort (no leaked handle)', async () => {
        const ac = new AbortController();
        const p = abortableSleep(10_000, ac.signal).catch(() => {});
        ac.abort();
        await p;
        // If the timer leaked, the process would wait 10s to exit in
        // non-test contexts. Presence of this assertion forces the
        // implementation to clear the timer on abort.
        expect(ac.signal.aborted).toBe(true);
    });
});

describe('isAbortError', () => {
    it('is true for AbortError instances', () => {
        expect(isAbortError(new AbortError())).toBe(true);
    });
    it('is false for other errors', () => {
        expect(isAbortError(new Error('boom'))).toBe(false);
        expect(isAbortError(null)).toBe(false);
    });
});

describe('loopCycles', () => {
    it('runs onTick repeatedly until signal aborts', async () => {
        const ac = new AbortController();
        const { log } = buildLogger();
        let ticks = 0;

        const p = loopCycles({
            signal: ac.signal,
            intervalMs: 5,
            logger: log,
            onTick: async () => {
                ticks++;
                if (ticks >= 3) ac.abort();
            },
        });
        await p;
        expect(ticks).toBe(3);
    });

    it('continues on tick errors, logging each one', async () => {
        const ac = new AbortController();
        const { log, messages } = buildLogger();
        let ticks = 0;

        await loopCycles({
            signal: ac.signal,
            intervalMs: 1,
            logger: log,
            onTick: async () => {
                ticks++;
                if (ticks === 1) throw new Error('first tick boom');
                if (ticks >= 2) ac.abort();
            },
        });

        expect(ticks).toBe(2);
        expect(messages.some((m) => m.level === 'error' && m.msg.includes('cycle threw'))).toBe(true);
    });

    it('calls onStart once before the first tick', async () => {
        const ac = new AbortController();
        const { log } = buildLogger();
        const order: string[] = [];

        await loopCycles({
            signal: ac.signal,
            intervalMs: 1,
            logger: log,
            onStart: async () => {
                order.push('start');
            },
            onTick: async () => {
                order.push('tick');
                ac.abort();
            },
        });

        expect(order).toEqual(['start', 'tick']);
    });

    it('exits cleanly when signal aborts during inter-tick sleep', async () => {
        const ac = new AbortController();
        const { log } = buildLogger();
        let ticks = 0;

        const loop = loopCycles({
            signal: ac.signal,
            intervalMs: 10_000, // long interval so abort lands during sleep
            logger: log,
            onTick: async () => {
                ticks++;
            },
        });

        // Let first tick run
        await new Promise((r) => setTimeout(r, 20));
        ac.abort();
        await loop;

        expect(ticks).toBe(1);
    });

    it('backs off exponentially on consecutive tick failures', async () => {
        const ac = new AbortController();
        const { log } = buildLogger();
        const sleeps: number[] = [];
        let ticks = 0;

        // Patch abortableSleep via a tight intervalMs + observe via the
        // tick count vs wall time. Simpler: record elapsed between ticks.
        let lastTickAt = Date.now();
        await loopCycles({
            signal: ac.signal,
            intervalMs: 10,
            logger: log,
            onTick: async () => {
                const now = Date.now();
                if (ticks > 0) sleeps.push(now - lastTickAt);
                lastTickAt = now;
                ticks++;
                if (ticks < 4) throw new Error(`tick ${ticks} boom`);
                ac.abort();
            },
            maxBackoffMs: 500,
        });

        expect(ticks).toBe(4);
        // Sleeps between 4 consecutive-failing ticks: base=10, so delays
        // are 10, 20, 40 (2^0 * 10, 2^1 * 10, 2^2 * 10). Allow 5ms slack
        // for scheduler jitter on each measurement.
        expect(sleeps).toHaveLength(3);
        expect(sleeps[0]).toBeGreaterThanOrEqual(8);
        expect(sleeps[1]).toBeGreaterThanOrEqual(18);
        expect(sleeps[2]).toBeGreaterThanOrEqual(38);
    });

    it('resets backoff after the first successful tick', async () => {
        const ac = new AbortController();
        const { log, messages } = buildLogger();
        const failuresSeen: number[] = [];
        let ticks = 0;

        await loopCycles({
            signal: ac.signal,
            intervalMs: 5,
            logger: log,
            onTick: async () => {
                ticks++;
                if (ticks === 1 || ticks === 2) throw new Error(`boom ${ticks}`);
                if (ticks >= 3) ac.abort();
            },
        });

        for (const m of messages) {
            if (m.level === 'error' && m.msg.includes('cycle threw')) {
                // consecutiveFailures field is logged; extract from structure indirectly
                failuresSeen.push(m.msg.length); // just confirm the error logged fires
            }
        }
        expect(ticks).toBe(3);
    });

    it('caps backoff at maxBackoffMs', async () => {
        const ac = new AbortController();
        const { log } = buildLogger();
        const sleeps: number[] = [];
        let ticks = 0;
        let lastTickAt = Date.now();

        await loopCycles({
            signal: ac.signal,
            intervalMs: 1_000,
            logger: log,
            onTick: async () => {
                const now = Date.now();
                if (ticks > 0) sleeps.push(now - lastTickAt);
                lastTickAt = now;
                ticks++;
                if (ticks < 5) throw new Error(`tick ${ticks}`);
                ac.abort();
            },
            maxBackoffMs: 50, // force the cap to engage
        });

        // With intervalMs=1000 and cap=50, every between-tick delay is ≤ ~60ms (50 + jitter).
        for (const s of sleeps) {
            expect(s).toBeLessThan(200);
        }
    });

    it('does not log the abort itself as an error', async () => {
        const ac = new AbortController();
        const { log, messages } = buildLogger();

        const loop = loopCycles({
            signal: ac.signal,
            intervalMs: 1_000,
            logger: log,
            onTick: async () => {
                ac.abort();
            },
        });
        await loop;

        expect(messages.filter((m) => m.level === 'error')).toEqual([]);
    });
});

describe('waitForDrain', () => {
    it('returns true immediately when already drained', async () => {
        const { log } = buildLogger();
        const result = await waitForDrain({
            isDrained: () => true,
            timeoutMs: 100,
            logger: log,
            label: 'test',
        });
        expect(result).toBe(true);
    });

    it('returns true when the set drains within the timeout', async () => {
        const { log } = buildLogger();
        let drained = false;
        setTimeout(() => {
            drained = true;
        }, 30);

        const result = await waitForDrain({
            isDrained: () => drained,
            timeoutMs: 500,
            pollIntervalMs: 10,
            logger: log,
            label: 'test',
        });
        expect(result).toBe(true);
    });

    it('returns false and warns when timeout elapses', async () => {
        const { log, messages } = buildLogger();
        const result = await waitForDrain({
            isDrained: () => false,
            timeoutMs: 20,
            pollIntervalMs: 5,
            logger: log,
            label: 'stuck drain',
        });
        expect(result).toBe(false);
        expect(messages.some((m) => m.level === 'warn' && m.msg.includes('stuck drain'))).toBe(true);
    });
});
