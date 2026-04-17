// checkSchemaVersions: compares deployed storageVersion getters against
// the SDK constants. Happy path + either-side mismatch + fetcher error
// propagation + the per-case message text (SDK-newer-vs-contract-newer).

import { Address } from '@ton/core';
import { FORGETON_STORAGE_VERSION } from 'forgeton-sdk';
import { REGISTRY_STORAGE_VERSION } from 'kronos-sdk';
import { FailoverTonClient } from '../src/chain/ton-client';
import {
    SchemaFetcher,
    SchemaMismatchError,
    checkSchemaVersions,
} from '../src/chain/schema-check';

const REGISTRY = Address.parse('EQD__________________________________________0vo');
const POOL = Address.parse('EQD__________________________________________0vo');

// Dummy client — the injected fetcher never touches it, so constructor is all we need.
const client = new FailoverTonClient({
    network: 'testnet',
    endpoints: [{ url: 'https://unused.example' }],
});

function fetcher(overrides: Partial<SchemaFetcher>): SchemaFetcher {
    return {
        registryVersion: async () => REGISTRY_STORAGE_VERSION,
        poolVersion: async () => FORGETON_STORAGE_VERSION,
        ...overrides,
    };
}

describe('checkSchemaVersions', () => {
    it('returns ok results when both versions match the SDK constants', async () => {
        const results = await checkSchemaVersions({
            client,
            registry: REGISTRY,
            pool: POOL,
            fetcher: fetcher({}),
        });

        expect(results).toHaveLength(2);
        expect(results.every((r) => r.ok)).toBe(true);
        expect(results[0]).toMatchObject({
            contract: 'registry',
            onChain: REGISTRY_STORAGE_VERSION,
            expected: REGISTRY_STORAGE_VERSION,
        });
        expect(results[1]).toMatchObject({
            contract: 'pool',
            onChain: FORGETON_STORAGE_VERSION,
            expected: FORGETON_STORAGE_VERSION,
        });
    });

    it('throws SchemaMismatchError when the registry version drifts ahead', async () => {
        await expect(
            checkSchemaVersions({
                client,
                registry: REGISTRY,
                pool: POOL,
                fetcher: fetcher({
                    registryVersion: async () => REGISTRY_STORAGE_VERSION + 1,
                }),
            }),
        ).rejects.toBeInstanceOf(SchemaMismatchError);
    });

    it('throws SchemaMismatchError when the pool version drifts behind', async () => {
        await expect(
            checkSchemaVersions({
                client,
                registry: REGISTRY,
                pool: POOL,
                fetcher: fetcher({
                    poolVersion: async () => FORGETON_STORAGE_VERSION - 1,
                }),
            }),
        ).rejects.toBeInstanceOf(SchemaMismatchError);
    });

    it('surfaces both on-chain and expected versions in the error message', async () => {
        const probe = checkSchemaVersions({
            client,
            registry: REGISTRY,
            pool: POOL,
            fetcher: fetcher({
                registryVersion: async () => 99,
                poolVersion: async () => 42,
            }),
        });

        await expect(probe).rejects.toThrow(/on-chain schemaVersion: 99/);
        await expect(probe).rejects.toThrow(/REGISTRY_STORAGE_VERSION/);
        await expect(probe).rejects.toThrow(/on-chain schemaVersion: 42/);
        await expect(probe).rejects.toThrow(/FORGETON_STORAGE_VERSION/);
    });

    it('hints SDK-newer-than-contract when expected > on-chain', async () => {
        const probe = checkSchemaVersions({
            client,
            registry: REGISTRY,
            pool: POOL,
            fetcher: fetcher({
                registryVersion: async () => REGISTRY_STORAGE_VERSION - 1,
            }),
        });

        await expect(probe).rejects.toThrow(/this SDK is newer than the deployed contract/);
    });

    it('hints contract-newer-than-SDK when on-chain > expected', async () => {
        const probe = checkSchemaVersions({
            client,
            registry: REGISTRY,
            pool: POOL,
            fetcher: fetcher({
                registryVersion: async () => REGISTRY_STORAGE_VERSION + 1,
            }),
        });

        await expect(probe).rejects.toThrow(/upgrade @titon\/automaton/);
    });

    it('collects all mismatches into one error', async () => {
        try {
            await checkSchemaVersions({
                client,
                registry: REGISTRY,
                pool: POOL,
                fetcher: fetcher({
                    registryVersion: async () => 10,
                    poolVersion: async () => 20,
                }),
            });
            fail('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(SchemaMismatchError);
            const mismatch = err as SchemaMismatchError;
            expect(mismatch.mismatches).toHaveLength(2);
            expect(mismatch.mismatches[0]!.contract).toBe('registry');
            expect(mismatch.mismatches[1]!.contract).toBe('pool');
        }
    });

    it('propagates underlying fetcher errors (e.g. network failure)', async () => {
        const boom = new Error('network is on fire');
        await expect(
            checkSchemaVersions({
                client,
                registry: REGISTRY,
                pool: POOL,
                fetcher: fetcher({
                    registryVersion: async () => {
                        throw boom;
                    },
                }),
            }),
        ).rejects.toBe(boom);
    });
});
