// fortuna ProductModule — covers the surface that's exclusive to the
// fortuna product (resolveAddresses / explainError / doctorInstallChecks).
// bootstrapWorker + buildHandlers integration is exercised by tick-once.spec.ts
// + Integration.spec.ts; this file keeps the unit-level checks isolated.

import { defaultConfig } from '../src/config/schema';
import { fortuna } from '../src/products/fortuna';

describe('fortuna ProductModule.isEnabled', () => {
    it('true when config.products.fortuna === true', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.fortuna = true;
        expect(fortuna.isEnabled(cfg)).toBe(true);
    });

    it('false when config.products.fortuna === false', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.fortuna = false;
        expect(fortuna.isEnabled(cfg)).toBe(false);
    });
});

describe('fortuna ProductModule.resolveAddresses', () => {
    it('returns {} when not enabled', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.fortuna = false;
        expect(fortuna.resolveAddresses(cfg)).toEqual({});
    });

    it('returns atlas + fortuna keys when enabled (overrides supplied)', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.fortuna = true;
        cfg.fortuna = {
            atlasAddress: '0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            fortunaAddress: '0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        };
        const addresses = fortuna.resolveAddresses(cfg);
        expect(addresses.atlas).toBeDefined();
        expect(addresses.fortuna).toBeDefined();
    });
});

describe('fortuna ProductModule.explainError', () => {
    it('routes a fortuna-owned code (161 = E_INVALID_BLS_SIGNATURE) to the fortuna table', () => {
        const e = fortuna.explainError(161);
        expect(e.origin).toBe('fortuna');
        expect(e.name.toLowerCase()).toMatch(/bls|signature/);
    });

    it('returns origin=unknown for codes outside its range', () => {
        const e = fortuna.explainError(9999);
        expect(e.origin).toBe('unknown');
    });
});

describe('fortuna ProductModule.doctorInstallChecks', () => {
    it('contributes atlas-sdk + fortuna-sdk SDK-resolves checks', () => {
        const checks = fortuna.doctorInstallChecks();
        expect(checks).toHaveLength(2);
        expect(checks.map((c) => c.name)).toEqual([
            '@titon-network/atlas-sdk resolves',
            '@titon-network/fortuna-sdk resolves',
        ]);
    });
});
