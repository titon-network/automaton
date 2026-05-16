// PriceFeedManager — owns the global latest-tick cache + aggregator.
//
// Lifecycle:
//   const mgr = new PriceFeedManager({ feeds, sources, logger });
//   await mgr.start();      // subscribes every source to every required symbol
//   ...
//   const tick = mgr.aggregate(feed, nowMs);   // per push window
//   ...
//   await mgr.stop();       // tears down every websocket
//
// The manager is the single point of contact for the worker. The worker
// doesn't know about adapters, websockets, or symbols — it just calls
// aggregate() per feed per window.
//
// Aggregation:
//   1. Per source listed in feed.sources: look up latest tick for that
//      source+symbol from the in-memory cache.
//   2. Drop ticks older than maxStaleMs (default 10s).
//   3. If fewer than minSources remain, return null — operator's
//      worker drops the feed from the snapshot rather than signing
//      stale data.
//   4. Normalise each tick to the target expo (default -6) by integer
//      rescaling: a tick with `expo=-8, mantissa=650000000` becomes
//      `expo=-6, mantissa=6500000`.
//   5. Sort mantissas ascending; pick the median. (Odd N = middle; even
//      N = average of two middles, rounded toward zero.)
//   6. confBps = (max - min) / 2 / median * 10_000, capped at 65_535.
//   7. pubTimeMs = newest receivedAtMs of contributing ticks.
//
// Why median, not mean: a single source spitting a 0 or a 10x outlier
// can't move the median past one position. With 3+ sources the median
// stays correct even if one source is fully broken.
//
// confBps as a half-spread: the standard Pyth-style interpretation —
// "consumers can trust the price to ±confBps". A tight market (all
// sources within 5 bps) yields confBps ≈ 2; a thin market or partial
// outage widens it, and consumers can refuse to trade above their
// risk threshold.

import type { AggregatedTick, FeedConfig, PriceSource, SourceLogger, Tick } from './types';

const DEFAULT_MAX_STALE_MS = 10_000;
const DEFAULT_TARGET_EXPO = -6;
const MAX_CONF_BPS = 65_535;
/** Cap the rescale shift so a hostile source claiming `expo=-128` can't
 *  force `10n ** 122n` (a 123-digit BigInt) per tick. Real adapters
 *  emit -2 to -10; 24 is far past what's needed and bounds the work. */
const MAX_RESCALE_SHIFT = 24;

interface ManagerOpts {
    readonly logger: SourceLogger;
    /** Adapters keyed by name — the manager calls start/stop on each
     *  and routes their callbacks into the cache. */
    readonly sources: readonly PriceSource[];
    /** Feeds the worker will aggregate. Used at start time to compute
     *  the per-source subscription list. */
    readonly feeds: readonly FeedConfig[];
    /** Injected clock — defaults to `Date.now()`. */
    readonly nowMs?: () => number;
}

/** Cache key shape: `${sourceName}|${symbol}`. */
function cacheKey(sourceName: string, symbol: string): string {
    return `${sourceName}|${symbol}`;
}

/** Rescale `(mantissa, expo)` to `targetExpo`. Lossless when the
 *  target has equal or finer precision; loses precision (integer
 *  divide, banker's rounding NOT applied — straight truncation) when
 *  the target is coarser. The aggregator picks targetExpo such that
 *  it's at least as fine as every source's native expo, so rescaling
 *  is always lossless in practice. */
function rescale(mantissa: bigint, expo: number, targetExpo: number): bigint | null {
    if (expo === targetExpo) return mantissa;
    if (targetExpo < expo) {
        // Target is finer (more decimal places) — multiply.
        const shift = expo - targetExpo;
        if (shift > MAX_RESCALE_SHIFT) return null;
        return mantissa * 10n ** BigInt(shift);
    }
    // Target is coarser — divide. Rare in practice; keep simple integer truncate.
    const shift = targetExpo - expo;
    if (shift > MAX_RESCALE_SHIFT) return null;
    return mantissa / 10n ** BigInt(shift);
}

export class PriceFeedManager {
    private readonly logger: SourceLogger;
    private readonly sources: Map<string, PriceSource>;
    private readonly feeds: readonly FeedConfig[];
    private readonly nowMs: () => number;
    /** symbol → source → latest tick. Keyed by `${sourceName}|${symbol}`. */
    private readonly cache = new Map<string, Tick>();
    private started = false;

    constructor(opts: ManagerOpts) {
        this.logger = opts.logger;
        this.sources = new Map(opts.sources.map((s) => [s.name, s]));
        this.feeds = opts.feeds;
        this.nowMs = opts.nowMs ?? (() => Date.now());
    }

    /** Subscribe every named source to every symbol the feeds need
     *  from it. Idempotent — second call is a no-op. */
    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;

        // Group symbols by source so we make ONE subscription call per
        // source covering all the symbols it needs.
        const symbolsBySource = new Map<string, Set<string>>();
        const missingSources = new Set<string>();
        for (const feed of this.feeds) {
            for (const binding of feed.sources) {
                if (!this.sources.has(binding.name)) {
                    missingSources.add(binding.name);
                    continue;
                }
                if (!symbolsBySource.has(binding.name)) {
                    symbolsBySource.set(binding.name, new Set());
                }
                symbolsBySource.get(binding.name)!.add(binding.symbol);
            }
        }

        if (missingSources.size > 0) {
            // Hard-fail rather than silently dropping. An operator who
            // listed a typo'd source name needs the loud error.
            throw new Error(
                `feeds reference unknown price source(s): ${[...missingSources].join(', ')}. ` +
                    `Known sources: ${[...this.sources.keys()].join(', ')}`,
            );
        }

        const startPromises: Promise<void>[] = [];
        for (const [sourceName, symbols] of symbolsBySource) {
            const source = this.sources.get(sourceName)!;
            const symList = [...symbols];
            this.logger.info('price-source: subscribing', {
                source: sourceName,
                symbols: symList,
            });
            startPromises.push(
                source.start(symList, (symbol, tick) => {
                    this.cache.set(cacheKey(sourceName, symbol), tick);
                }),
            );
        }
        await Promise.all(startPromises);
    }

    async stop(): Promise<void> {
        if (!this.started) return;
        this.started = false;
        const stops: Promise<void>[] = [];
        for (const source of this.sources.values()) {
            stops.push(source.stop().catch((err) => {
                this.logger.warn('price-source: stop threw', {
                    source: source.name,
                    error: err instanceof Error ? err.message : String(err),
                });
            }));
        }
        await Promise.all(stops);
        this.cache.clear();
    }

    /** Health snapshot — `{sourceName: healthy?}`. Used by doctor /
     *  /readyz to surface a per-source view. */
    healthSnapshot(): Record<string, boolean> {
        const out: Record<string, boolean> = {};
        for (const [name, source] of this.sources) {
            out[name] = source.isHealthy();
        }
        return out;
    }

    /** Aggregate one feed for one push window. Returns null if not
     *  enough fresh sources have a tick to meet `minSources`. */
    aggregate(feed: FeedConfig, nowMs?: number): AggregatedTick | null {
        const now = nowMs ?? this.nowMs();
        const maxStaleMs = feed.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
        const targetExpo = feed.expo ?? DEFAULT_TARGET_EXPO;
        const minSources = feed.minSources ?? Math.min(2, feed.sources.length);

        // 1. Collect latest fresh tick per source.
        const fresh: { mantissa: bigint; receivedAtMs: number; source: string }[] = [];
        for (const binding of feed.sources) {
            const tick = this.cache.get(cacheKey(binding.name, binding.symbol));
            if (tick === undefined) continue;
            if (now - tick.receivedAtMs > maxStaleMs) continue;
            const rescaled = rescale(tick.mantissa, tick.expo, targetExpo);
            if (rescaled === null) {
                // Rescale shift exceeded the cap (hostile expo) — skip.
                this.logger.warn('feed: rescale-shift cap hit, dropping tick', {
                    feedId: feed.feedId,
                    source: binding.name,
                    sourceExpo: tick.expo,
                    targetExpo,
                });
                continue;
            }
            fresh.push({
                mantissa: rescaled,
                receivedAtMs: tick.receivedAtMs,
                source: binding.name,
            });
        }

        // 2. Gate on minSources.
        if (fresh.length < minSources) {
            this.logger.debug('feed: insufficient sources, dropping', {
                feedId: feed.feedId,
                have: fresh.length,
                need: minSources,
            });
            return null;
        }

        // 3. Median.
        fresh.sort((a, b) => (a.mantissa < b.mantissa ? -1 : a.mantissa > b.mantissa ? 1 : 0));
        const n = fresh.length;
        const median =
            n % 2 === 1
                ? fresh[(n - 1) / 2]!.mantissa
                : (fresh[n / 2 - 1]!.mantissa + fresh[n / 2]!.mantissa) / 2n;

        // 4. confBps from half-spread. Guard against median == 0
        //    (shouldn't happen with real markets but a paranoid check
        //    prevents a div-by-zero crash if it ever does).
        let confBps = 0;
        if (median !== 0n) {
            const lo = fresh[0]!.mantissa;
            const hi = fresh[n - 1]!.mantissa;
            const halfSpread = (hi - lo) / 2n;
            // bps = halfSpread / median * 10_000 (integer math).
            const bpsBig = (halfSpread * 10_000n) / (median < 0n ? -median : median);
            confBps = Number(bpsBig > BigInt(MAX_CONF_BPS) ? BigInt(MAX_CONF_BPS) : bpsBig);
        }

        // 5. pubTime = newest receivedAtMs.
        let newest = 0;
        for (const t of fresh) {
            if (t.receivedAtMs > newest) newest = t.receivedAtMs;
        }

        return {
            mantissa: median,
            expo: targetExpo,
            confBps,
            sourceCount: n,
            pubTimeMs: newest,
        };
    }
}
