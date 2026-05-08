// resolveDeployment: maps config.network → (registry, pool) addresses.
// Both testnet and mainnet now resolve from SDK-shipped constants
// (KRONOS_TESTNET / KRONOS_MAINNET / FORGETON_TESTNET / FORGETON_MAINNET).

import { FORGETON_MAINNET, FORGETON_TESTNET } from '@titon-network/forgeton-sdk';
import { KRONOS_MAINNET, KRONOS_TESTNET } from '@titon-network/kronos-sdk';
import { defaultConfig } from '../src/config/schema';
import { DeploymentNotAvailableError, resolveDeployment } from '../src/chain/deployment';

describe('resolveDeployment', () => {
    it('returns the SDK testnet addresses for network=testnet (pool baseline + kronos product)', () => {
        const deployment = resolveDeployment(defaultConfig('testnet'));
        expect(deployment.pool.equals(FORGETON_TESTNET.forgeton)).toBe(true);
        expect(deployment.products.kronos?.registry?.equals(KRONOS_TESTNET.registry)).toBe(true);
    });

    it('returns the SDK mainnet addresses for network=mainnet (pool baseline + kronos product)', () => {
        const deployment = resolveDeployment(defaultConfig('mainnet'));
        expect(deployment.pool.equals(FORGETON_MAINNET.forgeton)).toBe(true);
        expect(deployment.products.kronos?.registry?.equals(KRONOS_MAINNET.registry)).toBe(true);
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

    it('resolves all addresses on mainnet (pool + kronos + fortuna with overrides)', () => {
        const cfg = defaultConfig('mainnet');
        cfg.products.fortuna = true;
        cfg.fortuna = { atlasAddress: ATLAS_OVERRIDE, fortunaAddress: FORTUNA_OVERRIDE };
        const dep = resolveDeployment(cfg);
        expect(dep.pool.equals(FORGETON_MAINNET.forgeton)).toBe(true);
        expect(dep.products.kronos?.registry?.equals(KRONOS_MAINNET.registry)).toBe(true);
        expect(dep.products.fortuna?.atlas?.toRawString()).toBe(ATLAS_OVERRIDE);
        expect(dep.products.fortuna?.fortuna?.toRawString()).toBe(FORTUNA_OVERRIDE);
    });

    it('falls back to ATLAS_MAINNET / FORTUNA_MAINNET when no overrides on mainnet', () => {
        const cfg = defaultConfig('mainnet');
        cfg.products.fortuna = true;
        const dep = resolveDeployment(cfg);
        expect(dep.products.fortuna?.atlas).toBeDefined();
        expect(dep.products.fortuna?.fortuna).toBeDefined();
    });
});
