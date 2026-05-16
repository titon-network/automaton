// Kraken public market-data adapter.
//
// API docs: https://docs.kraken.com/websockets-v2/
//
// Subscription model: one connection to `wss://ws.kraken.com/v2` with a
// `{method: "subscribe", params: {channel: "ticker", symbol: [...]}}`
// message. Tick = `{channel: "ticker", data: [{symbol: "TON/USD",
// last: 5.234, ...}]}` — emits on every book-top change.
//
// Geo note: US-friendly; comprehensive coverage including most
// TON-ecosystem pairs.
//
// Symbol convention: Kraken v2 uses `BASE/QUOTE` with slash, e.g.
// `TON/USD`, `BTC/USD`. (Note: Kraken's REST sometimes uses internal
// codes like `XXBTZUSD` for BTC/USD; the v2 ws API takes the friendly
// `BTC/USD` form, which is what we want.) Passed through unchanged.
//
// Heartbeat: Kraken requires server-side activity; the v2 channel
// includes a `heartbeat` message every second when idle. We rely on
// that as activity-keepalive rather than sending app-level pings.

import { WsAdapterBase, type WsAdapterOpts } from './ws-base';
import { parsePositivePrice } from './parse';
import type { TickCallback } from './types';

const KRAKEN_WS_URL = 'wss://ws.kraken.com/v2';

export interface KrakenAdapterOpts extends WsAdapterOpts {
    readonly urlOverride?: string;
}

export class KrakenSource extends WsAdapterBase {
    readonly name = 'kraken';
    private readonly urlOverride?: string;

    constructor(opts: KrakenAdapterOpts) {
        super(opts);
        this.urlOverride = opts.urlOverride;
    }

    protected url(): string {
        return this.urlOverride ?? KRAKEN_WS_URL;
    }

    protected subscribeMessage(symbols: readonly string[]): string {
        return JSON.stringify({
            method: 'subscribe',
            params: { channel: 'ticker', symbol: [...symbols] },
        });
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
        if (m.channel !== 'ticker') return;
        const data = m.data;
        if (!Array.isArray(data)) return;
        for (const entry of data) {
            if (entry === null || typeof entry !== 'object') continue;
            const e = entry as Record<string, unknown>;
            const symbol = e.symbol;
            const last = e.last;
            if (typeof symbol !== 'string') continue;
            // Kraken sends `last` as a number in v2 (e.g. `5.234`).
            // Convert via string round-trip to preserve precision —
            // `Number.prototype.toString` for small decimals is
            // lossless for the magnitudes we care about (< 1e9), and
            // parsePositivePrice handles the trailing-zero edge cases.
            let priceStr: string | null = null;
            if (typeof last === 'number' && Number.isFinite(last)) {
                priceStr = last.toString();
            } else if (typeof last === 'string') {
                priceStr = last;
            }
            if (priceStr === null) continue;
            const parsed = parsePositivePrice(priceStr);
            if (parsed === null) continue;
            emit(symbol, {
                mantissa: parsed.mantissa,
                expo: parsed.expo,
                receivedAtMs: Date.now(),
            });
        }
    }
}
