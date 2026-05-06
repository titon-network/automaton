// Wallet lifecycle: mnemonic generation + BIP-39 validation, V5R1 key
// derivation (network-aware addressing), keystore scrypt+AES-GCM lock/unlock
// round-trip, six tamper vectors (ciphertext/tag/salt/nonce/address/network),
// password prompt env fallback.

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    KEYSTORE_VERSION,
    KeystoreNotFoundError,
    KeystoreValidationError,
    WrongPasswordError,
    generateMnemonic,
    getPassword,
    keystoreExists,
    loadKeystore,
    lockKeystore,
    mnemonicToKeys,
    saveKeystore,
    unlockKeystore,
    validateMnemonic,
    walletFromMnemonic,
} from '../src/wallet';

// scrypt with N=131072 is ~400ms per unlock. Fine for ops, too slow for a
// test suite that runs 15 keystore cases in sequence. Drop to N=2048 for
// tests — ~5ms — the crypto primitives are identical, only the work factor
// differs, so the round-trip / tampering logic is still exercised honestly.
const FAST_KDF = { kdfN: 2048 };

function flipLastByteHex(hex: string): string {
    const last = hex.slice(-2);
    const flipped = (parseInt(last, 16) ^ 0xff).toString(16).padStart(2, '0');
    return hex.slice(0, -2) + flipped;
}

describe('mnemonic', () => {
    it('generates a 24-word mnemonic', async () => {
        const m = await generateMnemonic();
        expect(m).toHaveLength(24);
        for (const word of m) {
            expect(typeof word).toBe('string');
            expect(word.length).toBeGreaterThan(0);
        }
    });

    it('generated mnemonic validates', async () => {
        const m = await generateMnemonic();
        expect(await validateMnemonic(m)).toBe(true);
    });

    it('rejects a mnemonic of the wrong length', async () => {
        expect(await validateMnemonic(['abandon', 'abandon', 'abandon'])).toBe(false);
    });

    it('rejects random words that form an invalid 24-word sequence', async () => {
        const bogus = Array.from({ length: 24 }, () => 'abandon');
        expect(await validateMnemonic(bogus)).toBe(false);
    });

    it('mnemonicToKeys yields a 32-byte public key', async () => {
        const m = await generateMnemonic();
        const kp = await mnemonicToKeys(m);
        expect(kp.publicKey).toHaveLength(32);
        expect(kp.secretKey).toHaveLength(64);
    });
});

describe('walletFromMnemonic', () => {
    it('same mnemonic yields different addresses on testnet vs mainnet', async () => {
        const m = await generateMnemonic();
        const testnet = await walletFromMnemonic(m, 'testnet');
        const mainnet = await walletFromMnemonic(m, 'mainnet');
        expect(testnet.address.equals(mainnet.address)).toBe(false);
        expect(testnet.network).toBe('testnet');
        expect(mainnet.network).toBe('mainnet');
    });

    it('deterministic: same mnemonic + network → same address', async () => {
        const m = await generateMnemonic();
        const a = await walletFromMnemonic(m, 'testnet');
        const b = await walletFromMnemonic(m, 'testnet');
        expect(a.address.equals(b.address)).toBe(true);
        expect(Buffer.from(a.keyPair.publicKey).equals(Buffer.from(b.keyPair.publicKey))).toBe(true);
    });
});

describe('keystore', () => {
    let tmp: string;

    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), 'titon-automaton-keystore-'));
    });

    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    it('round-trip lock → unlock recovers the mnemonic', async () => {
        const m = await generateMnemonic();
        const blob = await lockKeystore(m, 'correct-horse-battery-staple', 'testnet', FAST_KDF);
        const wallet = await unlockKeystore(blob, 'correct-horse-battery-staple');
        expect(wallet.mnemonic).toEqual(m);
        expect(wallet.network).toBe('testnet');
    });

    it('stored address matches unlocked wallet address', async () => {
        const m = await generateMnemonic();
        const blob = await lockKeystore(m, 'hunter22!', 'testnet', FAST_KDF);
        const wallet = await unlockKeystore(blob, 'hunter22!');
        expect(wallet.address.toString({ bounceable: false, testOnly: true })).toBe(blob.address);
    });

    it('stored publicKey matches derived publicKey', async () => {
        const m = await generateMnemonic();
        const blob = await lockKeystore(m, 'hunter22!', 'mainnet', FAST_KDF);
        const wallet = await unlockKeystore(blob, 'hunter22!');
        expect(Buffer.from(wallet.keyPair.publicKey).toString('hex')).toBe(blob.publicKey);
    });

    it('lock sets version + kdf + cipher fields', async () => {
        const m = await generateMnemonic();
        const blob = await lockKeystore(m, 'hunter22!', 'testnet', FAST_KDF);
        expect(blob.version).toBe(KEYSTORE_VERSION);
        expect(blob.kdf).toBe('scrypt');
        expect(blob.cipher).toBe('aes-256-gcm');
        expect(blob.kdfParams.r).toBe(8);
        expect(blob.kdfParams.p).toBe(1);
        expect(blob.kdfParams.salt).toMatch(/^[0-9a-f]{32}$/);
        expect(blob.nonce).toMatch(/^[0-9a-f]{24}$/);
        expect(blob.tag).toMatch(/^[0-9a-f]{32}$/);
    });

    it('re-locking the same mnemonic yields different salt + nonce', async () => {
        const m = await generateMnemonic();
        const a = await lockKeystore(m, 'hunter22!', 'testnet', FAST_KDF);
        const b = await lockKeystore(m, 'hunter22!', 'testnet', FAST_KDF);
        expect(a.kdfParams.salt).not.toBe(b.kdfParams.salt);
        expect(a.nonce).not.toBe(b.nonce);
        expect(a.ciphertext).not.toBe(b.ciphertext);
        // Same address though — deterministic from (mnemonic, network).
        expect(a.address).toBe(b.address);
    });

    describe('rejections', () => {
        it('wrong password throws WrongPasswordError', async () => {
            const m = await generateMnemonic();
            const blob = await lockKeystore(m, 'correct-horse', 'testnet', FAST_KDF);
            await expect(unlockKeystore(blob, 'wrong-horse')).rejects.toThrow(WrongPasswordError);
        });

        it('tampered ciphertext throws WrongPasswordError', async () => {
            const m = await generateMnemonic();
            const blob = await lockKeystore(m, 'correct-horse', 'testnet', FAST_KDF);
            const tampered = { ...blob, ciphertext: flipLastByteHex(blob.ciphertext) };
            await expect(unlockKeystore(tampered, 'correct-horse')).rejects.toThrow(WrongPasswordError);
        });

        it('tampered auth tag throws WrongPasswordError', async () => {
            const m = await generateMnemonic();
            const blob = await lockKeystore(m, 'correct-horse', 'testnet', FAST_KDF);
            const tampered = { ...blob, tag: flipLastByteHex(blob.tag) };
            await expect(unlockKeystore(tampered, 'correct-horse')).rejects.toThrow(WrongPasswordError);
        });

        it('tampered salt (→ wrong derived key) throws WrongPasswordError', async () => {
            const m = await generateMnemonic();
            const blob = await lockKeystore(m, 'correct-horse', 'testnet', FAST_KDF);
            const tampered = {
                ...blob,
                kdfParams: { ...blob.kdfParams, salt: flipLastByteHex(blob.kdfParams.salt) },
            };
            await expect(unlockKeystore(tampered, 'correct-horse')).rejects.toThrow(WrongPasswordError);
        });

        it('tampered nonce (→ wrong keystream) throws WrongPasswordError', async () => {
            const m = await generateMnemonic();
            const blob = await lockKeystore(m, 'correct-horse', 'testnet', FAST_KDF);
            const tampered = { ...blob, nonce: flipLastByteHex(blob.nonce) };
            await expect(unlockKeystore(tampered, 'correct-horse')).rejects.toThrow(WrongPasswordError);
        });

        it('tampered network field triggers integrity check', async () => {
            const m = await generateMnemonic();
            // Lock on testnet, tamper to claim mainnet — ciphertext still decrypts
            // (network isn't under AES-GCM's auth), but derived address won't match.
            const blob = await lockKeystore(m, 'correct-horse', 'testnet', FAST_KDF);
            const tampered = { ...blob, network: 'mainnet' as const };
            await expect(unlockKeystore(tampered, 'correct-horse')).rejects.toThrow(/integrity check failed/);
        });
    });

    describe('disk I/O', () => {
        it('save + load round-trip preserves every field', async () => {
            const m = await generateMnemonic();
            const blob = await lockKeystore(m, 'correct-horse', 'testnet', FAST_KDF);
            const path = join(tmp, 'wallet.enc');
            saveKeystore(blob, path);
            expect(loadKeystore(path)).toEqual(blob);
        });

        it('save writes 0600 perms', async () => {
            const m = await generateMnemonic();
            const blob = await lockKeystore(m, 'correct-horse', 'testnet', FAST_KDF);
            const path = join(tmp, 'wallet.enc');
            saveKeystore(blob, path);
            expect(statSync(path).mode & 0o777).toBe(0o600);
        });

        it('keystoreExists returns false before save, true after', async () => {
            const path = join(tmp, 'wallet.enc');
            expect(keystoreExists(path)).toBe(false);
            const m = await generateMnemonic();
            saveKeystore(await lockKeystore(m, 'correct-horse', 'testnet', FAST_KDF), path);
            expect(keystoreExists(path)).toBe(true);
        });

        it('loadKeystore throws KeystoreNotFoundError when missing', () => {
            expect(() => loadKeystore(join(tmp, 'missing.enc'))).toThrow(KeystoreNotFoundError);
        });

        it('loadKeystore throws KeystoreValidationError on bad JSON', () => {
            const path = join(tmp, 'wallet.enc');
            writeFileSync(path, '{not valid');
            expect(() => loadKeystore(path)).toThrow(KeystoreValidationError);
            expect(() => loadKeystore(path)).toThrow(/not valid JSON/);
        });

        it('loadKeystore throws KeystoreValidationError on schema mismatch', () => {
            const path = join(tmp, 'wallet.enc');
            writeFileSync(path, JSON.stringify({ version: 1, cipher: 'totally-fake' }));
            expect(() => loadKeystore(path)).toThrow(KeystoreValidationError);
        });

        it('saveKeystore rejects an invalid blob before writing', async () => {
            const m = await generateMnemonic();
            const blob = await lockKeystore(m, 'correct-horse', 'testnet', FAST_KDF);
            const bogus = { ...blob, version: 99 } as never;
            const path = join(tmp, 'wallet.enc');
            expect(() => saveKeystore(bogus, path)).toThrow();
            expect(keystoreExists(path)).toBe(false);
        });
    });
});

describe('getPassword', () => {
    const saved = process.env.AUTOMATON_PASSWORD;

    afterEach(() => {
        if (saved === undefined) delete process.env.AUTOMATON_PASSWORD;
        else process.env.AUTOMATON_PASSWORD = saved;
    });

    it('returns AUTOMATON_PASSWORD when set', async () => {
        process.env.AUTOMATON_PASSWORD = 'hunter22!';
        expect(await getPassword()).toBe('hunter22!');
    });

    it('allowEnv=false bypasses env var (would prompt)', async () => {
        process.env.AUTOMATON_PASSWORD = 'hunter22!';
        // stdin isn't a TTY under jest, so this rejects — proving the env
        // fallback was skipped.
        await expect(getPassword({ allowEnv: false })).rejects.toThrow(/stdin is not a TTY/);
    });
});
