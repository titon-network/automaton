// Phoebe price-source v2 — interface + types shared by every adapter.
//
// Design goal: every adapter is a thin shim over one exchange's public
// websocket feed. The adapter knows nothing about Phoebe, BLS, TON, or
// the worker — it just translates exchange-native tick messages into
// our normalised `Tick` shape and pushes them via the `onTick` callback
// supplied at start time.
//
// The PriceFeedManager owns the global cache (canonical symbol → source
// name → latest tick) and the aggregator that the PhoebeWorker calls
// each push window.
//
// Aggregator contract:
//   - Each Phoebe feed pins multiple sources (`{name, symbol}` per source).
//   - On each push window the worker calls `manager.aggregate(feed, now)`.
//   - The manager collects every source's latest tick for the configured
//     per-source symbol, drops stale ones (older than `maxStaleMs`),
//     normalises to a common exponent, takes the median mantissa, and
//     derives `confBps` from the half-spread of the contributing ticks.
//   - If fewer than `minSources` healthy ticks remain, returns null —
//     the feed is dropped from the snapshot rather than signed with stale
//     or single-source data.
//
// This file is dependency-free (pure types + interfaces) so adapter
// tests can import it without dragging in the worker / chain layer.

/** A normalised price tick from a single source for a single symbol. */
export interface Tick {
    /** Raw scaled integer. With `expo = -6` and `mantissa = 6_500_000n`
     *  the price is 6.5 (e.g. TON/USD). */
    readonly mantissa: bigint;
    /** Decimal exponent. Negative for sub-unit precision (typical). */
    readonly expo: number;
    /** Wall-clock receive time in ms. Used to age out stale ticks. */
    readonly receivedAtMs: number;
}

/** Logger surface used by every adapter / manager. Mirrors the worker
 *  loop's WorkerLogger to keep instantiation cheap in tests. */
export interface SourceLogger {
    trace?(msg: string, fields?: Record<string, unknown>): void;
    debug(msg: string, fields?: Record<string, unknown>): void;
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
}

/** A single price source — a websocket adapter for one exchange (or a
 *  poller for one DEX). Manager calls `start` once at boot with the
 *  full set of symbols the source must subscribe to; adapter calls
 *  `onTick` whenever a fresh price arrives. */
export interface PriceSource {
    readonly name: string;
    /** Subscribe to the requested symbols. Implementations should
     *  reconnect with exponential backoff on disconnect, re-subscribing
     *  every symbol on reconnect. `onTick(symbol, tick)` is called for
     *  every fresh tick on any subscribed symbol. Throws synchronously
     *  if configuration is invalid; transient connection failures must
     *  NOT throw (they're handled internally + surfaced via
     *  isHealthy()). */
    start(symbols: readonly string[], onTick: TickCallback): Promise<void>;
    /** Tear down the websocket cleanly. Idempotent. */
    stop(): Promise<void>;
    /** True iff we believe the source is delivering ticks right now.
     *  Used by the manager for per-source health metrics and by
     *  doctor checks. Implementation-defined heuristic — typically
     *  "ws connected AND last tick within ~30s". */
    isHealthy(): boolean;
}

export type TickCallback = (symbol: string, tick: Tick) => void;

/** Per-source binding inside a feed config — picks the source by name
 *  and tells it which exchange-native symbol to subscribe to. */
export interface FeedSourceBinding {
    /** Adapter name — one of the registered source names (`binance`,
     *  `coinbase`, `kraken`, `stonfi-twap`, ...). */
    readonly name: string;
    /** Exchange-native symbol. Each exchange uses its own convention
     *  (Binance "TONUSDT", Coinbase "TON-USD", Kraken "TON/USD") so we
     *  keep this explicit per-source instead of guessing. */
    readonly symbol: string;
}

/** Operator-facing feed definition. */
export interface FeedConfig {
    readonly feedId: number;
    /** Sources that contribute to this feed's aggregated price.
     *  At least one is required for the manager to even try. */
    readonly sources: readonly FeedSourceBinding[];
    /** Minimum number of fresh sources to accept before aggregating.
     *  Defaults to `min(2, sources.length)` — a single-source feed
     *  would otherwise risk one bad exchange moving the price. */
    readonly minSources?: number;
    /** Drop ticks older than this when aggregating. Defaults to 10_000
     *  (10 s) — short enough that a stuck websocket is excluded;
     *  long enough that a low-volume pair with sparse trades still
     *  contributes. */
    readonly maxStaleMs?: number;
    /** Target decimal exponent for the aggregated price. Defaults to
     *  -6. Adapters report ticks in their own native exponent;
     *  aggregator rescales every tick to this target before taking
     *  the median. */
    readonly expo?: number;
}

/** Result of aggregating one feed for one push window. */
export interface AggregatedTick {
    readonly mantissa: bigint;
    readonly expo: number;
    /** Half-spread in basis points across contributing sources.
     *  Capped at 65_535 (the PriceLeaf wire field's max). */
    readonly confBps: number;
    /** Number of sources whose ticks landed in the median. Logged for
     *  observability — see "thin liquidity" symptom in the README. */
    readonly sourceCount: number;
    /** Newest receivedAtMs of the contributing ticks. Used as
     *  PriceLeaf.pubTime so consumers can stale-check correctly. */
    readonly pubTimeMs: number;
}
