// `automaton playground` end-to-end drift guard.
//
// Runs the playground simulation programmatically (no CLI subprocess —
// `runPlayground` is the unit) for a small fixed number of ticks and
// asserts the production tick path actually advances the demo
// automaton's job: 3+ executions confirmed, balance increased, summary
// line in the captured output.
//
// If this regresses, the user-visible "30-second test on your laptop"
// experience is broken — same severity as `pnpm run smoke` failing.

import { runPlayground } from '../src/playground/demo';

class StringStream {
    chunks: string[] = [];
    write(chunk: string): boolean {
        this.chunks.push(chunk);
        return true;
    }
    text(): string {
        return this.chunks.join('');
    }
}

describe('automaton playground', () => {
    // Sandbox bootstrap + 3 ticks reliably finish well under 30s; this
    // generous cap protects CI from flake without being noisy locally.
    jest.setTimeout(60_000);

    it('Kronos-only path: confirmed executions + earnings', async () => {
        const out = new StringStream();
        const result = await runPlayground({
            ticks: 3,
            tickIntervalMs: 0,
            jobIntervalSec: 60,
            withFortuna: false,
            output: out,
            format: 'pretty',
        });

        expect(result.ticksRun).toBe(3);
        expect(result.executions).toBeGreaterThanOrEqual(3);
        expect(result.fortunaFulfillments).toBe(0);
        expect(result.aborted).toBe(false);
        expect(result.earnedNano).toBeGreaterThan(0n);
        expect(result.finalBalanceNano).toBeGreaterThan(result.initialBalanceNano);

        const text = out.text();
        expect(text).toContain('Titon automaton playground');
        expect(text).toContain('registered with');
        expect(text).toContain('1 exec');
        expect(text).toContain('complete');
        expect(text).toContain('kronos exec');
    });

    it('full stack (Kronos + Fortuna): earns from both protocols', async () => {
        const out = new StringStream();
        const result = await runPlayground({
            ticks: 3,
            tickIntervalMs: 0,
            jobIntervalSec: 60,
            output: out,
            format: 'pretty',
        });

        expect(result.ticksRun).toBe(3);
        expect(result.executions).toBeGreaterThanOrEqual(3);
        // 3 ticks fire 3 RequestRandomness; the request-fulfill cycle lands
        // at least 2 fulfillments by the settle drain (one tick of overlap
        // is the sandbox-time fact).
        expect(result.fortunaFulfillments).toBeGreaterThanOrEqual(2);
        expect(result.earnedNano).toBeGreaterThan(0n);

        const text = out.text();
        expect(text).toContain('ForgeTON + Kronos + Atlas + Fortuna');
        expect(text).toContain('pkShare accepted');
        expect(text).toContain('VRF ready');
        expect(text).toContain('kronos   execute');
        expect(text).toContain('fortuna  fulfill');
        expect(text).toContain('fortuna fulfill'); // summary line
    });

    it('emits one JSON event per line in --format json', async () => {
        const out = new StringStream();
        const result = await runPlayground({
            ticks: 2,
            tickIntervalMs: 0,
            jobIntervalSec: 60,
            withFortuna: false,
            output: out,
            format: 'json',
        });

        const lines = out
            .text()
            .split('\n')
            .filter((l) => l.length > 0);

        expect(lines.length).toBeGreaterThan(0);
        const events = lines.map((l) => JSON.parse(l));

        // Every line is a structured event with `kind`.
        for (const e of events) {
            expect(typeof e.kind).toBe('string');
        }

        // The summary kind always lands at the tail.
        const summary = events.at(-1);
        expect(summary.kind).toBe('summary');
        expect(summary.ticksRun).toBe(2);
        expect(Number(summary.executions)).toBe(result.executions);
    });

    it('honors AbortSignal — exits cleanly with aborted=true', async () => {
        const ac = new AbortController();
        const out = new StringStream();

        // Abort before any ticks run; the loop should observe the signal
        // immediately and emit a clean summary with aborted=true.
        ac.abort();

        const result = await runPlayground({
            ticks: 100,
            tickIntervalMs: 0,
            jobIntervalSec: 60,
            withFortuna: false,
            signal: ac.signal,
            output: out,
            format: 'pretty',
        });

        expect(result.aborted).toBe(true);
        expect(result.ticksRun).toBe(0);
        expect(out.text()).toContain('aborted');
    });
});
