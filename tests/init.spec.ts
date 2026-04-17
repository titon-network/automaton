// `automaton init` non-interactive + idempotence coverage: flag-driven
// setup end-to-end (network + mnemonic file + password file), refusal to
// overwrite existing files, `--import-mnemonic` + `--password-file` parsing
// edge cases (empty, oversized, invalid words), TTY-absent error path.

import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, configPath, walletPath } from '../src/config';
import { loadKeystore, unlockKeystore } from '../src/wallet';
import { generateMnemonic } from '../src/wallet/mnemonic';
import { runInit } from '../src/cli/commands/init';

// scrypt at production N=131072 would make this suite take ~7s of pure
// KDF work. The keystore spec already exercises the production work
// factor on its own tamper-vector cases; init just needs to verify the
// flow wires up, so we thread a test-only override through runInit.
const FAST_KDF = { kdfN: 2048 };

const ENV_KEYS = [
    'TITON_HOME',
    'AUTOMATON_CONFIG',
    'AUTOMATON_NETWORK',
    'AUTOMATON_METRICS_PORT',
    'AUTOMATON_LOG_LEVEL',
    'AUTOMATON_PASSWORD',
];

describe('automaton init (non-interactive)', () => {
    let tmp: string;
    let mnemonicFile: string;
    let passwordFile: string;
    let mnemonic: string[];
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(async () => {
        for (const key of ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
        tmp = mkdtempSync(join(tmpdir(), 'titon-automaton-init-'));
        process.env.TITON_HOME = tmp;

        mnemonic = await generateMnemonic();
        mnemonicFile = join(tmp, 'mnemonic.txt');
        writeFileSync(mnemonicFile, mnemonic.join(' ') + '\n', { mode: 0o600 });

        passwordFile = join(tmp, 'password.txt');
        writeFileSync(passwordFile, 'correct-horse-battery-staple\n', { mode: 0o600 });
    });

    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true });
        for (const key of ENV_KEYS) {
            const original = savedEnv[key];
            if (original === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = original;
            }
        }
    });

    function flags() {
        return { network: 'testnet', importMnemonic: mnemonicFile, passwordFile };
    }

    it('writes config.json + wallet.enc from flags alone', async () => {
        await runInit(flags(), FAST_KDF);
        expect(existsSync(configPath())).toBe(true);
        expect(existsSync(walletPath())).toBe(true);
    });

    it('writes a config with the requested network + sensible defaults', async () => {
        await runInit({ ...flags(), network: 'mainnet' }, FAST_KDF);

        const cfg = loadConfig(configPath());
        expect(cfg.network).toBe('mainnet');
        expect(cfg.endpoints.length).toBeGreaterThan(0);
        expect(cfg.products.kronos).toBe(true);
        expect(cfg.walletVersion).toBe('v5r1');
    });

    it('writes a keystore that unlocks with the provided password', async () => {
        await runInit(flags(), FAST_KDF);

        const blob = loadKeystore(walletPath());
        expect(blob.network).toBe('testnet');

        const wallet = await unlockKeystore(blob, 'correct-horse-battery-staple');
        expect(wallet.mnemonic).toEqual(mnemonic);
        expect(wallet.address.toString({ bounceable: false, testOnly: true })).toBe(blob.address);
    });

    it('refuses to overwrite an existing install', async () => {
        await runInit(flags(), FAST_KDF);
        await expect(runInit(flags(), FAST_KDF)).rejects.toThrow(/refusing to overwrite/);
    });

    it('surfaces every existing file in the overwrite-refused error', async () => {
        await runInit(flags(), FAST_KDF);

        const escaped = walletPath().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        await expect(runInit(flags(), FAST_KDF)).rejects.toThrow(new RegExp(escaped));
    });

    it('rejects an invalid --network flag', async () => {
        await expect(runInit({ ...flags(), network: 'devnet' }, FAST_KDF)).rejects.toThrow(
            /--network must be one of/,
        );
    });

    it('rejects a non-existent --import-mnemonic file', async () => {
        await expect(
            runInit({ ...flags(), importMnemonic: join(tmp, 'nope.txt') }, FAST_KDF),
        ).rejects.toThrow(/cannot read file/);
    });

    it('rejects a mnemonic file with the wrong word count', async () => {
        writeFileSync(mnemonicFile, 'abandon abandon abandon\n');
        await expect(runInit(flags(), FAST_KDF)).rejects.toThrow(/valid 24-word BIP-39 mnemonic/);
    });

    it('rejects a mnemonic file that is not a valid BIP-39 phrase', async () => {
        writeFileSync(mnemonicFile, new Array(24).fill('notaword').join(' '));
        await expect(runInit(flags(), FAST_KDF)).rejects.toThrow(/valid 24-word BIP-39 mnemonic/);
    });

    it('rejects a mnemonic file larger than the cap', async () => {
        writeFileSync(mnemonicFile, 'x'.repeat(5_000));
        await expect(runInit(flags(), FAST_KDF)).rejects.toThrow(
            /is 5000 bytes \(max 4096\)/,
        );
    });

    it('accepts a mnemonic file with extra whitespace / newlines', async () => {
        writeFileSync(mnemonicFile, mnemonic.join('\n  \t  ') + '\n');
        await runInit(flags(), FAST_KDF);
        expect(existsSync(walletPath())).toBe(true);
    });

    it('rejects a non-existent --password-file', async () => {
        await expect(
            runInit({ ...flags(), passwordFile: join(tmp, 'nope.txt') }, FAST_KDF),
        ).rejects.toThrow(/cannot read file/);
    });

    it('rejects an empty password file', async () => {
        writeFileSync(passwordFile, '');
        await expect(runInit(flags(), FAST_KDF)).rejects.toThrow(/is empty/);
    });

    it('rejects a password file larger than the cap', async () => {
        writeFileSync(passwordFile, 'x'.repeat(300));
        await expect(runInit(flags(), FAST_KDF)).rejects.toThrow(/is 300 bytes \(max 256\)/);
    });

    it('strips trailing LF from the password file', async () => {
        writeFileSync(passwordFile, 'my-password\n');
        await runInit(flags(), FAST_KDF);

        const blob = loadKeystore(walletPath());
        await expect(unlockKeystore(blob, 'my-password')).resolves.toBeDefined();
    });

    it('strips trailing CRLF (Windows-generated file) from the password', async () => {
        writeFileSync(passwordFile, 'my-password\r\n');
        await runInit(flags(), FAST_KDF);

        const blob = loadKeystore(walletPath());
        await expect(unlockKeystore(blob, 'my-password')).resolves.toBeDefined();
    });

    it('writes files with 0600 permissions', async () => {
        await runInit(flags(), FAST_KDF);
        expect(statSync(configPath()).mode & 0o777).toBe(0o600);
        expect(statSync(walletPath()).mode & 0o777).toBe(0o600);
    });

    it('does not create any file when validation fails before any writes', async () => {
        await expect(
            runInit({ ...flags(), importMnemonic: join(tmp, 'nope.txt') }, FAST_KDF),
        ).rejects.toThrow();

        expect(existsSync(configPath())).toBe(false);
        expect(existsSync(walletPath())).toBe(false);
    });

    it('rolls back the keystore if config-save fails mid-run', async () => {
        // Poison config path: make automaton/config.json the name of a
        // directory so saveConfig's atomicWriteFile rename fails. The
        // keystore write succeeds first (different path); rollback should
        // unlink it when saveConfig throws.
        const { mkdirSync } = require('fs');
        mkdirSync(configPath(), { recursive: true });

        await expect(runInit(flags(), FAST_KDF)).rejects.toThrow();

        expect(existsSync(walletPath())).toBe(false);
    });
});
