// Barrel + adapter registry for Phoebe price sources.
//
// The registry is what `src/products/phoebe.ts::bootstrapWorker` walks
// to instantiate the set of adapters the operator's config actually
// references. The registry exists so the worker doesn't construct
// adapters the operator hasn't opted into — a US-based operator
// who doesn't list `binance` in any feed pays zero CPU/network cost
// for that adapter.

import { BinanceSource } from './binance';
import { CoinbaseSource } from './coinbase';
import { KrakenSource } from './kraken';
import { StonfiTwapSource } from './stonfi-twap';
import type { PriceSource, SourceLogger } from './types';

export * from './types';
export { PriceFeedManager } from './manager';
export { WsAdapterBase, type WsAdapterOpts } from './ws-base';
// Note: `setWsCtor` is NOT re-exported here — it's a test seam only.
// Tests import it directly from './ws-base' or via the internal path.
// Keeping it out of the public barrel prevents plugin code from
// monkey-patching the websocket constructor in production.
export { BinanceSource } from './binance';
export { parsePositivePrice } from './parse';
export { CoinbaseSource };
export { KrakenSource };
export { StonfiTwapSource, type StonfiAdapterOpts, type StonfiFetcher } from './stonfi-twap';

/** Adapter factories keyed by stable name. */
const ADAPTER_FACTORIES: Record<string, (logger: SourceLogger) => PriceSource> = {
    binance: (logger) => new BinanceSource({ logger }),
    coinbase: (logger) => new CoinbaseSource({ logger }),
    kraken: (logger) => new KrakenSource({ logger }),
    'stonfi-twap': (logger) => new StonfiTwapSource({ logger }),
};

/** Build only the adapters the operator's feeds actually reference.
 *  `enabled` is the union of every `source.name` across `feeds[]`. */
export function buildAdapters(enabled: Iterable<string>, logger: SourceLogger): PriceSource[] {
    const seen = new Set<string>();
    const out: PriceSource[] = [];
    for (const name of enabled) {
        if (seen.has(name)) continue;
        seen.add(name);
        const factory = ADAPTER_FACTORIES[name];
        if (factory === undefined) {
            throw new Error(
                `unknown price source "${name}". Known: ${Object.keys(ADAPTER_FACTORIES).join(', ')}`,
            );
        }
        out.push(factory(logger));
    }
    return out;
}

/** Stable list of every adapter name we ship — surfaced for `automaton
 *  doctor` and config-schema validation. */
export const KNOWN_SOURCE_NAMES = Object.freeze(Object.keys(ADAPTER_FACTORIES));
