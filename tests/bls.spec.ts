// BLS keystore: scrypt+AES-GCM lock/unlock round-trip, tamper vectors,
// pubkey derivation consistency.
//
// Uses FAST_KDF (N=2048) so the 15+ cases run in seconds — same pattern as
// tests/wallet.spec.ts. The crypto primitives are identical to production;
// only the scrypt work factor differs, so round-trip / tampering logic is
// exercised honestly.

import {
    BLS_KEYSTORE_VERSION,
    BlsKeystoreNotFoundError,
    BlsKeystoreValidationError,
    WrongBlsPasswordError,
    blsKeystoreExists,
    blsPublicKey,
    loadBlsKeystore,
    lockBlsKeystore,
    randomBlsSecret,
    saveBlsKeystore,
    unlockBlsKeystore,
} from '../src/bls';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const FAST_KDF = { kdfN: 2048 };
const PW = 'hunter2-hunter2';

function flipLastByteHex(hex: string): string {
    const last = hex.slice(-2);
    const flipped = (parseInt(last, 16) ^ 0xff).toString(16).padStart(2, '0');
    return hex.slice(0, -2) + flipped;
}

describe('randomBlsSecret', () => {
    it('produces a 32-byte secret', () => {
        const s = randomBlsSecret();
        expect(s.length).toBe(32);
    });

    it('two calls produce different secrets', () => {
        const a = randomBlsSecret();
        const b = randomBlsSecret();
        expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    });
});

describe('blsPublicKey derivation', () => {
    it('derives a 48-byte compressed G1 point', () => {
        const pk = blsPublicKey(Buffer.from(randomBlsSecret()));
        expect(pk.length).toBe(48);
    });

    it('is deterministic for the same secret', () => {
        const s = randomBlsSecret();
        const pk1 = blsPublicKey(Buffer.from(s));
        const pk2 = blsPublicKey(Buffer.from(s));
        expect(Buffer.from(pk1).equals(Buffer.from(pk2))).toBe(true);
    });

    it('different secrets produce different pubkeys', () => {
        const s1 = randomBlsSecret();
        const s2 = randomBlsSecret();
        const pk1 = Buffer.from(blsPublicKey(Buffer.from(s1)));
        const pk2 = Buffer.from(blsPublicKey(Buffer.from(s2)));
        expect(pk1.equals(pk2)).toBe(false);
    });
});

describe('lock/unlock round-trip', () => {
    it('unlock returns the same 32-byte secret', () => {
        const secret = randomBlsSecret();
        const blob = lockBlsKeystore(secret, PW, FAST_KDF);
        const recovered = unlockBlsKeystore(blob, PW);
        expect(recovered.equals(Buffer.from(secret))).toBe(true);
    });

    it('stored publicKey matches the secret-derived pubkey', () => {
        const secret = randomBlsSecret();
        const blob = lockBlsKeystore(secret, PW, FAST_KDF);
        const derived = Buffer.from(blsPublicKey(Buffer.from(secret))).toString('hex');
        expect(blob.publicKey).toBe(derived);
        expect(blob.publicKey.length).toBe(96);
    });

    it('blob has the expected shape', () => {
        const blob = lockBlsKeystore(randomBlsSecret(), PW, FAST_KDF);
        expect(blob.version).toBe(BLS_KEYSTORE_VERSION);
        expect(blob.cipher).toBe('aes-256-gcm');
        expect(blob.kdf).toBe('scrypt');
        expect(blob.kdfParams.N).toBe(FAST_KDF.kdfN);
        expect(blob.ciphertext.length).toBe(64); // 32 bytes hex
        expect(blob.nonce.length).toBe(24); // 12 bytes hex
        expect(blob.tag.length).toBe(32); // 16 bytes hex
    });

    it('two locks produce different ciphertexts (fresh salt + nonce)', () => {
        const secret = randomBlsSecret();
        const a = lockBlsKeystore(secret, PW, FAST_KDF);
        const b = lockBlsKeystore(secret, PW, FAST_KDF);
        expect(a.ciphertext).not.toBe(b.ciphertext);
        expect(a.kdfParams.salt).not.toBe(b.kdfParams.salt);
        expect(a.nonce).not.toBe(b.nonce);
    });
});

describe('tamper vectors (should fail unlock)', () => {
    it('wrong password', () => {
        const blob = lockBlsKeystore(randomBlsSecret(), PW, FAST_KDF);
        expect(() => unlockBlsKeystore(blob, 'wrong-password')).toThrow(WrongBlsPasswordError);
    });

    it('flipped ciphertext byte', () => {
        const blob = lockBlsKeystore(randomBlsSecret(), PW, FAST_KDF);
        const tampered = { ...blob, ciphertext: flipLastByteHex(blob.ciphertext) };
        expect(() => unlockBlsKeystore(tampered, PW)).toThrow(WrongBlsPasswordError);
    });

    it('flipped auth tag byte', () => {
        const blob = lockBlsKeystore(randomBlsSecret(), PW, FAST_KDF);
        const tampered = { ...blob, tag: flipLastByteHex(blob.tag) };
        expect(() => unlockBlsKeystore(tampered, PW)).toThrow(WrongBlsPasswordError);
    });

    it('flipped nonce byte', () => {
        const blob = lockBlsKeystore(randomBlsSecret(), PW, FAST_KDF);
        const tampered = { ...blob, nonce: flipLastByteHex(blob.nonce) };
        expect(() => unlockBlsKeystore(tampered, PW)).toThrow(WrongBlsPasswordError);
    });

    it('flipped salt byte', () => {
        const blob = lockBlsKeystore(randomBlsSecret(), PW, FAST_KDF);
        const tampered = {
            ...blob,
            kdfParams: { ...blob.kdfParams, salt: flipLastByteHex(blob.kdfParams.salt) },
        };
        expect(() => unlockBlsKeystore(tampered, PW)).toThrow(WrongBlsPasswordError);
    });

    it('tampered publicKey (metadata mismatch post-decrypt)', () => {
        const blob = lockBlsKeystore(randomBlsSecret(), PW, FAST_KDF);
        // Swap publicKey to another valid-looking but wrong pubkey — decryption
        // succeeds (AES-GCM tag covers ciphertext/nonce/AAD only), but the
        // derived-vs-stored pubkey check rejects.
        const otherPk = Buffer.from(blsPublicKey(Buffer.from(randomBlsSecret()))).toString('hex');
        const tampered = { ...blob, publicKey: otherPk };
        expect(() => unlockBlsKeystore(tampered, PW)).toThrow(/integrity check/);
    });
});

describe('file persistence', () => {
    let dir: string;
    let path: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'automaton-bls-'));
        path = join(dir, 'bls.enc');
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('save + load round-trips', () => {
        const secret = randomBlsSecret();
        const blob = lockBlsKeystore(secret, PW, FAST_KDF);
        saveBlsKeystore(blob, path);

        const loaded = loadBlsKeystore(path);
        expect(loaded).toEqual(blob);

        const recovered = unlockBlsKeystore(loaded, PW);
        expect(recovered.equals(Buffer.from(secret))).toBe(true);
    });

    it('file is saved with 0600 permissions', () => {
        const blob = lockBlsKeystore(randomBlsSecret(), PW, FAST_KDF);
        saveBlsKeystore(blob, path);
        const mode = statSync(path).mode & 0o777;
        expect(mode).toBe(0o600);
    });

    it('load throws BlsKeystoreNotFoundError on missing file', () => {
        expect(() => loadBlsKeystore(join(dir, 'missing.enc'))).toThrow(BlsKeystoreNotFoundError);
    });

    it('load throws BlsKeystoreValidationError on invalid JSON', () => {
        const fs = require('fs');
        fs.writeFileSync(path, 'not json');
        expect(() => loadBlsKeystore(path)).toThrow(BlsKeystoreValidationError);
    });

    it('load throws BlsKeystoreValidationError on wrong schema', () => {
        const fs = require('fs');
        fs.writeFileSync(path, JSON.stringify({ version: 99 }));
        expect(() => loadBlsKeystore(path)).toThrow(BlsKeystoreValidationError);
    });

    it('blsKeystoreExists reports accurately', () => {
        expect(blsKeystoreExists(path)).toBe(false);
        const blob = lockBlsKeystore(randomBlsSecret(), PW, FAST_KDF);
        saveBlsKeystore(blob, path);
        expect(blsKeystoreExists(path)).toBe(true);
    });
});
