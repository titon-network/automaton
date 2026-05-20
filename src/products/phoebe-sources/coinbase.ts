// Coinbase Exchange (formerly GDAX / Coinbase Pro) public market-data
// adapter.
//
// API docs: https://docs.cdp.coinbase.com/exchange/docs/websocket-overview
//
// Subscription model: one connection to `wss://ws-feed.exchange.coinbase.com`
// with a `{type: "subscribe", channels: [{name: "ticker", product_ids: [...]}]}`
// message. Tick = `{type: "ticker", product_id: "TON-USD", price: "5.234"}`,
// one tick per book-top change (effectively per-trade for liquid pairs).
//
// Geo note: US-friendly, works everywhere except the handful of
// sanctioned jurisdictions.
//
// Symbol convention: Coinbase uses uppercase BASE-QUOTE form, e.g.
// `TON-USD`, `BTC-USD`. Passed through unchanged to the subscribe
// message.

import { WsAdapterBase, type WsAdapterOpts } from './ws-base';
import { parsePositivePrice } from './parse';
import type { TickCallback } from './types';

const COINBASE_WS_URL = 'wss://ws-feed.exchange.coinbase.com';

export interface CoinbaseAdapterOpts extends WsAdapterOpts {
    readonly urlOverride?: string;
}

export class CoinbaseSource extends WsAdapterBase {
    readonly name = 'coinbase';
    private readonly urlOverride?: string;

    constructor(opts: CoinbaseAdapterOpts) {
        super(opts);
        this.urlOverride = opts.urlOverride;
    }

    protected url(): string {
        return this.urlOverride ?? COINBASE_WS_URL;
    }

    /** Coinbase WS closes idle connections after ~60s. Send app-level
     *  pings every 15s — base class arms a pong deadline tied to each. */
    protected override pingIntervalMs(): number | null {
        return 15_000;
    }

    protected subscribeMessage(symbols: readonly string[]): string {
        return JSON.stringify({
            type: 'subscribe',
            channels: [{ name: 'ticker', product_ids: [...symbols] }],
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
        if (m.type !== 'ticker') return;
        const productId = m.product_id;
        const price = m.price;
        if (typeof productId !== 'string' || typeof price !== 'string') return;
        const parsed = parsePositivePrice(price);
        if (parsed === null) return;
        // Local clock for receivedAtMs (same reasoning as Binance) —
        // trusting server-supplied timestamps is a vector for
        // staleness-check bypass.
        emit(productId, {
            mantissa: parsed.mantissa,
            expo: parsed.expo,
            receivedAtMs: Date.now(),
        });
    }
}
