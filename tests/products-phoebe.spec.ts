// phoebe ProductModule — covers the surface that's exclusive to the
// phoebe product (isEnabled / resolveAddresses / explainError /
// doctorInstallChecks). bootstrapWorker + buildHandlers integration
// is exercised by tests that bring the full daemon up.

import { defaultConfig } from '../src/config/schema';
import { phoebe } from '../src/products/phoebe';

describe('phoebe ProductModule.isEnabled', () => {
    it('true when config.products.phoebe === true', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.phoebe = true;
        expect(phoebe.isEnabled(cfg)).toBe(true);
    });

    it('false when config.products.phoebe === false', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.phoebe = false;
        expect(phoebe.isEnabled(cfg)).toBe(false);
    });

    it('false by default (defaultConfig leaves phoebe off)', () => {
        const cfg = defaultConfig('testnet');
        expect(phoebe.isEnabled(cfg)).toBe(false);
    });
});

describe('phoebe ProductModule.resolveAddresses', () => {
    it('returns {} when not enabled', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.phoebe = false;
        expect(phoebe.resolveAddresses(cfg)).toEqual({});
    });

    it('returns atlas + phoebe keys when enabled (overrides supplied)', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.phoebe = true;
        cfg.phoebe = {
            atlasAddress: '0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            phoebeAddress: '0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            pushIntervalMs: 30_000,
        };
        const addresses = phoebe.resolveAddresses(cfg);
        expect(addresses.atlas).toBeDefined();
        expect(addresses.phoebe).toBeDefined();
    });
});

describe('phoebe ProductModule.explainError', () => {
    it('routes a phoebe-owned code to the phoebe table', () => {
        // Pick any code phoebe's SDK has — explainError just needs to
        // return origin: 'phoebe' for an in-range code. Code 161 is the
        // BLS-signature failure in phoebe (same convention across titon
        // protocols — 160-169 = BLS / crypto).
        const e = phoebe.explainError(161);
        expect(e.origin).toBe('phoebe');
        expect(e.name.length).toBeGreaterThan(0);
    });

    it('returns origin=unknown for codes outside its range', () => {
        const e = phoebe.explainError(9999);
        expect(e.origin).toBe('unknown');
    });
});

describe('phoebe ProductModule.doctorInstallChecks', () => {
    it('contributes only the phoebe-sdk SDK-resolves check (atlas covered by fortuna)', () => {
        const checks = phoebe.doctorInstallChecks();
        expect(checks).toHaveLength(1);
        expect(checks.map((c) => c.name)).toEqual(['@titon-network/phoebe-sdk resolves']);
    });
});
