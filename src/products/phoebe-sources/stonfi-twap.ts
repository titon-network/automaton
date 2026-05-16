// STON.fi TWAP — DEX-only fallback price source for TON-native pairs.
//
// Why this exists: every CEX adapter can be geo-blocked, deprecated, or
// have its symbol delisted with no warning. A pure on-chain source is
// the last-resort safety net for prices that the CEX layer can't
// hedge (specifically: stTON/TON, tsTON/TON, hTON/TON LST exchange
// rates that ONLY exist on-chain).
//
// v2 ships a *stub*: the adapter is the right shape (subscribes,
// reports ticks, supports isHealthy) but reads from a no-op fetcher.
// The full implementation lives in v2.1 once we wire the stonfi-sdk
// pool-reader. The shape is locked in now so v2 operators can opt in
// to the source with `sources: [{name: "stonfi-twap", symbol: ...}]`
// + get the manager warnings (insufficient sources) but not a working
// tick until v2.1 lands.
//
// The fetcher abstraction is intentional — production fetchers will
// poll pool reserves via FailoverTonClient + derive spot prices; the
// stub exists so we can test the polling lifecycle without TON RPC.

import type { PriceSource, SourceLogger, Tick, TickCallback } from './types';

/** Pool/symbol → fetched tick. Returning null means the source has no
 *  fresh data for that symbol this cycle (skipped). */
export type StonfiFetcher = (symbol: string) => Promise<Tick | null>;

export interface StonfiAdapterOpts {
    readonly logger: SourceLogger;
    /** Pool-fetch interval (ms). Default 5_000 — DEX prices update with
     *  each new block (~5s on TON), so polling faster is wasted. */
    readonly pollIntervalMs?: number;
    /** Per-symbol fetcher. Production wires the stonfi-sdk pool reader;
     *  tests inject a deterministic stub. Default = always returns null
     *  (stub mode — no ticks ever emitted). */
    readonly fetch?: StonfiFetcher;
    /** Injected clock — defaults to Date.now. */
    readonly nowMs?: () => number;
}

const DEFAULT_POLL_MS = 5_000;
const HEALTH_MAX_GAP_MS = 30_000;

export class StonfiTwapSource implements PriceSource {
    readonly name = 'stonfi-twap';

    private readonly logger: SourceLogger;
    private readonly pollIntervalMs: number;
    private readonly fetch: StonfiFetcher;
    private readonly nowMs: () => number;

    private symbols: readonly string[] = [];
    private emit: TickCallback = () => undefined;
    private timer: NodeJS.Timeout | null = null;
    private stopped = false;
    private lastTickMs = 0;

    constructor(opts: StonfiAdapterOpts) {
        this.logger = opts.logger;
        this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
        this.fetch = opts.fetch ?? (async () => null);
        this.nowMs = opts.nowMs ?? (() => Date.now());
    }

    async start(symbols: readonly string[], onTick: TickCallback): Promise<void> {
        if (this.timer !== null) {
            throw new Error(`${this.name}: start() called twice without stop()`);
        }
        this.symbols = symbols;
        this.emit = (symbol, tick) => {
            // Race guard: an in-flight pollOnce can land its emit
            // after stop() flips the flag — gate so it stays silent.
            if (this.stopped) return;
            this.lastTickMs = this.nowMs();
            onTick(symbol, tick);
        };
        this.stopped = false;
        this.logger.info('stonfi-twap: starting (stub — no fetcher wired)', {
            symbols,
            pollIntervalMs: this.pollIntervalMs,
        });
        // First poll fires immediately + schedules the next.
        await this.pollOnce();
        this.scheduleNext();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    isHealthy(): boolean {
        if (this.lastTickMs === 0) return false;
        return this.nowMs() - this.lastTickMs <= HEALTH_MAX_GAP_MS;
    }

    private scheduleNext(): void {
        if (this.stopped) return;
        this.timer = setTimeout(async () => {
            try {
                await this.pollOnce();
            } catch (err) {
                this.logger.warn('stonfi-twap: poll threw', {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            this.scheduleNext();
        }, this.pollIntervalMs);
    }

    private async pollOnce(): Promise<void> {
        const results = await Promise.all(
            this.symbols.map(async (sym) => {
                try {
                    const tick = await this.fetch(sym);
                    return tick === null ? null : { sym, tick };
                } catch (err) {
                    this.logger.warn('stonfi-twap: fetch failed', {
                        symbol: sym,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    return null;
                }
            }),
        );
        for (const r of results) {
            if (r !== null) this.emit(r.sym, r.tick);
        }
    }
}
