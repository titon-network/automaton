// Single source of truth for config shape. Types derive from the zod schema
// via `z.infer`, so there's no risk of the runtime validator and the static
// type drifting apart.
//
// Every field has a sensible default (see `defaultConfig`) so `automaton init`
// can emit a working config without interrogating the user for every knob.

import { z } from 'zod';
import { KNOWN_SOURCE_NAMES } from '../products/phoebe-sources';

// Bump when ANY field is added/removed/renamed, or when a field's semantics
// change. Loaders reject configs that don't match — same schema-versioning
// discipline as the on-chain storage structs.
export const CONFIG_VERSION = 1;

export const NETWORKS = ['testnet', 'mainnet'] as const;
export const NetworkSchema = z.enum(NETWORKS);
export type Network = z.infer<typeof NetworkSchema>;

export const EndpointSchema = z.object({
    url: z.string().url(),
    apiKey: z.string().optional(),
});

export type Endpoint = z.infer<typeof EndpointSchema>;

// TON amounts are stored as decimal strings (e.g. "0.5"). Users edit the JSON
// file directly, so human-readable beats nanoton bigint. Call sites convert
// with `toNano(...)` from @ton/core.
const TonAmount = z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'must be a decimal TON amount (e.g. "0.5")');

export const LogLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

/**
 * Hard refusal: webhook URL must be http(s), and the host must not be a
 * cloud-metadata link-local address. Catches the SSRF foot-gun where a
 * typo or a malicious config redirects slash alerts to AWS / GCP /
 * Azure / Alibaba metadata services. Hostnames pass — we don't resolve
 * (DNS rebinding is out of scope; if you can rewrite an operator's DNS
 * you have bigger problems). RFC1918 / loopback are allowed (operators
 * legitimately POST to internal alerting like Alertmanager on localhost).
 *
 * Blocked hosts:
 *   - 169.254.0.0/16  — AWS / GCP / Azure / OCI IMDS link-local
 *   - 100.100.100.200 — Alibaba Cloud metadata
 *   - fe80::/10       — IPv6 link-local
 *   - ::ffff:169.254.0.0/16 — IPv4-mapped IPv6 form of AWS/etc IMDS
 *   - ::ffff:100.100.100.200 — IPv4-mapped IPv6 form of Alibaba metadata
 */
function isBlockedHost(host: string): boolean {
    const lower = host.toLowerCase();
    // Link-local IPv4: 169.254.0.0/16 — covers AWS / GCP / Azure / OCI IMDS.
    if (/^169\.254\./.test(lower)) return true;
    // Alibaba Cloud metadata.
    if (lower === '100.100.100.200') return true;
    // Link-local IPv6: fe80::/10 (canonical 4-char-segment forms; the
    // /10 prefix means hex range fe80–febf in the first segment).
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
    // IPv4-mapped IPv6 (`::ffff:a.b.c.d` or `::ffff:abcd:abcd`). The
    // dual-stack TCP behavior treats the embedded IPv4 as the real
    // destination — checking the wrapper alone leaves the bypass open.
    const v4MappedDot = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(lower);
    if (v4MappedDot !== null) return isBlockedHost(v4MappedDot[1]!);
    const v4MappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(lower);
    if (v4MappedHex !== null) {
        const hi = parseInt(v4MappedHex[1]!, 16);
        const lo = parseInt(v4MappedHex[2]!, 16);
        const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isBlockedHost(dotted);
    }
    return false;
}

function isAllowedWebhookUrl(raw: string): boolean {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return false;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    // Node's URL.hostname keeps the brackets on IPv6 literals (per WHATWG
    // URL spec). Strip them so the cloud-metadata regexes match both forms.
    const host = u.hostname.replace(/^\[|\]$/g, '');
    return !isBlockedHost(host);
}

export const ConfigSchema = z.object({
    configVersion: z.literal(CONFIG_VERSION),
    network: NetworkSchema,
    endpoints: z.array(EndpointSchema).min(1, 'at least one endpoint is required'),
    walletVersion: z.enum(['v5r1']),
    metricsPort: z.number().int().positive().max(65535),
    // 127.0.0.1 keeps metrics + health endpoints local by default. Docker
    // operators publishing the port with `-p 9090:9090` need to flip this
    // to '0.0.0.0' (or the container IP); systemd operators typically
    // keep 127.0.0.1 + front with a reverse proxy for TLS / auth.
    metricsHost: z.string().min(1),
    // Bounded so a hand-edited config can't accidentally hammer the RPC
    // (1 s floor → ~1 req/s on toncenter public; below that you'll get
    // 429'd) or stall the daemon for 24h+ at the upper end. 1h is more
    // than enough headroom for "daemon polls slowly while testing".
    pollIntervalMs: z.number().int().min(1000).max(3_600_000),
    // How often the daemon refreshes operator-state gauges (wallet
    // balance, stake, drift counters). Pool state drifts slowly; 6 ×
    // pollIntervalMs (~60 s at the default 10 s tick) is plenty for
    // Grafana alerting AND keeps toncenter-public inside its 1 req/s
    // budget. Set to 1 to snapshot every tick.
    gaugeSnapshotEveryNTicks: z.number().int().positive().max(10_000),
    alertWebhookUrl: z
        .string()
        .url()
        .refine(isAllowedWebhookUrl, {
            message:
                'webhook URL must be http(s) and must not target a cloud-metadata ' +
                'link-local address (169.254.* / fe80:*) — see SSRF guard',
        })
        .optional(),
    maxGasPerExecute: TonAmount,
    minFreeBalance: TonAmount,
    logLevel: LogLevelSchema,
    // Per-consumer-product enable flags. The automaton is shared across all
    // ForgeTON-admitted consumers — each product adds its own event decoder,
    // worker cycle, and schema-version pin. The binary is universal: any
    // admitted consumer can be wired in here with a config flag + a deployment
    // block below. `buildChainRuntime` enforces per-product shape at load time
    // so a stale config doesn't silently skip a product.
    products: z.object({
        kronos: z.boolean(),
        fortuna: z.boolean(),
        // `.default(false)` keeps v1 config files (which predate themis)
        // round-tripping cleanly through the schema — they parse with
        // `themis: false` filled in. New configs from `automaton init`
        // (or `defaultConfig`) write the explicit field.
        themis: z.boolean().default(false),
        // Same `.default(false)` round-trip discipline for phoebe.
        phoebe: z.boolean().default(false),
    }),
    // Optional per-product deployment overrides. Required when the SDK's
    // own deployment constant is null (pre-testnet) AND the corresponding
    // product flag is on. Parsed as raw address strings here so the
    // consumer (`resolveDeployment` in chain/deployment.ts) can produce a
    // single actionable error if the address is malformed or missing.
    fortuna: z
        .object({
            atlasAddress: z.string().optional(),
            fortunaAddress: z.string().optional(),

            // Multi-op share-exchange config (phase 1 schema; phase 2
            // implements the runtime). Defaults preserve solo-mode
            // behavior bit-for-bit: `peers` empty + the daemon takes the
            // existing fast-path that skips peer exchange.
            //
            // Each peer is one OTHER operator in the threshold-BLS group.
            // address  — peer's wallet (UQ-form), used to look up their
            //            pkShare in Atlas + to identify them in the
            //            share-exchange protocol.
            // endpoint — http(s) URL the peer's daemon serves
            //            POST /fortuna/v1/share at.
            peers: z
                .array(
                    z.object({
                        address: z.string(),
                        endpoint: z.string().url(),
                    }),
                )
                .optional(),
            // HTTP server bind for inbound peer share-exchange POSTs.
            // Phase-2 default (when present): 9091 / 127.0.0.1.
            // Operators front the surface with a reverse proxy or bind
            // 0.0.0.0 explicitly when they want public reach.
            shareExchangePort: z.number().int().min(1).max(65535).optional(),
            shareExchangeHost: z.string().optional(),
            // Non-leader grace period before falling back to submitting
            // the aggregate ourselves. Default (when present): 30s.
            leaderGraceSec: z.number().int().min(5).max(300).optional(),
        })
        .optional(),
    // Themis sealed-bid threshold-decryption config. Required when
    // products.themis is true.
    //
    //   atlasAddress, forgetonAddress, factoryAddress — pre-launch overrides;
    //     the SDK's THEMIS_TESTNET / THEMIS_MAINNET fall back when null.
    //   chambers — list of chamber addresses this operator serves. Themis
    //     is parent-child: one factory deploys many chambers (one per
    //     consumer protocol). The operator opts into specific chambers
    //     here. Auto-discovery (via factory's ChamberDeployed events) is
    //     a v1.1 extension; v1 keeps the surface explicit so an operator
    //     knows exactly which chambers they're earning fees + bearing
    //     reveal liability for.
    themis: z
        .object({
            atlasAddress: z.string().optional(),
            forgetonAddress: z.string().optional(),
            factoryAddress: z.string().optional(),
            chambers: z
                .array(z.string())
                .optional(),
        })
        .optional(),
    // Phoebe price-oracle config. Required when products.phoebe is true.
    //
    //   atlasAddress, phoebeAddress — pre-launch overrides; the SDK's
    //     ATLAS_TESTNET / PHOEBE_TESTNET (and mainnet equivalents) fall
    //     back when null.
    //   pushIntervalMs — heartbeat cadence for snapshot pushes. Default
    //     30000 (30s) — matches contract's typical `maxPushDrift`. Below
    //     this means wasted gas; above this means stale roots get
    //     accepted by consumers requesting at-most `maxPushDrift` old.
    //   feeds — static price feeds the operator publishes. v1 has no
    //     pluggable price sources — operators hand-set values + bump them
    //     via config edits. v1.1 adds a `PriceSource` interface for HTTP
    //     adapters. Empty / undefined = worker is a no-op (heartbeat
    //     skipped; logs at debug level once per tick).
    //   peers — multi-op share-exchange peers (mirrors fortuna.peers).
    //     Empty / undefined = solo-mode fast path. Populated = leader
    //     proposes (timestamp, root), peers verify drift + sign their
    //     partial, leader aggregates and submits. See
    //     ../daemon/share-exchange-phoebe.ts.
    //   shareExchangePort — inbound POST /phoebe/v1/share bind. Default
    //     9092 (fortuna uses 9091; avoid collision when both products
    //     run on the same host).
    phoebe: z
        .object({
            atlasAddress: z.string().optional(),
            phoebeAddress: z.string().optional(),
            // Push cadence. Floor 5s (anything below is gas waste; the
            // contract bounces if pushed too often anyway). Ceiling 1h —
            // consumers requesting price with default `maxStaleness` will
            // start failing well before that, but it's still inside the
            // contract's `maxPushDrift` upper bound.
            pushIntervalMs: z
                .number()
                .int()
                .min(5_000)
                .max(3_600_000)
                .default(30_000),
            // Price feeds — accepts EITHER static form (legacy / dev /
            // testnet) or dynamic form (production v2):
            //
            //   Static — operator hand-sets values. Mantissa is a
            //   decimal string (zod coerces for JSON readability —
            //   bigint isn't a JSON primitive). expo + confBps follow
            //   phoebe's PriceLeaf wire shape.
            //     { feedId, mantissa, expo, confBps }
            //
            //   Dynamic — aggregator pulls live prices from CEX/DEX
            //   sources. Each entry pins a list of `{name, symbol}` —
            //   adapter name from the registry (`binance`, `coinbase`,
            //   `kraken`, `stonfi-twap`) + exchange-native symbol
            //   (Binance "TONUSDT", Coinbase "TON-USD", Kraken "TON/USD").
            //   The aggregator takes the median across fresh ticks per
            //   push window, with half-spread → confBps. See
            //   `src/products/phoebe-sources/manager.ts` for the
            //   median + stale-tick + minSources logic.
            //     { feedId, sources: [{name, symbol}, ...],
            //       minSources?, maxStaleMs?, expo? }
            feeds: z
                .array(
                    z.union([
                        z.object({
                            feedId: z.number().int().min(0).max(255),
                            mantissa: z
                                .string()
                                .regex(/^-?\d+$/, 'must be a decimal integer string'),
                            expo: z.number().int().min(-128).max(127),
                            confBps: z.number().int().min(0).max(65_535),
                        }),
                        z.object({
                            feedId: z.number().int().min(0).max(255),
                            sources: z
                                .array(
                                    z.object({
                                        // Constrained to the names the
                                        // adapter registry actually knows
                                        // about — typos like "binance-us"
                                        // fail at config-load instead of
                                        // 30 min into running daemon.
                                        name: z
                                            .string()
                                            .refine(
                                                (n) =>
                                                    (
                                                        KNOWN_SOURCE_NAMES as readonly string[]
                                                    ).includes(n),
                                                {
                                                    message: `unknown price source. Known: ${KNOWN_SOURCE_NAMES.join(', ')}`,
                                                },
                                            ),
                                        symbol: z.string().min(1),
                                    }),
                                )
                                .min(1, 'dynamic feed needs at least one source'),
                            minSources: z.number().int().min(1).optional(),
                            maxStaleMs: z
                                .number()
                                .int()
                                .min(1_000)
                                .max(600_000)
                                .optional(),
                            expo: z.number().int().min(-128).max(127).optional(),
                        }),
                    ]),
                )
                .optional(),
            // Multi-op share-exchange — same shape as fortuna.peers.
            peers: z
                .array(
                    z.object({
                        address: z.string(),
                        endpoint: z.string().url(),
                    }),
                )
                .optional(),
            shareExchangePort: z
                .number()
                .int()
                .min(1)
                .max(65_535)
                .optional(),
            shareExchangeHost: z.string().optional(),
            // Non-leader grace before falling back to submitting solo
            // (matches fortuna's pattern). Default (when present): 30s.
            leaderGraceSec: z.number().int().min(5).max(300).optional(),
        })
        .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

// Per-network endpoint defaults. toncenter public RPC is rate-limited without
// an API key (~1 req/s) — fine for single-automaton testnet use; mainnet
// operators should swap in their own endpoint + apiKey via `automaton init`
// or by editing config.json directly.
const DEFAULT_ENDPOINTS: Record<Network, { url: string }[]> = {
    testnet: [{ url: 'https://testnet.toncenter.com/api/v2/jsonRPC' }],
    mainnet: [{ url: 'https://toncenter.com/api/v2/jsonRPC' }],
};

export function defaultConfig(network: Network): Config {
    return {
        configVersion: CONFIG_VERSION,
        network,
        endpoints: DEFAULT_ENDPOINTS[network],
        walletVersion: 'v5r1',
        metricsPort: 9090,
        metricsHost: '127.0.0.1',
        pollIntervalMs: 10_000,
        gaugeSnapshotEveryNTicks: 6,
        maxGasPerExecute: '0.5',
        minFreeBalance: '2.0',
        logLevel: 'info',
        products: { kronos: true, fortuna: false, themis: false, phoebe: false },
    };
}
