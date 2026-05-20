// Security defenses pinned. Each test exercises one of the audit
// findings — regressions get caught at CI rather than discovered
// in production after a hostile feed lands.
//
//   - parsePositivePrice rejects oversize input (BigInt CPU DoS)
//   - PriceFeedManager rescale rejects extreme expo shifts
//   - WsAdapterBase emit() drops ticks for unsubscribed symbols
//     (cache-OOM defense — hostile feed spraying unknown symbols)
//   - WsAdapterBase escalates to error after N consecutive failures
//   - parsePositivePrice rejects non-positive prices

import * as net from 'net';
import { WebSocketServer } from 'ws';
import {
    BinanceSource,
    PriceFeedManager,
    parsePositivePrice,
    type FeedConfig,
    type PriceSource,
    type Tick,
    type TickCallback,
} from '../src/products/phoebe-sources';

const NOOP_LOGGER = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

function captureLogger() {
    return {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    };
}

function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const tick = (): void => {
            if (predicate()) return resolve();
            if (Date.now() - start > timeoutMs) {
                return reject(new Error(`waitFor timeout after ${timeoutMs}ms`));
            }
            setTimeout(tick, 20);
        };
        tick();
    });
}

describe('parsePositivePrice DoS defenses', () => {
    it('rejects oversize input (BigInt parse is O(n²))', () => {
        const huge = '9'.repeat(1_000_000);
        const start = Date.now();
        const out = parsePositivePrice(huge);
        const elapsed = Date.now() - start;
        expect(out).toBeNull();
        // Defense's value: rejection should be near-instant, NOT >100ms
        // (the BigInt parse cost we're avoiding). Generous bound so
        // CI flakiness doesn't fail this — the real test is the null.
        expect(elapsed).toBeLessThan(50);
    });

    it('accepts realistic prices at the length boundary', () => {
        // 32-char cap; "999999999999.99999999" is 21 chars — well within.
        expect(parsePositivePrice('65000.123456')).not.toBeNull();
        // Just at the cap
        expect(parsePositivePrice('1'.repeat(32))).not.toBeNull();
        // One past the cap
        expect(parsePositivePrice('1'.repeat(33))).toBeNull();
    });
});

describe('PriceFeedManager rescale-shift cap', () => {
    /** Stub source that hands us its emit callback so we can push
     *  a hostile-expo tick the manager will need to rescale. */
    class StubSource implements PriceSource {
        readonly name: string;
        private cb: TickCallback | null = null;
        constructor(name: string) {
            this.name = name;
        }
        async start(_: readonly string[], onTick: TickCallback): Promise<void> {
            this.cb = onTick;
        }
        async stop(): Promise<void> {
            // intentionally empty — test only
        }
        isHealthy(): boolean {
            return true;
        }
        push(symbol: string, tick: Tick): void {
            this.cb!(symbol, tick);
        }
    }

    it('drops a tick whose source-expo demands a rescale > 24 places', async () => {
        const a = new StubSource('a');
        const b = new StubSource('b');
        const feed: FeedConfig = {
            feedId: 1,
            sources: [
                { name: 'a', symbol: 'x' },
                { name: 'b', symbol: 'x' },
            ],
            expo: -6,
            minSources: 2,
        };
        const logs = captureLogger();
        const mgr = new PriceFeedManager({
            logger: logs,
            sources: [a, b],
            feeds: [feed],
            nowMs: () => 1_000_000,
        });
        await mgr.start();
        // a reports honest; b reports with hostile expo (-128 → shift
        // from -128 to -6 = 122 places, far past the 24 cap).
        a.push('x', { mantissa: 6_000_000n, expo: -6, receivedAtMs: 999_000 });
        b.push('x', { mantissa: 1n, expo: -128, receivedAtMs: 999_000 });
        // Only the honest source contributes → minSources=2 NOT met → null.
        expect(mgr.aggregate(feed)).toBeNull();
        expect(logs.warn).toHaveBeenCalledWith(
            expect.stringContaining('rescale-shift cap hit'),
            expect.objectContaining({ source: 'b', sourceExpo: -128 }),
        );
        await mgr.stop();
    });
});

describe('WsAdapterBase subscribed-symbol allowlist (cache-OOM defense)', () => {
    it('drops ticks for symbols the operator did not subscribe to', async () => {
        // ws server that echoes an UNSUBSCRIBED symbol — hostile/buggy
        // server pretending to be Binance. We confirm the cache stays
        // empty (rather than growing with attacker-controlled symbols).
        const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
        const port = await new Promise<number>((resolve) =>
            wss.on('listening', () => resolve((wss.address() as net.AddressInfo).port)),
        );
        wss.on('connection', (ws) => {
            ws.on('message', () => {
                // Send a trade for a symbol the operator did NOT subscribe to.
                ws.send(
                    JSON.stringify({
                        e: 'trade',
                        s: 'ATTACKERSYMBOL',
                        p: '1.234',
                        T: Date.now(),
                    }),
                );
                // And one for the legit symbol so the test can wait
                // for SOMETHING to fire.
                ws.send(
                    JSON.stringify({
                        e: 'trade',
                        s: 'TONUSDT',
                        p: '6.5',
                        T: Date.now(),
                    }),
                );
            });
        });

        try {
            const ticks: { symbol: string; tick: Tick }[] = [];
            const src = new BinanceSource({
                logger: NOOP_LOGGER,
                urlOverride: `ws://127.0.0.1:${port}`,
            });
            await src.start(['TONUSDT'], (symbol, tick) => ticks.push({ symbol, tick }));
            await waitFor(() => ticks.length > 0, 3_000);
            // Hostile symbol was dropped at the emit boundary; only
            // the subscribed symbol made it through.
            const symbols = ticks.map((t) => t.symbol);
            expect(symbols).toContain('TONUSDT');
            expect(symbols).not.toContain('ATTACKERSYMBOL');
            await src.stop();
        } finally {
            await new Promise<void>((r) => wss.close(() => r()));
        }
    });
});

describe('WsAdapterBase consecutive-failure escalation', () => {
    it('logs at error after PERSISTENT_FAILURE_THRESHOLD failed attempts', async () => {
        // Listener that never even accepts — we hand the adapter a
        // closed port. Each connect attempt fails fast (ECONNREFUSED);
        // after 10 failures we expect an error log.
        const dummy = net.createServer();
        const port = await new Promise<number>((resolve) =>
            dummy.listen(0, '127.0.0.1', () => resolve((dummy.address() as net.AddressInfo).port)),
        );
        await new Promise<void>((r) => dummy.close(() => r()));
        // Now `port` is guaranteed-free — connects refused.

        const logs = captureLogger();
        const src = new BinanceSource({
            logger: logs,
            urlOverride: `ws://127.0.0.1:${port}`,
            connectTimeoutMs: 50,
            initialBackoffMs: 20,
            maxBackoffMs: 20,
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        });
        await src.start(['TONUSDT'], () => undefined);

        await waitFor(
            () =>
                logs.error.mock.calls.some((c) =>
                    String(c[0]).includes('persistent connect failure'),
                ),
            5_000,
        );
        expect(src.consecutiveFailureCount()).toBeGreaterThanOrEqual(10);
        await src.stop();
    });
});
