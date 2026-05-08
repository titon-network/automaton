// On-chain vs SDK schema version reconciliation.
//
// Every persistent root storage struct on our contracts carries a 1-byte
// `schemaVersion` field as its first cell slot. Every contract exposes a
// way to read its current version so off-chain consumers can refuse to
// run against a contract whose layout they don't understand.
//
// Baseline:
//   - ForgeTON: getStorageVersion() → number
//
// Per-product checks come from each enabled `ProductModule.schemaChecks()`
// (kronos contributes registry; fortuna contributes atlas + fortuna).
// Adding a new product = drop it in src/products/; this file does not
// change.
//
// Why this matters for the automaton: if the deployed contract has been
// upgraded to a newer layout than our bundled SDKs know about (or vice-
// versa), every read / decode could silently mis-interpret fields. We
// would rather refuse to start with a clear error than spend hours
// debugging "why are all my jobIds nonsense."

import { Address } from '@ton/core';
import {
    ForgeTON,
    FORGETON_STORAGE_VERSION,
} from '@titon-network/forgeton-sdk';

import type { FailoverTonClient } from './ton-client';
import type { Config } from '../config/schema';
import type { Deployment } from './deployment';
import type { ChainRuntime } from './runtime';
import { enabledProducts } from '../products';
import type { SchemaCheckTask } from '../products/types';

export interface SchemaCheckResult {
    /** Stable identifier (`pool` for the baseline; `<product>:<contract>` for products). */
    contract: string;
    address: Address;
    onChain: number;
    expected: number;
    sdkVariable: string;
    ok: boolean;
}

export class SchemaMismatchError extends Error {
    constructor(public readonly mismatches: readonly SchemaCheckResult[]) {
        super(SchemaMismatchError.format(mismatches));
        this.name = 'SchemaMismatchError';
    }

    static format(mismatches: readonly SchemaCheckResult[]): string {
        const lines = ['contract schema mismatch — refusing to start:'];
        for (const m of mismatches) {
            const lagSide =
                m.onChain > m.expected
                    ? 'the deployed contract is newer than this SDK — upgrade @titon-network/automaton'
                    : 'this SDK is newer than the deployed contract — either the upgrade has not propagated, or you are pointed at a stale deployment';
            lines.push(
                `  ${m.contract} at ${m.address.toString()}:`,
                `    on-chain schemaVersion: ${m.onChain}`,
                `    SDK ${m.sdkVariable}:      ${m.expected}`,
                `    ${lagSide}`,
            );
        }
        return lines.join('\n');
    }
}

export interface SchemaCheckOptions {
    config: Config;
    client: FailoverTonClient;
    deployment: Deployment;
    runtime: ChainRuntime;
}

/**
 * Reads the live schema version for every baseline + enabled-product
 * contract and compares against the SDK constant the daemon was built
 * against. Returns every result (ok and mismatched) so callers can log
 * the full picture. Throws `SchemaMismatchError` if any check fails.
 */
export async function checkSchemaVersions(
    options: SchemaCheckOptions,
): Promise<readonly SchemaCheckResult[]> {
    const tasks: SchemaCheckTask[] = [
        {
            contract: 'pool',
            address: options.deployment.pool,
            expected: FORGETON_STORAGE_VERSION,
            sdkVariable: 'FORGETON_STORAGE_VERSION',
            read: () =>
                options.client
                    .open(ForgeTON.createFromAddress(options.deployment.pool))
                    .getStorageVersion(),
        },
    ];

    for (const product of enabledProducts(options.config)) {
        const addresses = options.deployment.products[product.name] ?? {};
        const contracts = options.runtime.products[product.name] ?? {};
        // Prefix product name into the contract label so e.g. fortuna's
        // 'atlas' becomes 'fortuna:atlas' in mismatch errors. Lets a future
        // product re-use a label without colliding.
        for (const t of product.schemaChecks({ client: options.client, addresses, contracts })) {
            tasks.push({
                ...t,
                contract: `${product.name}:${t.contract}`,
            });
        }
    }

    const results: SchemaCheckResult[] = await Promise.all(
        tasks.map(async (t) => {
            const onChain = await t.read();
            return {
                contract: t.contract,
                address: t.address,
                onChain,
                expected: t.expected,
                sdkVariable: t.sdkVariable,
                ok: onChain === t.expected,
            };
        }),
    );
    const mismatches = results.filter((r) => !r.ok);
    if (mismatches.length > 0) {
        throw new SchemaMismatchError(mismatches);
    }
    return results;
}

