// resolveDeployment: maps config.network → (registry, pool) addresses.
// Testnet uses KRONOS_TESTNET; mainnet throws DeploymentNotAvailableError
// until the constant ships.

import { KRONOS_TESTNET } from 'kronos-sdk';
import { defaultConfig } from '../src/config/schema';
import { DeploymentNotAvailableError, resolveDeployment } from '../src/chain/deployment';

describe('resolveDeployment', () => {
    it('returns the SDK testnet addresses for network=testnet', () => {
        const deployment = resolveDeployment(defaultConfig('testnet'));
        expect(deployment.registry.equals(KRONOS_TESTNET.registry)).toBe(true);
        expect(deployment.pool.equals(KRONOS_TESTNET.pool)).toBe(true);
    });

    it('throws DeploymentNotAvailableError for network=mainnet (not yet live)', () => {
        expect(() => resolveDeployment(defaultConfig('mainnet'))).toThrow(
            DeploymentNotAvailableError,
        );
    });

    it('mainnet error message points the operator at the SDK', () => {
        try {
            resolveDeployment(defaultConfig('mainnet'));
            fail('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(DeploymentNotAvailableError);
            expect((err as Error).message).toMatch(/mainnet/);
            expect((err as Error).message).toMatch(/KRONOS_TESTNET/);
        }
    });
});
