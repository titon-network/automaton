// CEX adapter parse + reconnect tests using a mock WebSocket server.
//
// We boot a real `ws` server on an ephemeral port, point the adapters
// at it via `urlOverride`, push exchange-shaped messages, and assert
// the adapter:
//   - subscribes correctly on open
//   - parses ticks into the normalised Tick shape
//   - reports isHealthy() once ticks flow
//   - reconnects with exponential backoff after a forced disconnect
//   - clean-shuts down via stop()

import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import {
    BinanceSource,
    CoinbaseSource,
    KrakenSource,
    parsePositivePrice,
} from '../src/products/phoebe-sources';

const NOOP_LOGGER = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

interface MockServer {
    url: string;
    sockets: ServerSocket[];
    subscribedMsgs: string[];
    close(): Promise<void>;
}

async function startMockServer(): Promise<MockServer> {
    return new Promise((resolve) => {
        const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
        const sockets: ServerSocket[] = [];
        const subscribedMsgs: string[] = [];
        wss.on('connection', (ws) => {
            sockets.push(ws);
            ws.on('message', (raw) => {
                subscribedMsgs.push(raw.toString());
            });
        });
        wss.on('listening', () => {
            const addr = wss.address();
            const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
            resolve({
                url: `ws://127.0.0.1:${port}`,
                sockets,
                subscribedMsgs,
                close: () =>
                    new Promise<void>((done) => {
                        for (const s of sockets) s.close();
                        wss.close(() => done());
                    }),
            });
        });
    });
}

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const tick = (): void => {
            if (predicate()) return resolve();
            if (Date.now() - start > timeoutMs) {
                return reject(new Error(`waitFor timeout after ${timeoutMs}ms`));
            }
            setTimeout(tick, 25);
        };
        tick();
    });
}

describe('parsePositivePrice', () => {
    it('parses positive integer', () => {
        expect(parsePositivePrice('42')).toEqual({ mantissa: 42n, expo: 0 });
    });
    it('parses simple decimal', () => {
        expect(parsePositivePrice('6.483')).toEqual({ mantissa: 6483n, expo: -3 });
    });
    it('preserves trailing zeros', () => {
        expect(parsePositivePrice('6.500000')).toEqual({ mantissa: 6500000n, expo: -6 });
    });
    it('rejects malformed and non-positive', () => {
        expect(parsePositivePrice('abc')).toBeNull();
        expect(parsePositivePrice('1.2.3')).toBeNull();
        expect(parsePositivePrice('')).toBeNull();
        // sign is now invalid (Phoebe leaves are positive-by-spec)
        expect(parsePositivePrice('-1')).toBeNull();
        expect(parsePositivePrice('0')).toBeNull();
    });
});

describe('BinanceSource', () => {
    let server: MockServer;
    beforeEach(async () => {
        server = await startMockServer();
    });
    afterEach(async () => {
        await server.close();
    });

    it('subscribes + parses trade ticks', async () => {
        const src = new BinanceSource({ logger: NOOP_LOGGER, urlOverride: server.url });
        const ticks: { symbol: string; mantissa: bigint; expo: number }[] = [];
        await src.start(['TONUSDT'], (symbol, tick) => {
            ticks.push({ symbol, mantissa: tick.mantissa, expo: tick.expo });
        });

        await waitFor(() => server.sockets.length > 0);
        await waitFor(() => server.subscribedMsgs.length > 0);
        const sub = JSON.parse(server.subscribedMsgs[0]!);
        expect(sub.method).toBe('SUBSCRIBE');
        expect(sub.params).toEqual(['tonusdt@trade']);

        // Push a trade event.
        server.sockets[0]!.send(
            JSON.stringify({ e: 'trade', s: 'TONUSDT', p: '6.483000', T: 1_700_000_000_000 }),
        );
        await waitFor(() => ticks.length === 1);
        expect(ticks[0]).toEqual({ symbol: 'TONUSDT', mantissa: 6_483_000n, expo: -6 });
        expect(src.isHealthy()).toBe(true);

        await src.stop();
    });

    it('ignores subscription acks + non-trade events', async () => {
        const src = new BinanceSource({ logger: NOOP_LOGGER, urlOverride: server.url });
        const ticks: unknown[] = [];
        await src.start(['TONUSDT'], (_s, t) => ticks.push(t));
        await waitFor(() => server.sockets.length > 0);
        server.sockets[0]!.send(JSON.stringify({ result: null, id: 1 })); // ack
        server.sockets[0]!.send(JSON.stringify({ e: 'kline', s: 'TONUSDT' })); // not trade
        // Hold a beat to let the parser run.
        await new Promise((r) => setTimeout(r, 100));
        expect(ticks).toHaveLength(0);
        await src.stop();
    });
});

describe('CoinbaseSource', () => {
    let server: MockServer;
    beforeEach(async () => {
        server = await startMockServer();
    });
    afterEach(async () => {
        await server.close();
    });

    it('subscribes + parses ticker channel', async () => {
        const src = new CoinbaseSource({ logger: NOOP_LOGGER, urlOverride: server.url });
        const ticks: { symbol: string; mantissa: bigint; expo: number }[] = [];
        await src.start(['TON-USD'], (symbol, tick) => {
            ticks.push({ symbol, mantissa: tick.mantissa, expo: tick.expo });
        });
        await waitFor(() => server.subscribedMsgs.length > 0);
        const sub = JSON.parse(server.subscribedMsgs[0]!);
        expect(sub.type).toBe('subscribe');
        expect(sub.channels).toEqual([{ name: 'ticker', product_ids: ['TON-USD'] }]);

        server.sockets[0]!.send(
            JSON.stringify({
                type: 'ticker',
                product_id: 'TON-USD',
                price: '5.234',
                time: '2025-05-01T00:00:00.000Z',
            }),
        );
        await waitFor(() => ticks.length === 1);
        expect(ticks[0]).toEqual({ symbol: 'TON-USD', mantissa: 5_234n, expo: -3 });
        await src.stop();
    });
});

describe('KrakenSource', () => {
    let server: MockServer;
    beforeEach(async () => {
        server = await startMockServer();
    });
    afterEach(async () => {
        await server.close();
    });

    it('subscribes + parses v2 ticker batch', async () => {
        const src = new KrakenSource({ logger: NOOP_LOGGER, urlOverride: server.url });
        const ticks: { symbol: string; mantissa: bigint; expo: number }[] = [];
        await src.start(['TON/USD', 'BTC/USD'], (symbol, tick) => {
            ticks.push({ symbol, mantissa: tick.mantissa, expo: tick.expo });
        });
        await waitFor(() => server.subscribedMsgs.length > 0);
        const sub = JSON.parse(server.subscribedMsgs[0]!);
        expect(sub.method).toBe('subscribe');
        expect(sub.params).toEqual({ channel: 'ticker', symbol: ['TON/USD', 'BTC/USD'] });

        server.sockets[0]!.send(
            JSON.stringify({
                channel: 'ticker',
                data: [
                    { symbol: 'TON/USD', last: 5.123 },
                    { symbol: 'BTC/USD', last: 65000.5 },
                ],
            }),
        );
        await waitFor(() => ticks.length === 2);
        expect(ticks.find((t) => t.symbol === 'TON/USD')!.mantissa).toBe(5_123n);
        expect(ticks.find((t) => t.symbol === 'TON/USD')!.expo).toBe(-3);
        await src.stop();
    });
});

describe('WsAdapterBase reconnect resilience', () => {
    it('reconnects after a forced server disconnect', async () => {
        const server = await startMockServer();
        const src = new BinanceSource({
            logger: NOOP_LOGGER,
            urlOverride: server.url,
            initialBackoffMs: 50,
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        });
        await src.start(['TONUSDT'], () => undefined);
        await waitFor(() => server.sockets.length === 1);

        // Force-close the only socket from the server side.
        server.sockets[0]!.close();

        // The adapter should reconnect → second socket lands.
        await waitFor(() => server.sockets.length === 2, 5_000);
        await src.stop();
        await server.close();
    });
});
