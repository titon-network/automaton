// Single source of truth for config shape. Types derive from the zod schema
// via `z.infer`, so there's no risk of the runtime validator and the static
// type drifting apart.
//
// Every field has a sensible default (see `defaultConfig`) so `automaton init`
// can emit a working config without interrogating the user for every knob.

import { z } from 'zod';

// Bump when ANY field is added/removed/renamed, or when a field's semantics
// change. Loaders reject configs that don't match — same schema-versioning
// discipline as the on-chain storage structs.
export const CONFIG_VERSION = 1;

export const NETWORKS = ['testnet', 'mainnet'] as const;
export const NetworkSchema = z.enum(NETWORKS);
export type Network = z.infer<typeof NetworkSchema>;

const EndpointSchema = z.object({
    url: z.string().url(),
    apiKey: z.string().optional(),
});

// TON amounts are stored as decimal strings (e.g. "0.5"). Users edit the JSON
// file directly, so human-readable beats nanoton bigint. Call sites convert
// with `toNano(...)` from @ton/core.
const TonAmount = z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'must be a decimal TON amount (e.g. "0.5")');

export const LogLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const ConfigSchema = z.object({
    configVersion: z.literal(CONFIG_VERSION),
    network: NetworkSchema,
    endpoints: z.array(EndpointSchema).min(1, 'at least one endpoint is required'),
    walletVersion: z.enum(['v5r1']),
    metricsPort: z.number().int().positive().max(65535),
    pollIntervalMs: z.number().int().min(1000),
    alertWebhookUrl: z.string().url().optional(),
    maxGasPerExecute: TonAmount,
    minFreeBalance: TonAmount,
    logLevel: LogLevelSchema,
    products: z.object({
        kronos: z.boolean(),
        fortuna: z.boolean(),
    }),
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
        pollIntervalMs: 10_000,
        maxGasPerExecute: '0.5',
        minFreeBalance: '2.0',
        logLevel: 'info',
        products: { kronos: true, fortuna: false },
    };
}
