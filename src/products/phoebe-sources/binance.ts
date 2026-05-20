// Binance public market-data adapter.
//
// API docs: https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md
//
// Subscription model: one connection to `wss://stream.binance.com:9443/ws`
// with a single SUBSCRIBE message naming every `<symbol>@trade` channel
// we need. Tick = aggregated trade event (`e: "trade"`), one tick per
// trade fill on that symbol. Prices arrive as decimal strings like
// "6.483000" — we parse to (mantissa, expo) by counting decimal places.
//
// Geo note: api.binance.com / stream.binance.com are blocked from US
// IPs. Operators in us-east-1 either skip this source or configure
// `binance.us` via the `urlOverride` knob below — but `binance.us`
// has its own symbol list and rate limits, so it's better treated as
// a different adapter than a config knob. Out of scope for v2 — US
// operators just don't list `binance` in their feeds[] sources.
//
// Symbol convention: Binance uses uppercase concatenated tickers
// without separators, e.g. `TONUSDT`. The subscribe stream name is
// lowercase though, so we lowercase here.

import { WsAdapterBase, type WsAdapterOpts } from './ws-base';
import { parsePositivePrice } from './parse';
import type { TickCallback } from './types';

const BINANCE_WS_URL = 'wss://stream.binance.com:9443/ws';

export interface BinanceAdapterOpts extends WsAdapterOpts {
    /** Override the WS URL — leave unset for production. Tests inject
     *  the mock-server URL here. */
    readonly urlOverride?: string;
}

export class BinanceSource extends WsAdapterBase {
    readonly name = 'binance';
    private readonly urlOverride?: string;

    constructor(opts: BinanceAdapterOpts) {
        super(opts);
        this.urlOverride = opts.urlOverride;
    }

    protected url(): string {
        return this.urlOverride ?? BINANCE_WS_URL;
    }

    protected subscribeMessage(symbols: readonly string[]): string {
        // Binance's `SUBSCRIBE` payload is the same shape every time —
        // we hardcode the trade stream suffix per symbol.
        const params = symbols.map((s) => `${s.toLowerCase()}@trade`);
        return JSON.stringify({ method: 'SUBSCRIBE', params, id: 1 });
    }

    protected handleMessage(raw: string, emit: TickCallback): void {
        let msg: unknown;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }
        if (msg === null || typeof msg !== 'object') return;
        const m = msg as Record<string, unknown>;
        // Subscribe ack: `{result: null, id: 1}`. No event field.
        if (typeof m.e !== 'string') return;
        if (m.e !== 'trade') return;
        const symbolRaw = m.s;
        const priceStr = m.p;
        if (typeof symbolRaw !== 'string' || typeof priceStr !== 'string') return;
        const parsed = parsePositivePrice(priceStr);
        if (parsed === null) return;
        // Use local clock for receivedAtMs — trusting server-supplied
        // timestamps is a vector for staleness-check bypass (a hostile
        // server could set T far in the future so the tick never falls
        // out of maxStaleMs, OR far in the past so it's always
        // dropped). Local-clock receive time is the honest signal for
        // "have we seen fresh data from this source recently?"
        emit(symbolRaw, {
            mantissa: parsed.mantissa,
            expo: parsed.expo,
            receivedAtMs: Date.now(),
        });
    }
}
