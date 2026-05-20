// `automaton status` rendering + no-install rejection + mainnet no-chain
// skip. Pure-render cases exercise the output shape without touching the
// network; the integration path is covered by snapshot.spec.ts.

import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { toNano } from '@ton/core';
import { defaultConfig } from '../src/config/schema';
import type { Keystore } from '../src/wallet';
import { runInit } from '../src/cli/commands/init';
import { generateMnemonic } from '../src/wallet/mnemonic';
import {
    renderStatus,
    renderStatusJson,
    runStatus,
    type ChainSnapshot,
} from '../src/cli/commands/status';
import { KEYSTORE_VERSION } from '../src/wallet/keystore';
import { writeFileSync } from 'fs';

const ENV_KEYS = ['TITON_HOME', 'AUTOMATON_CONFIG', 'AUTOMATON_PASSWORD'];

function makeKeystore(overrides: Partial<Keystore> = {}): Keystore {
    return {
        version: KEYSTORE_VERSION,
        network: 'testnet',
        address: '0QBsK1tN7AiqL_Hovc1p6HdWC8tYFZ4wt-Jch1vg9arryx5N',
        publicKey: 'deadbeef',
        cipher: 'aes-256-gcm',
        kdf: 'scrypt',
        kdfParams: { N: 2048, r: 8, p: 1, salt: 'aa' },
        ciphertext: 'bb',
        nonce: 'cc',
        tag: 'dd',
        createdAt: '2026-04-17T00:00:00.000Z',
        ...overrides,
    };
}

describe('renderStatus (pure rendering)', () => {
    it('prints wallet address + network even with no chain connection', () => {
        const out = renderStatus({
            config: defaultConfig('testnet'),
            keystore: makeKeystore(),
            runtime: undefined,
            snapshot: undefined,
        });

        expect(out).toContain('Titon Automaton — status');
        expect(out).toContain('testnet');
        expect(out).toContain(makeKeystore().address);
        expect(out).toContain('balance:');
        expect(out).toContain('(unavailable)');
    });

    it('shows "not registered" when the pool returns null for this automaton', () => {
        const snapshot: ChainSnapshot = {
            balance: toNano('5.2'),
            automaton: null, // null = not registered
            errors: [],
        };

        const out = renderStatus({
            config: defaultConfig('testnet'),
            keystore: makeKeystore(),
            runtime: undefined,
            snapshot,
        });

        expect(out).toContain('5.2 TON');
        expect(out).toContain('not registered');
        expect(out).toContain('automaton stake register');
    });

    it('shows stake + slashCount when the pool returns a registered automaton', () => {
        const snapshot: ChainSnapshot = {
            balance: toNano('3.1'),
            automaton: {
                schemaVersion: 1,
                stake: toNano('10'),
                isActive: true,
                slashCount: 2,
                registeredAt: Math.floor(new Date('2026-04-01T12:00:00.000Z').getTime() / 1000),
                unstakeRequestedAt: 0,
            },
            activeAutomatonCount: 7n,
            errors: [],
        };

        const out = renderStatus({
            config: defaultConfig('testnet'),
            keystore: makeKeystore(),
            runtime: undefined,
            snapshot,
        });

        expect(out).toContain('status:');
        expect(out).toContain('active');
        expect(out).toContain('10 TON');
        expect(out).toContain('slashCount:');
        expect(out).toContain('2');
        expect(out).toContain('2026-04-01T12:00:00.000Z');
        expect(out).toContain('pool active count:');
        expect(out).toContain('7');
    });

    it('surfaces per-field chain errors without crashing', () => {
        const snapshot: ChainSnapshot = {
            errors: [
                'balance: ECONNRESET',
                'automaton: got 503',
            ],
        };

        const out = renderStatus({
            config: defaultConfig('testnet'),
            keystore: makeKeystore(),
            runtime: undefined,
            snapshot,
        });

        expect(out).toContain('Chain read errors:');
        expect(out).toContain('balance: ECONNRESET');
        expect(out).toContain('automaton: got 503');
    });

    it('shows the endpoint ring when multiple endpoints are configured', () => {
        const cfg = defaultConfig('testnet');
        cfg.endpoints = [
            { url: 'https://ep-a.example/api' },
            { url: 'https://ep-b.example/api' },
        ];
        const out = renderStatus({
            config: cfg,
            keystore: makeKeystore(),
            runtime: undefined,
            snapshot: undefined,
        });

        expect(out).toContain('[0]:');
        expect(out).toContain('https://ep-a.example/api');
        expect(out).toContain('[1]:');
        expect(out).toContain('https://ep-b.example/api');
    });
});

describe('renderStatusJson (machine-readable)', () => {
    it('emits stable JSON for a registered active automaton with bigint safety', () => {
        const snapshot: ChainSnapshot = {
            balance: toNano('3.5'),
            automaton: {
                schemaVersion: 1,
                stake: toNano('10'),
                isActive: true,
                slashCount: 2,
                registeredAt: Math.floor(new Date('2026-04-01T12:00:00.000Z').getTime() / 1000),
                unstakeRequestedAt: 0,
            },
            activeAutomatonCount: 7n,
            jobCount: 12n,
            accumulatedFees: toNano('0.5'),
            isPaused: false,
            errors: [],
        };

        const raw = renderStatusJson({
            config: defaultConfig('testnet'),
            keystore: makeKeystore(),
            runtime: undefined,
            snapshot,
        });

        const obj = JSON.parse(raw);
        expect(obj.network).toBe('testnet');
        expect(obj.wallet.address).toBe(makeKeystore().address);
        expect(obj.wallet.balance.nano).toBe(toNano('3.5').toString());
        expect(obj.wallet.balance.ton).toBe('3.5');
        expect(obj.automaton.state).toBe('active');
        expect(obj.automaton.isActive).toBe(true);
        expect(obj.automaton.slashCount).toBe(2);
        expect(obj.automaton.stake.nano).toBe(toNano('10').toString());
        expect(obj.automaton.registeredAt).toBe('2026-04-01T12:00:00.000Z');
        expect(obj.errors).toEqual([]);
        expect(obj.daemon.lockfile.kind).toBeDefined();
    });

    it('reports "not-registered" when the pool returns null', () => {
        const snapshot: ChainSnapshot = {
            balance: toNano('5.2'),
            automaton: null,
            errors: [],
        };
        const raw = renderStatusJson({
            config: defaultConfig('testnet'),
            keystore: makeKeystore(),
            runtime: undefined,
            snapshot,
        });
        const obj = JSON.parse(raw);
        expect(obj.automaton.state).toBe('not-registered');
        expect(obj.automaton.stake).toBeUndefined();
    });

    it('reports "unavailable" on a chain-read miss and still emits valid JSON', () => {
        const raw = renderStatusJson({
            config: defaultConfig('testnet'),
            keystore: makeKeystore(),
            runtime: undefined,
            snapshot: undefined,
        });
        const obj = JSON.parse(raw);
        expect(obj.automaton.state).toBe('unavailable');
        expect(obj.wallet.balance).toBeNull();
        expect(obj.errors).toEqual([]);
    });

    it('does not leak endpoint apiKey values', () => {
        const cfg = defaultConfig('testnet');
        cfg.endpoints = [{ url: 'https://ep.example/api', apiKey: 'SUPERSECRET' }];
        const raw = renderStatusJson({
            config: cfg,
            keystore: makeKeystore(),
            runtime: undefined,
            snapshot: undefined,
        });
        expect(raw).not.toContain('SUPERSECRET');
        const obj = JSON.parse(raw);
        expect(obj.endpoints.configured[0].url).toBe('https://ep.example/api');
        expect(obj.endpoints.configured[0].apiKey).toBeUndefined();
    });

    it('preserves snapshot errors in a top-level array', () => {
        const snapshot: ChainSnapshot = {
            errors: ['balance: ECONNRESET', 'automaton: got 503'],
        };
        const raw = renderStatusJson({
            config: defaultConfig('testnet'),
            keystore: makeKeystore(),
            runtime: undefined,
            snapshot,
        });
        const obj = JSON.parse(raw);
        expect(obj.errors).toEqual(['balance: ECONNRESET', 'automaton: got 503']);
    });
});

describe('runStatus (installation required)', () => {
    const savedEnv: Record<string, string | undefined> = {};
    let tmp: string;

    beforeEach(() => {
        for (const key of ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
        tmp = mkdtempSync(join(tmpdir(), 'titon-status-'));
        process.env.TITON_HOME = tmp;
    });

    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true });
        for (const key of ENV_KEYS) {
            const original = savedEnv[key];
            if (original === undefined) delete process.env[key];
            else process.env[key] = original;
        }
    });

    it('refuses with a pointer to `init` when config is absent', async () => {
        await expect(runStatus()).rejects.toThrow(/no config/);
        await expect(runStatus()).rejects.toThrow(/automaton init/);
    });

    it('refuses with a pointer to `init` when only keystore is absent', async () => {
        // Write a minimal valid config, no keystore.
        const { saveConfig, configPath } = require('../src/config');
        saveConfig(defaultConfig('testnet'), configPath());

        await expect(runStatus()).rejects.toThrow(/no keystore/);
    });

    it('on a mainnet install, prints status with mainnet pool/registry addresses', async () => {
        const mnemonic = await generateMnemonic();
        const mnemonicFile = join(tmp, 'mnemonic.txt');
        const passwordFile = join(tmp, 'pw.txt');
        writeFileSync(mnemonicFile, mnemonic.join(' '));
        writeFileSync(passwordFile, 'testpw123');
        await runInit(
            { network: 'mainnet', importMnemonic: mnemonicFile, passwordFile },
            { kdfN: 2048 },
        );

        const output = await runStatus();
        expect(output).toContain('mainnet');
        // Mainnet is now live — no "deployment not live" note.
        expect(output).not.toContain('mainnet deployment is not yet live');
        // Pool + Kronos sections render even if chain reads time out
        // against toncenter from the test environment.
        expect(output).toContain('Pool');
        expect(output).toContain('Kronos');
        expect(output).toContain('registry:');
    });
});
