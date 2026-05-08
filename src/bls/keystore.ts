// BLS12-381 secret key at rest. Mirrors src/wallet/keystore.ts — scrypt
// (memory-hard KDF) + AES-256-GCM (authenticated encryption). Identical
// security discipline; only the payload type differs (32-byte BLS scalar
// instead of a BIP-39 mnemonic).
//
// BLS secret is a 32-byte big-endian integer < curve order. We store the
// 48-byte G1 pubkey (compressed, min-pk ciphersuite) in plaintext so
// read-only operations (pubkey print, status) don't need a password.
//
// On-disk shape (JSON), bls.enc:
//   {
//     "version": 1,
//     "publicKey": "<hex, 96 chars = 48 bytes>",  // G1 pkShare, compressed
//     "cipher": "aes-256-gcm",
//     "kdf": "scrypt",
//     "kdfParams": { "N": ..., "r": 8, "p": 1, "salt": "<hex>" },
//     "ciphertext": "<hex, 64 chars = 32 bytes>",
//     "nonce": "<hex>",
//     "tag": "<hex>",
//     "createdAt": "2026-04-23T..."
//   }
//
// Notes:
//   - Password is shared with the wallet keystore (operators unlock both at
//     once in the daemon). No separate BLS password today; a future `--bls-
//     password` split is easy because the keystore is fully standalone.
//   - `network` is NOT stored — BLS keys are network-agnostic (same pkShare
//     works for whatever Atlas group the operator registered with).

import { existsSync, readFileSync } from 'fs';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { z } from 'zod';
import { blsPath } from '../config/paths';
import { atomicWriteFile } from '../util/atomic-write';
import { blsPublicKey } from '@titon-network/fortuna-sdk';

export const BLS_KEYSTORE_VERSION = 1;

// Even-length hex — `Buffer.from('abc', 'hex')` silently truncates the
// trailing nibble. See src/wallet/keystore.ts for the full rationale.
const HEX = /^([0-9a-f]{2})+$/i;

// Bound on scrypt cost — a tampered keystore with N=2^30 would lock the
// process for hours during unlock. Same ceiling as the wallet keystore.
const MAX_KDF_N = 1 << 20;

export const BlsKeystoreSchema = z.object({
    version: z.literal(BLS_KEYSTORE_VERSION),
    // G1 pkShare (compressed, 48 bytes → 96 hex chars). Plaintext so a
    // locked daemon can still show / register it.
    publicKey: z.string().regex(HEX).length(96),
    cipher: z.literal('aes-256-gcm'),
    kdf: z.literal('scrypt'),
    kdfParams: z.object({
        N: z.number().int().positive().max(MAX_KDF_N),
        r: z.number().int().positive().max(64),
        p: z.number().int().positive().max(64),
        salt: z.string().regex(HEX),
    }),
    ciphertext: z.string().regex(HEX),
    nonce: z.string().regex(HEX),
    tag: z.string().regex(HEX),
    createdAt: z.string(),
});
export type BlsKeystore = z.infer<typeof BlsKeystoreSchema>;

export class WrongBlsPasswordError extends Error {
    constructor() {
        super('BLS keystore decryption failed — wrong password or corrupt data');
        this.name = 'WrongBlsPasswordError';
    }
}

export class BlsKeystoreNotFoundError extends Error {
    constructor(public readonly path: string) {
        super(
            `BLS keystore not found at ${path}\n` +
                `Run \`automaton bls keygen\` to create one — required when products.fortuna is enabled.`,
        );
        this.name = 'BlsKeystoreNotFoundError';
    }
}

export class BlsKeystoreValidationError extends Error {
    constructor(public readonly path: string, public readonly issues: string[]) {
        super(`BLS keystore at ${path} is malformed:\n` + issues.map((i) => `  ${i}`).join('\n'));
        this.name = 'BlsKeystoreValidationError';
    }
}

// Same scrypt params as the wallet keystore — see src/wallet/keystore.ts for
// the rationale (N=2^17 ≈ 300-500 ms on a modern CPU; maxmem lifted so N runs).
const DEFAULT_KDF_N = 131072;
const KDF_R = 8;
const KDF_P = 1;
const KEY_LEN = 32;
const IV_LEN = 12;
const SALT_LEN = 16;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

export interface BlsLockOptions {
    /** scrypt cost parameter. Defaults to 2^17 (~300-500 ms). Tests pass a low value for speed. */
    kdfN?: number;
}

export function lockBlsKeystore(
    secret: Uint8Array,
    password: string,
    options: BlsLockOptions = {},
): BlsKeystore {
    if (secret.length !== 32) {
        throw new Error(`BLS secret must be 32 bytes, got ${secret.length}`);
    }
    const kdfN = options.kdfN ?? DEFAULT_KDF_N;
    const pubkey = Buffer.from(blsPublicKey(Buffer.from(secret)));
    if (pubkey.length !== 48) {
        throw new Error(`BLS pubkey derivation returned ${pubkey.length} bytes, expected 48`);
    }

    const salt = randomBytes(SALT_LEN);
    const key = scryptSync(password, salt, KEY_LEN, {
        N: kdfN,
        r: KDF_R,
        p: KDF_P,
        maxmem: SCRYPT_MAXMEM,
    });
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(secret)), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
        version: BLS_KEYSTORE_VERSION,
        publicKey: pubkey.toString('hex'),
        cipher: 'aes-256-gcm',
        kdf: 'scrypt',
        kdfParams: { N: kdfN, r: KDF_R, p: KDF_P, salt: salt.toString('hex') },
        ciphertext: ciphertext.toString('hex'),
        nonce: iv.toString('hex'),
        tag: tag.toString('hex'),
        createdAt: new Date().toISOString(),
    };
}

export function unlockBlsKeystore(blob: BlsKeystore, password: string): Buffer {
    const salt = Buffer.from(blob.kdfParams.salt, 'hex');
    const key = scryptSync(password, salt, KEY_LEN, {
        N: blob.kdfParams.N,
        r: blob.kdfParams.r,
        p: blob.kdfParams.p,
        maxmem: SCRYPT_MAXMEM,
    });

    const iv = Buffer.from(blob.nonce, 'hex');
    const tag = Buffer.from(blob.tag, 'hex');
    const ciphertext = Buffer.from(blob.ciphertext, 'hex');

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    let secret: Buffer;
    try {
        secret = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
        throw new WrongBlsPasswordError();
    }

    if (secret.length !== 32) {
        throw new WrongBlsPasswordError();
    }

    // Defense in depth — derive the pubkey and compare. Catches a tampered
    // plaintext publicKey that coincidentally passed hex validation.
    const derived = Buffer.from(blsPublicKey(secret)).toString('hex');
    if (derived !== blob.publicKey) {
        throw new Error(
            `BLS keystore integrity check failed — stored pubkey ${blob.publicKey} ` +
                `does not match the pubkey derived from the decrypted secret (${derived}).`,
        );
    }

    return secret;
}

export function saveBlsKeystore(blob: BlsKeystore, path: string = blsPath()): void {
    const validated = BlsKeystoreSchema.parse(blob);
    atomicWriteFile(path, JSON.stringify(validated, null, 2) + '\n', 0o600);
}

export function loadBlsKeystore(path: string = blsPath()): BlsKeystore {
    if (!existsSync(path)) {
        throw new BlsKeystoreNotFoundError(path);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new BlsKeystoreValidationError(path, [`not valid JSON: ${msg}`]);
    }

    const result = BlsKeystoreSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues.map((issue) => {
            const where = issue.path.length > 0 ? issue.path.join('.') : '<root>';
            return `${where}: ${issue.message}`;
        });
        throw new BlsKeystoreValidationError(path, issues);
    }
    return result.data;
}

export function blsKeystoreExists(path: string = blsPath()): boolean {
    return existsSync(path);
}
