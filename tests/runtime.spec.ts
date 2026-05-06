// buildChainRuntime unit test.
//
// Thin composition layer — wires FailoverTonClient + opened contracts +
// resolved deployment into the bundle every daemon / CLI / status path
// consumes. Exercise the happy-path shape + the DeploymentNotAvailableError
// passthrough for mainnet.

import {
    buildChainRuntime,
    DeploymentNotAvailableError,
} from '../src/chain';
import { defaultConfig } from '../src/config';
import { FailoverTonClient } from '../src/chain/ton-client';
import { KRONOS_TESTNET } from '@titon-network/kronos-sdk';

describe('buildChainRuntime', () => {
    it('assembles a runtime for testnet — kronos contributes registry, pool is baseline', () => {
        const runtime = buildChainRuntime(defaultConfig('testnet'));
        expect(runtime.client).toBeInstanceOf(FailoverTonClient);
        expect(runtime.client.currentEndpoint).toContain('testnet.toncenter.com');
        expect(runtime.deployment.products.kronos?.registry?.equals(KRONOS_TESTNET.registry)).toBe(true);
        expect(runtime.deployment.pool.equals(KRONOS_TESTNET.forgeton)).toBe(true);
        // OpenedContract<T> surface — the sdk wrappers expose contract
        // methods. Spot-check the presence of a getter.
        const registry = runtime.products.kronos?.registry as { getConfig?: unknown };
        expect(typeof registry?.getConfig).toBe('function');
        expect(typeof runtime.pool.getConfig).toBe('function');
    });

    it('throws DeploymentNotAvailableError for mainnet (no live deployment yet)', () => {
        const config = defaultConfig('mainnet');
        expect(() => buildChainRuntime(config)).toThrow(DeploymentNotAvailableError);
    });

    it('carries the configured endpoints into FailoverTonClient', () => {
        const config = defaultConfig('testnet');
        config.endpoints = [
            { url: 'https://first.example/api/v2/jsonRPC' },
            { url: 'https://second.example/api/v2/jsonRPC', apiKey: 'k' },
        ];
        const runtime = buildChainRuntime(config);
        expect(runtime.client.listEndpoints()).toEqual([
            'https://first.example/api/v2/jsonRPC',
            'https://second.example/api/v2/jsonRPC',
        ]);
    });

    it('runs without kronos when products.kronos=false (specialised non-Kronos operator)', () => {
        const config = defaultConfig('testnet');
        config.products = { kronos: false, fortuna: false };
        const runtime = buildChainRuntime(config);
        expect(runtime.products.kronos).toBeUndefined();
        // Pool is still the baseline; the operator can stake but no
        // worker runs unless another product is enabled.
        expect(typeof runtime.pool.getConfig).toBe('function');
    });

    it('opens atlas + fortuna contracts when products.fortuna=true (with overrides)', () => {
        const config = defaultConfig('testnet');
        config.products = { kronos: true, fortuna: true };
        const atlasAddr = '0:0000000000000000000000000000000000000000000000000000000000000001';
        const fortunaAddr = '0:0000000000000000000000000000000000000000000000000000000000000002';
        config.fortuna = { atlasAddress: atlasAddr, fortunaAddress: fortunaAddr };
        const runtime = buildChainRuntime(config);
        expect(runtime.products.fortuna?.atlas).toBeDefined();
        expect(runtime.products.fortuna?.fortuna).toBeDefined();
        expect(runtime.deployment.products.fortuna?.atlas?.toRawString()).toBe(atlasAddr);
        expect(runtime.deployment.products.fortuna?.fortuna?.toRawString()).toBe(fortunaAddr);
    });

    it('omits fortuna contracts when products.fortuna=false', () => {
        const config = defaultConfig('testnet');
        config.products = { kronos: true, fortuna: false };
        const runtime = buildChainRuntime(config);
        expect(runtime.products.fortuna).toBeUndefined();
        expect(runtime.deployment.products.fortuna).toBeUndefined();
    });
});
