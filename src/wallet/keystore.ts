// Encrypted mnemonic at rest. scrypt (memory-hard KDF) + AES-256-GCM
// (authenticated encryption). A corrupt or password-mismatch keystore
// surfaces as WrongPasswordError — AES-GCM's auth tag is our integrity
// check, so there's no separate "tampered" vs "wrong password" path.
//
// On-disk shape (JSON), keystore.json:
//   {
//     "version": 1,
//     "network": "testnet",
//     "address": "0Q...",             // plaintext — derived from mnemonic,
//                                     //   used to sanity-check unlock
//     "publicKey": "<hex>",           // plaintext — same purpose
//     "cipher": "aes-256-gcm",
//     "kdf": "scrypt",
//     "kdfParams": { "N": ..., "r": 8, "p": 1, "salt": "<hex>" },
//     "ciphertext": "<hex>",
//     "nonce": "<hex>",               // 96-bit GCM IV
//     "tag": "<hex>",                 // 128-bit GCM auth tag
//     "createdAt": "2026-04-17T09:30:00.000Z"
//   }
//
// Security notes:
//   - Address + publicKey are stored plaintext so read-only operations
//     (`automaton status`) don't need to prompt for a password.
//   - scrypt N = 131072 (2^17) takes ~300-500 ms on a modern CPU — strong
//     enough to make offline brute-force against strong passwords painful,
//     fast enough that operator unlock doesn't feel laggy.
//   - scrypt's maxmem default (32 MB) is too low for N=131072 (needs ~128
//     MB); we pass 256 MB so the default params actually run.

import { existsSync, readFileSync } from 'fs';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { z } from 'zod';
import { walletPath } from '../config/paths';
import { NetworkSchema, type Network } from '../config/schema';
import { atomicWriteFile } from '../util/atomic-write';
import { validateMnemonic } from './mnemonic';
import { walletFromMnemonic, type AutomatonWallet } from './wallet';

export const KEYSTORE_VERSION = 1;

const HEX = /^[0-9a-f]+$/i;

export const KeystoreSchema = z.object({
    version: z.literal(KEYSTORE_VERSION),
    network: NetworkSchema,
    address: z.string().min(1),
    publicKey: z.string().regex(HEX),
    cipher: z.literal('aes-256-gcm'),
    kdf: z.literal('scrypt'),
    kdfParams: z.object({
        N: z.number().int().positive(),
        r: z.number().int().positive(),
        p: z.number().int().positive(),
        salt: z.string().regex(HEX),
    }),
    ciphertext: z.string().regex(HEX),
    nonce: z.string().regex(HEX),
    tag: z.string().regex(HEX),
    createdAt: z.string(),
});
export type Keystore = z.infer<typeof KeystoreSchema>;

export class WrongPasswordError extends Error {
    constructor() {
        super('keystore decryption failed — wrong password or corrupt data');
        this.name = 'WrongPasswordError';
    }
}

export class KeystoreNotFoundError extends Error {
    constructor(public readonly path: string) {
        super(`keystore not found at ${path}\nRun \`automaton init\` to create one.`);
        this.name = 'KeystoreNotFoundError';
    }
}

export class KeystoreValidationError extends Error {
    constructor(public readonly path: string, public readonly issues: string[]) {
        super(`keystore at ${path} is malformed:\n` + issues.map((i) => `  ${i}`).join('\n'));
        this.name = 'KeystoreValidationError';
    }
}

// Defaults tuned for "interactive unlock" — see security notes at top of file.
// DEFAULT_KDF_N matches ethers.js (v6) wallet encryption default. Do NOT
// lower this value for production use — tests override to 2^11 via the
// `kdfN` LockOptions field, which is fine because the crypto primitives
// exercised are identical; only the work factor differs.
const DEFAULT_KDF_N = 131072;
const KDF_R = 8;
const KDF_P = 1;
const KEY_LEN = 32;
const IV_LEN = 12;
const SALT_LEN = 16;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

export interface LockOptions {
    /** scrypt cost parameter. Defaults to 2^17 (~300-500 ms). Tests pass a low value for speed. */
    kdfN?: number;
}

export async function lockKeystore(
    mnemonic: string[],
    password: string,
    network: Network,
    options: LockOptions = {},
): Promise<Keystore> {
    const wallet = await walletFromMnemonic(mnemonic, network);
    const kdfN = options.kdfN ?? DEFAULT_KDF_N;
    const plaintext = mnemonic.join(' ');

    const salt = randomBytes(SALT_LEN);
    const key = scryptSync(password, salt, KEY_LEN, { N: kdfN, r: KDF_R, p: KDF_P, maxmem: SCRYPT_MAXMEM });
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
        version: KEYSTORE_VERSION,
        network,
        address: wallet.address.toString({ bounceable: false, testOnly: network === 'testnet' }),
        publicKey: Buffer.from(wallet.keyPair.publicKey).toString('hex'),
        cipher: 'aes-256-gcm',
        kdf: 'scrypt',
        kdfParams: { N: kdfN, r: KDF_R, p: KDF_P, salt: salt.toString('hex') },
        ciphertext: ciphertext.toString('hex'),
        nonce: iv.toString('hex'),
        tag: tag.toString('hex'),
        createdAt: new Date().toISOString(),
    };
}

export async function unlockKeystore(blob: Keystore, password: string): Promise<AutomatonWallet> {
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

    let plaintext: string;
    try {
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
        // `decipher.final()` throws on auth-tag mismatch — covers wrong
        // password, tampered ciphertext, tampered tag, tampered salt, etc.
        throw new WrongPasswordError();
    }

    const mnemonic = plaintext.split(/\s+/).filter((w) => w.length > 0);

    // Defense in depth: if somehow the GCM tag matched but produced garbage,
    // the mnemonic won't validate. Can't happen with honest inputs.
    if (!(await validateMnemonic(mnemonic))) {
        throw new WrongPasswordError();
    }

    const wallet = await walletFromMnemonic(mnemonic, blob.network);

    // The derived address should match what was stored at lock time. The
    // network field is plaintext (not under the AES-GCM tag), so flipping
    // testnet↔mainnet in the file would otherwise silently produce a wallet
    // for the wrong network. This check catches that.
    const derivedAddress = wallet.address.toString({
        bounceable: false,
        testOnly: blob.network === 'testnet',
    });
    if (derivedAddress !== blob.address) {
        throw new Error(
            `keystore integrity check failed — stored address ${blob.address} ` +
                `does not match derived address ${derivedAddress} for network ${blob.network}.\n` +
                `If you edited the keystore's 'network' field, restore it: the address ` +
                `is deterministic from (mnemonic, network) and both sides must agree.`,
        );
    }

    return wallet;
}

export function saveKeystore(blob: Keystore, path: string = walletPath()): void {
    const validated = KeystoreSchema.parse(blob);
    atomicWriteFile(path, JSON.stringify(validated, null, 2) + '\n', 0o600);
}

export function loadKeystore(path: string = walletPath()): Keystore {
    if (!existsSync(path)) {
        throw new KeystoreNotFoundError(path);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new KeystoreValidationError(path, [`not valid JSON: ${msg}`]);
    }

    const result = KeystoreSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues.map((issue) => {
            const where = issue.path.length > 0 ? issue.path.join('.') : '<root>';
            return `${where}: ${issue.message}`;
        });
        throw new KeystoreValidationError(path, issues);
    }
    return result.data;
}

export function keystoreExists(path: string = walletPath()): boolean {
    return existsSync(path);
}
