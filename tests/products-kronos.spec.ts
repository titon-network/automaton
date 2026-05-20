// kronos ProductModule — covers the surface that's exclusive to the
// kronos product (resolveAddresses / explainError / doctorInstallChecks).
// bootstrapWorker + buildHandlers integration is exercised by tick-once.spec.ts
// + Integration.spec.ts; this file keeps the unit-level checks isolated.

import { KRONOS_MAINNET } from '@titon-network/kronos-sdk';
import { defaultConfig } from '../src/config/schema';
import { kronos } from '../src/products/kronos';

describe('kronos ProductModule.isEnabled', () => {
    it('true when config.products.kronos === true', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.kronos = true;
        expect(kronos.isEnabled(cfg)).toBe(true);
    });

    it('false when config.products.kronos === false (specialised non-Kronos operator)', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.kronos = false;
        expect(kronos.isEnabled(cfg)).toBe(false);
    });
});

describe('kronos ProductModule.resolveAddresses', () => {
    it('returns {} when not enabled', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.kronos = false;
        expect(kronos.resolveAddresses(cfg)).toEqual({});
    });

    it('returns the testnet registry address when enabled', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.kronos = true;
        const addresses = kronos.resolveAddresses(cfg);
        expect(addresses.registry).toBeDefined();
    });

    it('returns the mainnet registry address when enabled', () => {
        const cfg = defaultConfig('mainnet');
        cfg.products.kronos = true;
        const addresses = kronos.resolveAddresses(cfg);
        expect(addresses.registry?.equals(KRONOS_MAINNET.registry)).toBe(true);
    });
});

describe('kronos ProductModule.explainError', () => {
    it('routes a kronos-owned code to the kronos table', () => {
        // 119 = E_BAD_SCHEMA_VERSION per kronos errors.tolk (shared/admin range).
        const e = kronos.explainError(119);
        expect(e.origin).toBe('kronos');
    });

    it('returns origin=unknown for codes outside its range', () => {
        const e = kronos.explainError(9999);
        expect(e.origin).toBe('unknown');
    });
});

describe('kronos ProductModule.doctorInstallChecks', () => {
    it('contributes a kronos-sdk SDK-resolves check', () => {
        const checks = kronos.doctorInstallChecks();
        expect(checks).toHaveLength(1);
        expect(checks[0]?.name).toBe('@titon-network/kronos-sdk resolves');
    });
});
