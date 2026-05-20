// checkSchemaVersions: compares deployed storageVersion getters against
// the SDK constants. Reconciliation is data-driven from baseline +
// ProductModule.schemaChecks; we test the wiring (baseline-only,
// per-product addition, mismatch detection, error formatting) by
// mocking the FailoverTonClient at the open() boundary.
//
// The actual on-chain getter behavior is covered by Integration.spec.ts.

import { Address } from '@ton/core';
import { FORGETON_STORAGE_VERSION } from '@titon-network/forgeton-sdk';
import { REGISTRY_STORAGE_VERSION } from '@titon-network/kronos-sdk';
import { ATLAS_STORAGE_VERSION } from '@titon-network/atlas-sdk';
import { FORTUNA_STORAGE_VERSION } from '@titon-network/fortuna-sdk';
import { defaultConfig } from '../src/config/schema';
import {
    SchemaMismatchError,
    checkSchemaVersions,
    type SchemaCheckResult,
} from '../src/chain/schema-check';
import type { ChainRuntime } from '../src/chain/runtime';
import type { Deployment } from '../src/chain/deployment';
import type { FailoverTonClient } from '../src/chain/ton-client';

const REGISTRY = Address.parse('0:0000000000000000000000000000000000000000000000000000000000000010');
const POOL = Address.parse('0:0000000000000000000000000000000000000000000000000000000000000020');
const ATLAS = Address.parse('0:0000000000000000000000000000000000000000000000000000000000000030');
const FORTUNA_ADDR = Address.parse('0:0000000000000000000000000000000000000000000000000000000000000040');

interface VersionOverrides {
    registry?: number;
    pool?: number;
    atlas?: number;
    fortuna?: number;
}

function mockClient(overrides: VersionOverrides): FailoverTonClient {
    const open = (contract: { address: Address }) => {
        const addr = contract.address.toString();
        // Returned stubs MUST include `address` so the fortuna ProductModule's
        // schemaChecks can read it for the SchemaCheckTask record.
        if (addr === REGISTRY.toString()) {
            return {
                address: REGISTRY,
                getStorageVersion: async () => overrides.registry ?? REGISTRY_STORAGE_VERSION,
            };
        }
        if (addr === POOL.toString()) {
            return {
                address: POOL,
                getStorageVersion: async () => overrides.pool ?? FORGETON_STORAGE_VERSION,
            };
        }
        if (addr === ATLAS.toString()) {
            return {
                address: ATLAS,
                getSchemaVersions: async () => ({ storage: overrides.atlas ?? ATLAS_STORAGE_VERSION }),
            };
        }
        if (addr === FORTUNA_ADDR.toString()) {
            return {
                address: FORTUNA_ADDR,
                getSchemaVersions: async () => ({ storage: overrides.fortuna ?? FORTUNA_STORAGE_VERSION }),
            };
        }
        throw new Error(`mockClient.open: unexpected address ${addr}`);
    };
    return { open } as unknown as FailoverTonClient;
}

function baselineDeployment(): Deployment {
    return {
        pool: POOL,
        products: {},
    };
}

function kronosDeployment(): Deployment {
    return {
        pool: POOL,
        products: { kronos: { registry: REGISTRY } },
    };
}

function fortunaDeployment(): Deployment {
    return {
        pool: POOL,
        products: {
            kronos: { registry: REGISTRY },
            fortuna: { atlas: ATLAS, fortuna: FORTUNA_ADDR },
        },
    };
}

function fakeRuntime(client: FailoverTonClient, deployment: Deployment): ChainRuntime {
    // Each product's schemaChecks() reads from `contracts.X` — we stitch
    // them together here so the kronos product finds `contracts.registry`
    // and the fortuna product finds `contracts.atlas` / `contracts.fortuna`.
    const products: ChainRuntime['products'] = {};
    if (deployment.products.kronos !== undefined) {
        products.kronos = {
            registry: client.open({ address: REGISTRY } as never) as never,
        };
    }
    if (deployment.products.fortuna !== undefined) {
        products.fortuna = {
            atlas: client.open({ address: ATLAS } as never) as never,
            fortuna: client.open({ address: FORTUNA_ADDR } as never) as never,
        };
    }
    return {
        client,
        deployment,
        pool: client.open({ address: POOL } as never) as never,
        products,
    };
}

describe('checkSchemaVersions — pool-only (no products)', () => {
    it('returns ok result for the pool baseline when no products are enabled', async () => {
        const config = defaultConfig('testnet');
        config.products.kronos = false;
        config.products.fortuna = false;
        const client = mockClient({});
        const deployment = baselineDeployment();
        const runtime = fakeRuntime(client, deployment);

        const results = await checkSchemaVersions({ config, client, deployment, runtime });
        expect(results).toHaveLength(1);
        expect(results[0]?.contract).toBe('pool');
        expect(results.every((r) => r.ok)).toBe(true);
    });
});

describe('checkSchemaVersions — kronos product', () => {
    it('adds kronos:registry check when products.kronos=true', async () => {
        const config = defaultConfig('testnet');
        config.products.fortuna = false;
        const client = mockClient({});
        const deployment = kronosDeployment();
        const runtime = fakeRuntime(client, deployment);

        const results = await checkSchemaVersions({ config, client, deployment, runtime });
        expect(results.map((r) => r.contract).sort()).toEqual(['kronos:registry', 'pool']);
        expect(results.every((r) => r.ok)).toBe(true);
    });

    it('flags registry mismatch with the REGISTRY_STORAGE_VERSION variable name', async () => {
        const config = defaultConfig('testnet');
        config.products.fortuna = false;
        const client = mockClient({ registry: REGISTRY_STORAGE_VERSION + 1 });
        const deployment = kronosDeployment();
        const runtime = fakeRuntime(client, deployment);

        await expect(
            checkSchemaVersions({ config, client, deployment, runtime }),
        ).rejects.toThrow(/REGISTRY_STORAGE_VERSION/);
    });
});

describe('checkSchemaVersions — fortuna product', () => {
    it('adds atlas + fortuna checks when products.fortuna=true (alongside kronos)', async () => {
        const config = defaultConfig('testnet');
        config.products.fortuna = true;
        config.fortuna = {
            atlasAddress: ATLAS.toRawString(),
            fortunaAddress: FORTUNA_ADDR.toRawString(),
        };
        const client = mockClient({});
        const deployment = fortunaDeployment();
        const runtime = fakeRuntime(client, deployment);

        const results = await checkSchemaVersions({ config, client, deployment, runtime });
        expect(results).toHaveLength(4);
        expect(results.map((r) => r.contract).sort()).toEqual([
            'fortuna:atlas',
            'fortuna:fortuna',
            'kronos:registry',
            'pool',
        ]);
    });

    it('flags atlas mismatch with the ATLAS_STORAGE_VERSION variable name', async () => {
        const config = defaultConfig('testnet');
        config.products.fortuna = true;
        config.fortuna = {
            atlasAddress: ATLAS.toRawString(),
            fortunaAddress: FORTUNA_ADDR.toRawString(),
        };
        const client = mockClient({ atlas: ATLAS_STORAGE_VERSION + 1 });
        const deployment = fortunaDeployment();
        const runtime = fakeRuntime(client, deployment);

        await expect(
            checkSchemaVersions({ config, client, deployment, runtime }),
        ).rejects.toThrow(/ATLAS_STORAGE_VERSION/);
    });

    it('collects atlas + fortuna mismatches alongside registry + pool', async () => {
        const config = defaultConfig('testnet');
        config.products.fortuna = true;
        config.fortuna = {
            atlasAddress: ATLAS.toRawString(),
            fortunaAddress: FORTUNA_ADDR.toRawString(),
        };
        const client = mockClient({
            atlas: ATLAS_STORAGE_VERSION + 1,
            fortuna: FORTUNA_STORAGE_VERSION + 1,
        });
        const deployment = fortunaDeployment();
        const runtime = fakeRuntime(client, deployment);

        try {
            await checkSchemaVersions({ config, client, deployment, runtime });
            fail('expected throw');
        } catch (err) {
            const mismatch = err as SchemaMismatchError;
            expect(mismatch.mismatches).toHaveLength(2);
            const contracts = mismatch.mismatches.map((m) => m.contract).sort();
            expect(contracts).toEqual(['fortuna:atlas', 'fortuna:fortuna']);
        }
    });
});

describe('SchemaMismatchError formatting', () => {
    it('hints SDK-newer-than-contract when expected > on-chain', () => {
        const result: SchemaCheckResult = {
            contract: 'kronos:registry',
            address: REGISTRY,
            onChain: 1,
            expected: 2,
            sdkVariable: 'REGISTRY_STORAGE_VERSION',
            ok: false,
        };
        const msg = SchemaMismatchError.format([result]);
        expect(msg).toMatch(/this SDK is newer than the deployed contract/);
        expect(msg).toMatch(/REGISTRY_STORAGE_VERSION/);
    });

    it('hints contract-newer-than-SDK when on-chain > expected', () => {
        const result: SchemaCheckResult = {
            contract: 'kronos:registry',
            address: REGISTRY,
            onChain: 5,
            expected: 1,
            sdkVariable: 'REGISTRY_STORAGE_VERSION',
            ok: false,
        };
        const msg = SchemaMismatchError.format([result]);
        expect(msg).toMatch(/upgrade @titon-network\/automaton/);
    });
});
