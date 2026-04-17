// On-chain vs SDK schema version reconciliation.
//
// Every persistent root storage struct on our contracts carries a 1-byte
// `schemaVersion` field as its first cell slot (see
// kronos/CLAUDE.md §"Schema-versioned storage"). Both contracts expose a
// `storageVersion` getter so off-chain consumers can refuse to run against
// a contract whose layout they don't understand.
//
// Why this matters for the automaton: if the deployed contract has been
// upgraded to a newer layout than our bundled SDKs know about (or vice-
// versa), every read / decode could silently mis-interpret fields. We
// would rather refuse to start with a clear error than spend hours
// debugging "why are all my jobIds nonsense."
//
// The `fetcher` indirection exists for tests: the real implementation
// uses `client.open(KronosRegistry.createFromAddress(...)).getStorageVersion()`,
// which requires a live sandbox or network. Tests pass an in-memory
// fetcher that returns whatever versions exercise the assertion paths.

import { Address } from '@ton/core';
import {
    ForgeTON,
    FORGETON_STORAGE_VERSION,
} from 'forgeton-sdk';
import {
    KronosRegistry,
    REGISTRY_STORAGE_VERSION,
} from 'kronos-sdk';

import type { FailoverTonClient } from './ton-client';

export type ContractName = 'registry' | 'pool';

const SDK_VERSION_LABEL: Record<ContractName, string> = {
    registry: 'REGISTRY_STORAGE_VERSION',
    pool: 'FORGETON_STORAGE_VERSION',
};

export interface SchemaCheckResult {
    contract: ContractName;
    address: Address;
    onChain: number;
    expected: number;
    ok: boolean;
}

export interface SchemaFetcher {
    registryVersion(client: FailoverTonClient, address: Address): Promise<number>;
    poolVersion(client: FailoverTonClient, address: Address): Promise<number>;
}

export const defaultFetcher: SchemaFetcher = {
    async registryVersion(client, address) {
        const registry = client.open(KronosRegistry.createFromAddress(address));
        return registry.getStorageVersion();
    },
    async poolVersion(client, address) {
        const pool = client.open(ForgeTON.createFromAddress(address));
        return pool.getStorageVersion();
    },
};

export class SchemaMismatchError extends Error {
    constructor(public readonly mismatches: readonly SchemaCheckResult[]) {
        super(SchemaMismatchError.format(mismatches));
        this.name = 'SchemaMismatchError';
    }

    static format(mismatches: readonly SchemaCheckResult[]): string {
        const lines = ['contract schema mismatch — refusing to start:'];
        for (const m of mismatches) {
            const sdkLabel = SDK_VERSION_LABEL[m.contract];
            const lagSide =
                m.onChain > m.expected
                    ? 'the deployed contract is newer than this SDK — upgrade @titon/automaton'
                    : 'this SDK is newer than the deployed contract — either the upgrade has not propagated, or you are pointed at a stale deployment';
            lines.push(
                `  ${m.contract} at ${m.address.toString()}:`,
                `    on-chain schemaVersion: ${m.onChain}`,
                `    SDK ${sdkLabel}:      ${m.expected}`,
                `    ${lagSide}`,
            );
        }
        return lines.join('\n');
    }
}

export interface SchemaCheckOptions {
    client: FailoverTonClient;
    registry: Address;
    pool: Address;
    fetcher?: SchemaFetcher;
}

/**
 * Reads `storageVersion` from both contracts and compares against the SDK
 * constants. Returns every result (ok and mismatched) so callers can log
 * the full picture. Throws `SchemaMismatchError` if any check fails.
 */
export async function checkSchemaVersions(
    options: SchemaCheckOptions,
): Promise<readonly SchemaCheckResult[]> {
    const fetcher = options.fetcher ?? defaultFetcher;

    const [registryVersion, poolVersion] = await Promise.all([
        fetcher.registryVersion(options.client, options.registry),
        fetcher.poolVersion(options.client, options.pool),
    ]);

    const results: SchemaCheckResult[] = [
        {
            contract: 'registry',
            address: options.registry,
            onChain: registryVersion,
            expected: REGISTRY_STORAGE_VERSION,
            ok: registryVersion === REGISTRY_STORAGE_VERSION,
        },
        {
            contract: 'pool',
            address: options.pool,
            onChain: poolVersion,
            expected: FORGETON_STORAGE_VERSION,
            ok: poolVersion === FORGETON_STORAGE_VERSION,
        },
    ];

    const mismatches = results.filter((r) => !r.ok);
    if (mismatches.length > 0) {
        throw new SchemaMismatchError(mismatches);
    }
    return results;
}
