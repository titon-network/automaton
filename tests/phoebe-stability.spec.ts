// WsAdapterBase stability tests — pins the hardening features the
// design comment advertises (connect-timeout, silence-timeout) so
// future refactors can't silently regress them. Also covers the
// pure `buildPhoebeLeaves` helper extracted from PhoebeWorker for
// mixed static + dynamic feed scenarios.
//
// Pong-deadline is exercised end-to-end against the `ws` library's
// own pong-handling in tests/phoebe-source-adapter.spec.ts (where
// the real `ws` server auto-responds to pings); a pong-timeout
// integration test needs a raw-TCP server that bypasses `ws`'s
// auto-pong, which is overkill for the unit layer. The pong-deadline
// arm/disarm logic IS readable in ws-base.ts:227-244.

import * as net from 'net';
import { WebSocketServer } from 'ws';
import { BinanceSource, parsePositivePrice } from '../src/products/phoebe-sources';
import { buildPhoebeLeaves, type PhoebeFeedEntry } from '../src/worker/phoebe';
import type { PriceFeedManager } from '../src/products/phoebe-sources';

const NOOP_LOGGER = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

interface CapturedLogger {
    debug: jest.Mock;
    info: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
}

function captureLogger(): CapturedLogger {
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

describe('parsePositivePrice', () => {
    it('rejects zero and negative prices (Phoebe leaves are positive-by-spec)', () => {
        expect(parsePositivePrice('0')).toBeNull();
        expect(parsePositivePrice('0.0')).toBeNull();
        expect(parsePositivePrice('-5')).toBeNull(); // regex rejects sign
    });
    it('preserves trailing-zero precision', () => {
        expect(parsePositivePrice('6.500000')).toEqual({ mantissa: 6_500_000n, expo: -6 });
    });
});

describe('WsAdapterBase connect-timeout', () => {
    let listener: net.Server | null = null;
    let accepted: net.Socket[] = [];

    afterEach(async () => {
        // Destroy server-side sockets first — server.close() blocks
        // forever otherwise (it waits for every accepted connection
        // to close, and the client-side close on a half-upgraded
        // socket doesn't always propagate cleanly).
        for (const s of accepted) {
            s.destroy();
        }
        accepted = [];
        if (listener !== null) {
            await new Promise<void>((r) => listener!.close(() => r()));
            listener = null;
        }
    });

    it('force-closes a stalled TCP connection that never completes WS upgrade', async () => {
        listener = net.createServer((socket) => {
            // Accept TCP, never write the HTTP-upgrade response —
            // `ws` client hangs in the upgrade handshake; the
            // adapter's connect-timeout must fire.
            accepted.push(socket);
        });
        await new Promise<void>((r) => listener!.listen(0, '127.0.0.1', () => r()));
        const port = (listener.address() as net.AddressInfo).port;

        const logs = captureLogger();
        const src = new BinanceSource({
            logger: logs,
            urlOverride: `ws://127.0.0.1:${port}`,
            connectTimeoutMs: 150,
            initialBackoffMs: 60,
            maxBackoffMs: 60,
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        });
        await src.start(['TONUSDT'], () => undefined);

        await waitFor(
            () =>
                logs.warn.mock.calls.some((c) =>
                    String(c[0]).includes('force-close'),
                ) &&
                logs.warn.mock.calls.some((c) =>
                    String(c[0]).includes('reconnecting'),
                ),
            3_000,
        );
        const reasons = logs.warn.mock.calls
            .map((c) => c[1])
            .filter((f) => f !== undefined && f.reason !== undefined)
            .map((f) => f.reason);
        expect(reasons).toContain('connect-timeout');

        await src.stop();
    });
});

describe('WsAdapterBase silence-timeout', () => {
    it('force-reconnects when ws opens but server never sends anything', async () => {
        // ws server that accepts the upgrade and the SUBSCRIBE message
        // but never sends a single tick back. Our silence-timeout
        // should fire and the adapter should reconnect.
        const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
        const connections: number = await new Promise((resolveCount) => {
            let count = 0;
            wss.on('connection', () => {
                count += 1;
            });
            wss.on('listening', () => {
                const port = (wss.address() as net.AddressInfo).port;
                const logs = captureLogger();
                const src = new BinanceSource({
                    logger: logs,
                    urlOverride: `ws://127.0.0.1:${port}`,
                    silenceTimeoutMs: 150,
                    initialBackoffMs: 50,
                    maxBackoffMs: 50,
                    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
                });
                void src.start(['TONUSDT'], () => undefined).then(async () => {
                    // Wait for ≥2 connections (initial + after silence-timeout reconnect).
                    await waitFor(() => count >= 2, 3_000).catch(() => undefined);
                    await src.stop();
                    wss.close(() => resolveCount(count));
                });
            });
        });
        expect(connections).toBeGreaterThanOrEqual(2);
    });
});

describe('buildPhoebeLeaves (mixed feeds + drop semantics)', () => {
    it('mixes static + dynamic feeds; drops dynamic with no quorum', () => {
        const feeds: PhoebeFeedEntry[] = [
            { kind: 'static', feedId: 1, mantissa: 6_500_000n, expo: -6, confBps: 50 },
            {
                kind: 'dynamic',
                feedId: 2,
                cfg: {
                    feedId: 2,
                    sources: [{ name: 'binance', symbol: 'TONUSDT' }],
                    minSources: 1,
                },
            },
            {
                kind: 'dynamic',
                feedId: 3,
                cfg: {
                    feedId: 3,
                    sources: [{ name: 'binance', symbol: 'BTCUSDT' }],
                    minSources: 1,
                },
            },
        ];
        // Mock manager: feed 2 has quorum, feed 3 doesn't.
        const mgr = {
            aggregate: (cfg: { feedId: number }, _now: number): unknown => {
                if (cfg.feedId === 2) {
                    return {
                        mantissa: 6_400_000n,
                        expo: -6,
                        confBps: 25,
                        sourceCount: 1,
                        pubTimeMs: 1_700_000_000_000,
                    };
                }
                return null;
            },
        } as unknown as PriceFeedManager;
        const logs = captureLogger();
        const { leaves, droppedDynamic } = buildPhoebeLeaves(feeds, mgr, 1_700_000_000, logs);

        expect(droppedDynamic).toBe(1);
        expect(leaves.size).toBe(2);
        expect(leaves.get(1)).toEqual({
            feedId: 1,
            mantissa: 6_500_000n,
            expo: -6,
            confBps: 50,
            pubTime: 1_700_000_000,
        });
        expect(leaves.get(2)).toEqual({
            feedId: 2,
            mantissa: 6_400_000n,
            expo: -6,
            confBps: 25,
            pubTime: 1_700_000_000,
        });
        expect(leaves.get(3)).toBeUndefined();
        // The drop must be logged so operators can see why a feed is missing.
        expect(logs.warn).toHaveBeenCalledWith(
            expect.stringContaining('dropping dynamic feed'),
            expect.objectContaining({ feedId: 3 }),
        );
    });

    it('skips dynamic feeds defensively when priceManager is undefined', () => {
        const feeds: PhoebeFeedEntry[] = [
            {
                kind: 'dynamic',
                feedId: 9,
                cfg: { feedId: 9, sources: [{ name: 'binance', symbol: 'X' }] },
            },
        ];
        // PhoebeWorker's constructor would normally reject this combo, but
        // the helper itself must not crash if it's ever called this way.
        const { leaves, droppedDynamic } = buildPhoebeLeaves(feeds, undefined, 1_700_000_000);
        expect(leaves.size).toBe(0);
        expect(droppedDynamic).toBe(1);
    });

    it('handles a pure-static feed set with no manager', () => {
        const feeds: PhoebeFeedEntry[] = [
            { kind: 'static', feedId: 1, mantissa: 1n, expo: 0, confBps: 0 },
            { kind: 'static', feedId: 2, mantissa: 2n, expo: 0, confBps: 0 },
        ];
        const { leaves, droppedDynamic } = buildPhoebeLeaves(feeds, undefined, 1_700_000_000);
        expect(droppedDynamic).toBe(0);
        expect(leaves.size).toBe(2);
    });
});

// Touch the unused NOOP_LOGGER so the linter doesn't complain about
// dead import (kept around for future tests where a quiet logger is
// useful without the jest.fn() overhead).
void NOOP_LOGGER;
