// buildChainRuntime unit test.
//
// Thin composition layer — wires FailoverTonClient + opened contracts +
// resolved deployment into the bundle every daemon / CLI / status path
// consumes. Exercise the happy-path shape + the DeploymentNotAvailableError
// passthrough for mainnet.

import {
    buildChainRuntime,
    DeploymentNotAvailableError,
    ProductsNotSupportedError,
} from '../src/chain';
import { defaultConfig } from '../src/config';
import { FailoverTonClient } from '../src/chain/ton-client';
import { KRONOS_TESTNET } from 'kronos-sdk';

describe('buildChainRuntime', () => {
    it('assembles a runtime for testnet using live KRONOS_TESTNET addresses', () => {
        const runtime = buildChainRuntime(defaultConfig('testnet'));
        expect(runtime.client).toBeInstanceOf(FailoverTonClient);
        expect(runtime.client.currentEndpoint).toContain('testnet.toncenter.com');
        expect(runtime.deployment.registry.equals(KRONOS_TESTNET.registry)).toBe(true);
        expect(runtime.deployment.pool.equals(KRONOS_TESTNET.pool)).toBe(true);
        // OpenedContract<T> surface — the sdk wrappers expose registry/pool
        // methods. Spot-check the presence of a getter.
        expect(typeof runtime.registry.getConfig).toBe('function');
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

    it('rejects products.kronos=false (Kronos is the only live product)', () => {
        const config = defaultConfig('testnet');
        config.products = { kronos: false, fortuna: false };
        expect(() => buildChainRuntime(config)).toThrow(ProductsNotSupportedError);
    });

    it('rejects products.fortuna=true (reserved for Phase E)', () => {
        const config = defaultConfig('testnet');
        config.products = { kronos: true, fortuna: true };
        expect(() => buildChainRuntime(config)).toThrow(ProductsNotSupportedError);
    });
});
