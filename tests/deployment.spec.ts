// resolveDeployment: maps config.network → (registry, pool) addresses.
// Testnet uses KRONOS_TESTNET; mainnet throws DeploymentNotAvailableError
// until the constant ships.

import { KRONOS_TESTNET } from '@titon-network/kronos-sdk';
import { defaultConfig } from '../src/config/schema';
import { DeploymentNotAvailableError, resolveDeployment } from '../src/chain/deployment';

describe('resolveDeployment', () => {
    it('returns the SDK testnet addresses for network=testnet (pool baseline + kronos product)', () => {
        const deployment = resolveDeployment(defaultConfig('testnet'));
        expect(deployment.pool.equals(KRONOS_TESTNET.forgeton)).toBe(true);
        expect(deployment.products.kronos?.registry?.equals(KRONOS_TESTNET.registry)).toBe(true);
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
            expect((err as Error).message).toMatch(/FORGETON_TESTNET/);
        }
    });

    it('omits the fortuna product entry when products.fortuna=false', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.fortuna = false;
        const dep = resolveDeployment(cfg);
        expect(dep.products.fortuna).toBeUndefined();
    });
});

describe('resolveDeployment: atlas + fortuna resolution', () => {
    const ATLAS_OVERRIDE =
        '0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const FORTUNA_OVERRIDE =
        '0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    it('uses config overrides when products.fortuna=true', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.fortuna = true;
        cfg.fortuna = { atlasAddress: ATLAS_OVERRIDE, fortunaAddress: FORTUNA_OVERRIDE };
        const dep = resolveDeployment(cfg);
        expect(dep.products.fortuna?.atlas?.toRawString()).toBe(ATLAS_OVERRIDE);
        expect(dep.products.fortuna?.fortuna?.toRawString()).toBe(FORTUNA_OVERRIDE);
    });

    it('falls back to ATLAS_TESTNET when no override is supplied', () => {
        // ATLAS_TESTNET is now populated via @titon-network/atlas-sdk; with
        // products.fortuna enabled but no override, the resolver returns the
        // SDK-shipped address instead of throwing.
        const cfg = defaultConfig('testnet');
        cfg.products.fortuna = true;
        cfg.fortuna = { fortunaAddress: FORTUNA_OVERRIDE };
        const dep = resolveDeployment(cfg);
        expect(dep.products.fortuna?.atlas).toBeDefined();
        // Override beats SDK on the fortuna side.
        expect(dep.products.fortuna?.fortuna?.toRawString()).toBe(FORTUNA_OVERRIDE);
    });

    it('falls back to FORTUNA_TESTNET when no override is supplied', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.fortuna = true;
        cfg.fortuna = { atlasAddress: ATLAS_OVERRIDE };
        const dep = resolveDeployment(cfg);
        expect(dep.products.fortuna?.fortuna).toBeDefined();
        expect(dep.products.fortuna?.atlas?.toRawString()).toBe(ATLAS_OVERRIDE);
    });

    it('throws with actionable message when atlasAddress is malformed', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.fortuna = true;
        cfg.fortuna = { atlasAddress: 'not-a-ton-address', fortunaAddress: FORTUNA_OVERRIDE };
        expect(() => resolveDeployment(cfg)).toThrow(DeploymentNotAvailableError);
        expect(() => resolveDeployment(cfg)).toThrow(/atlasAddress|atlas address/i);
    });

    it('throws with actionable message when fortunaAddress is malformed', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.fortuna = true;
        cfg.fortuna = { atlasAddress: ATLAS_OVERRIDE, fortunaAddress: 'also-bogus' };
        expect(() => resolveDeployment(cfg)).toThrow(DeploymentNotAvailableError);
        expect(() => resolveDeployment(cfg)).toThrow(/fortunaAddress|fortuna address/i);
    });

    it('mainnet throws the ForgeTON mainnet error first (baseline before products)', () => {
        // ForgeTON pool resolution runs before any product, so the
        // mainnet-not-live error for ForgeTON surfaces first.
        const cfg = defaultConfig('mainnet');
        cfg.products.fortuna = true;
        cfg.fortuna = { atlasAddress: ATLAS_OVERRIDE, fortunaAddress: FORTUNA_OVERRIDE };
        expect(() => resolveDeployment(cfg)).toThrow(/ForgeTON mainnet/);
    });
});
