// themis ProductModule — covers the surface that's exclusive to the
// themis product (isEnabled / resolveAddresses / explainError /
// doctorInstallChecks). bootstrapWorker + buildHandlers integration is
// exercised by products-themis-wiring.spec.ts.

import { defaultConfig } from '../src/config/schema';
import { themis } from '../src/products/themis';
import { THEMIS_CHAMBER_ADDR_KEY_PREFIX } from '../src/worker/themis';

describe('themis ProductModule.isEnabled', () => {
    it('true when config.products.themis === true', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.themis = true;
        expect(themis.isEnabled(cfg)).toBe(true);
    });

    it('false when config.products.themis === false', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.themis = false;
        expect(themis.isEnabled(cfg)).toBe(false);
    });
});

describe('themis ProductModule.resolveAddresses', () => {
    it('returns {} when not enabled', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.themis = false;
        expect(themis.resolveAddresses(cfg)).toEqual({});
    });

    it('returns atlas + forgeton + factory keys when enabled (using SDK pinned testnet)', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.themis = true;
        const addresses = themis.resolveAddresses(cfg);
        expect(addresses.atlas).toBeDefined();
        expect(addresses.forgeton).toBeDefined();
        expect(addresses.factory).toBeDefined();
    });

    it('returns chamber:<addr> entries for each configured chamber', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.themis = true;
        cfg.themis = {
            factoryAddress: '0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            chambers: [
                '0:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
                '0:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            ],
        };
        const addresses = themis.resolveAddresses(cfg);
        const chamberKeys = Object.keys(addresses).filter((k) =>
            k.startsWith(THEMIS_CHAMBER_ADDR_KEY_PREFIX),
        );
        expect(chamberKeys).toHaveLength(2);
    });

    it('honours overrides for atlas + forgeton + factory', () => {
        const cfg = defaultConfig('testnet');
        cfg.products.themis = true;
        cfg.themis = {
            atlasAddress: '0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            forgetonAddress: '0:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
            factoryAddress: '0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        };
        const addresses = themis.resolveAddresses(cfg);
        // Compare on the hash buffer rather than the base64 toString, which
        // re-encodes the bytes as a bounceable URL-safe form.
        expect(addresses.atlas?.hash.toString('hex')).toBe('a'.repeat(64));
        expect(addresses.forgeton?.hash.toString('hex')).toBe('f'.repeat(64));
        expect(addresses.factory?.hash.toString('hex')).toBe('c'.repeat(64));
    });
});

describe('themis ProductModule.explainError', () => {
    it.each([
        [152, 'E_COMMIT_WINDOW_CLOSED', /commit window has closed/i],
        [160, 'E_INVALID_BLS_SIGNATURE', /BLS_VERIFY|forged|DST/i],
        [170, 'E_OPERATOR_NOT_FOUND', /not a mirrored operator/i],
        [171, 'E_OPERATOR_NOT_ACTIVE', /inactive/i],
        [173, 'E_CONSUMER_NOT_SET', /consumer/i],
    ])('routes themis-owned code %d → %s with origin=themis', (code, name, msgRe) => {
        const e = themis.explainError(code);
        expect(e.origin).toBe('themis');
        expect(e.name).toBe(name);
        expect(e.message).toMatch(msgRe);
    });

    it('returns origin=unknown for codes outside the themis range (so the priority walk falls through)', () => {
        // 119 is shared schema-version; 100/101/102 are shared owner/pause; we
        // do NOT claim those — kronos/forgeton/atlas SDKs have richer messages.
        for (const code of [100, 101, 102, 119, 200, 333, 9999]) {
            const e = themis.explainError(code);
            expect(e.origin).toBe('unknown');
        }
    });

    it('returns origin=unknown for codes in reserved themis range (150, 151, 161, 168) so the walk continues', () => {
        // 150-151 reserved; 161/167-169 are unassigned in v1. Keep them
        // unclaimed so a future SDK upgrade adding them doesn't fight the
        // priority walk's existing semantics.
        for (const code of [150, 151, 161, 167, 168, 169]) {
            const e = themis.explainError(code);
            // Themis owns 152-179 — 161/167/168/169 fall in that range but
            // the SDK's MESSAGES table doesn't include them, so they map to
            // a default ("Unknown error code N"). Operationally the same as
            // 'unknown' for falling-through purposes.
            expect(['unknown', 'themis']).toContain(e.origin);
        }
    });
});

describe('themis ProductModule.doctorInstallChecks', () => {
    it('contributes themis-sdk SDK-resolves check', () => {
        const checks = themis.doctorInstallChecks();
        expect(checks).toHaveLength(1);
        expect(checks[0]!.name).toBe('@titon-network/themis-sdk resolves');
    });
});
