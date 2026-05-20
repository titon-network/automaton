// PriceFeedManager — pure aggregation logic + manager lifecycle.
//
// Adapter wire format is tested in tests/phoebe-source-adapter.spec.ts;
// this file pins:
//   - median across N sources
//   - confBps = half-spread / median × 10_000
//   - stale-tick exclusion (older than maxStaleMs)
//   - minSources gate (returns null when too few fresh)
//   - rescaling between native expo and target expo
//   - manager start() subscribes each source to the union of symbols
//     it's referenced by across all feeds
//   - manager throws on unknown source names in feed config
//
// All ticks flow through the legitimate `StubSource.push` → manager-
// supplied `onTick` callback path. Tests do NOT touch the manager's
// internal cache structure — refactoring the cache key format must
// stay invisible to the test surface.

import {
    PriceFeedManager,
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

/** Stub adapter — captures the manager-supplied onTick so the test
 *  can push ticks via the legitimate path. */
class StubSource implements PriceSource {
    readonly name: string;
    started = false;
    stopped = false;
    subscribedSymbols: string[] = [];
    private cb: TickCallback | null = null;
    constructor(name: string) {
        this.name = name;
    }
    async start(symbols: readonly string[], onTick: TickCallback): Promise<void> {
        this.started = true;
        this.subscribedSymbols = [...symbols];
        this.cb = onTick;
    }
    async stop(): Promise<void> {
        this.stopped = true;
    }
    isHealthy(): boolean {
        return this.started && !this.stopped;
    }
    push(symbol: string, tick: Tick): void {
        if (this.cb === null) throw new Error(`${this.name}: push before start`);
        this.cb(symbol, tick);
    }
}

interface Harness {
    mgr: PriceFeedManager;
    sources: Record<string, StubSource>;
}

async function harness(
    sourceNames: readonly string[],
    feeds: readonly FeedConfig[],
    nowMs: number,
): Promise<Harness> {
    const sources: Record<string, StubSource> = {};
    for (const n of sourceNames) sources[n] = new StubSource(n);
    const mgr = new PriceFeedManager({
        logger: NOOP_LOGGER,
        sources: Object.values(sources),
        feeds,
        nowMs: () => nowMs,
    });
    await mgr.start();
    return { mgr, sources };
}

describe('PriceFeedManager.aggregate (median + confBps)', () => {
    it('takes the median of three equal-expo ticks', async () => {
        const feed: FeedConfig = {
            feedId: 1,
            sources: [
                { name: 'binance', symbol: 'TONUSDT' },
                { name: 'coinbase', symbol: 'TON-USD' },
                { name: 'kraken', symbol: 'TON/USD' },
            ],
            expo: -6,
        };
        const h = await harness(['binance', 'coinbase', 'kraken'], [feed], 1_000_000);
        h.sources.binance!.push('TONUSDT', { mantissa: 6_400_000n, expo: -6, receivedAtMs: 999_000 });
        h.sources.coinbase!.push('TON-USD', { mantissa: 6_500_000n, expo: -6, receivedAtMs: 999_000 });
        h.sources.kraken!.push('TON/USD', { mantissa: 6_600_000n, expo: -6, receivedAtMs: 999_000 });

        const out = h.mgr.aggregate(feed);
        expect(out).not.toBeNull();
        expect(out!.mantissa).toBe(6_500_000n);
        expect(out!.expo).toBe(-6);
        expect(out!.sourceCount).toBe(3);
        // half-spread = (6.6 - 6.4) / 2 = 0.10 → /6.5 = 0.01538 → 153 bps
        expect(out!.confBps).toBe(153);
        await h.mgr.stop();
    });

    it('rescales ticks to a common target expo before median', async () => {
        const feed: FeedConfig = {
            feedId: 1,
            sources: [
                { name: 'a', symbol: 'x' },
                { name: 'b', symbol: 'x' },
            ],
            expo: -6,
            minSources: 2,
        };
        const h = await harness(['a', 'b'], [feed], 1_000_000);
        // a reports at -1 (coarse), b at -6 (fine) — manager rescales to -6.
        h.sources.a!.push('x', { mantissa: 65n, expo: -1, receivedAtMs: 999_000 });
        h.sources.b!.push('x', { mantissa: 6_500_000n, expo: -6, receivedAtMs: 999_000 });
        const out = h.mgr.aggregate(feed);
        expect(out!.mantissa).toBe(6_500_000n);
        expect(out!.expo).toBe(-6);
        expect(out!.confBps).toBe(0);
        await h.mgr.stop();
    });

    it('excludes stale ticks (older than maxStaleMs)', async () => {
        const feed: FeedConfig = {
            feedId: 1,
            sources: [
                { name: 'a', symbol: 'x' },
                { name: 'b', symbol: 'x' },
                { name: 'c', symbol: 'x' },
            ],
            expo: -6,
            maxStaleMs: 5_000,
            minSources: 2,
        };
        const h = await harness(['a', 'b', 'c'], [feed], 1_000_000);
        // a + b fresh (1s old); c stale (10s old at maxStaleMs=5s).
        h.sources.a!.push('x', { mantissa: 1_000_000n, expo: -6, receivedAtMs: 999_000 });
        h.sources.b!.push('x', { mantissa: 1_010_000n, expo: -6, receivedAtMs: 999_000 });
        h.sources.c!.push('x', { mantissa: 9_999_999n, expo: -6, receivedAtMs: 990_000 });
        const out = h.mgr.aggregate(feed);
        expect(out!.sourceCount).toBe(2);
        // even N=2 median = avg of 1_000_000, 1_010_000 = 1_005_000
        expect(out!.mantissa).toBe(1_005_000n);
        await h.mgr.stop();
    });

    it('returns null when minSources gate not met', async () => {
        const feed: FeedConfig = {
            feedId: 1,
            sources: [
                { name: 'a', symbol: 'x' },
                { name: 'b', symbol: 'x' },
            ],
            expo: -6,
            minSources: 2,
        };
        const h = await harness(['a', 'b'], [feed], 1_000_000);
        h.sources.a!.push('x', { mantissa: 1n, expo: -6, receivedAtMs: 999_000 });
        // Only one source has a tick → null.
        expect(h.mgr.aggregate(feed)).toBeNull();
        await h.mgr.stop();
    });

    it('defaults minSources to min(2, sources.length) when omitted', async () => {
        const feed: FeedConfig = {
            feedId: 1,
            sources: [{ name: 'only', symbol: 'x' }],
            expo: -6,
        };
        const h = await harness(['only'], [feed], 1_000_000);
        h.sources.only!.push('x', { mantissa: 5_000_000n, expo: -6, receivedAtMs: 999_000 });
        const out = h.mgr.aggregate(feed);
        expect(out).not.toBeNull();
        expect(out!.sourceCount).toBe(1);
        expect(out!.confBps).toBe(0);
        await h.mgr.stop();
    });

    it('caps confBps at 65_535 even with extreme spread', async () => {
        const feed: FeedConfig = {
            feedId: 1,
            sources: [
                { name: 'a', symbol: 'x' },
                { name: 'b', symbol: 'x' },
                { name: 'c', symbol: 'x' },
            ],
            expo: -6,
            minSources: 3,
        };
        const h = await harness(['a', 'b', 'c'], [feed], 1_000_000);
        h.sources.a!.push('x', { mantissa: 10n, expo: -6, receivedAtMs: 999_000 });
        h.sources.b!.push('x', { mantissa: 10n, expo: -6, receivedAtMs: 999_000 });
        h.sources.c!.push('x', { mantissa: 1_000_000_000n, expo: -6, receivedAtMs: 999_000 });
        const out = h.mgr.aggregate(feed);
        expect(out!.confBps).toBe(65_535);
        await h.mgr.stop();
    });
});

describe('PriceFeedManager.start (subscribe routing)', () => {
    it('subscribes each source to the union of symbols its feeds reference', async () => {
        const feedA: FeedConfig = {
            feedId: 1,
            sources: [
                { name: 'binance', symbol: 'TONUSDT' },
                { name: 'coinbase', symbol: 'TON-USD' },
            ],
        };
        const feedB: FeedConfig = {
            feedId: 2,
            sources: [{ name: 'binance', symbol: 'BTCUSDT' }],
        };
        const h = await harness(['binance', 'coinbase'], [feedA, feedB], 1_000_000);
        expect(h.sources.binance!.subscribedSymbols.sort()).toEqual(['BTCUSDT', 'TONUSDT']);
        expect(h.sources.coinbase!.subscribedSymbols).toEqual(['TON-USD']);
        await h.mgr.stop();
        expect(h.sources.binance!.stopped).toBe(true);
        expect(h.sources.coinbase!.stopped).toBe(true);
    });

    it('throws on unknown source names referenced by feeds', async () => {
        const binance = new StubSource('binance');
        const feed: FeedConfig = {
            feedId: 1,
            sources: [{ name: 'binance', symbol: 'TONUSDT' }, { name: 'kraken', symbol: 'TON/USD' }],
        };
        const mgr = new PriceFeedManager({
            logger: NOOP_LOGGER,
            sources: [binance],
            feeds: [feed],
        });
        await expect(mgr.start()).rejects.toThrow(/unknown price source\(s\): kraken/);
    });
});

describe('PriceFeedManager health snapshot', () => {
    it('reports per-source health after start', async () => {
        const feed: FeedConfig = {
            feedId: 1,
            sources: [{ name: 'a', symbol: 'x' }],
        };
        const h = await harness(['a'], [feed], 1_000_000);
        expect(h.mgr.healthSnapshot()).toEqual({ a: true });
        await h.mgr.stop();
        expect(h.mgr.healthSnapshot()).toEqual({ a: false });
    });
});
