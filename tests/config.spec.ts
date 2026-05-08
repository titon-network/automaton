// Config load/save: zod validation, env overlay allow-list, default-config
// round-trip, typed-error classes for missing/malformed files, atomic-write
// file mode + path overrides via TITON_HOME / AUTOMATON_CONFIG.

import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    CONFIG_VERSION,
    ConfigEnvOverlayError,
    ConfigNotFoundError,
    ConfigValidationError,
    applyEnvOverlay,
    automatonDir,
    blsPath,
    configPath,
    defaultConfig,
    loadConfig,
    lockPath,
    logsDir,
    saveConfig,
    statePath,
    titonHome,
    walletPath,
} from '../src/config';

// Every env var this module cares about. Reset in afterEach so tests can't
// bleed state — a stray `AUTOMATON_NETWORK=mainnet` from a previous case
// would silently change every subsequent load.
const ENV_KEYS = [
    'TITON_HOME',
    'AUTOMATON_CONFIG',
    'AUTOMATON_NETWORK',
    'AUTOMATON_METRICS_PORT',
    'AUTOMATON_LOG_LEVEL',
    'AUTOMATON_ATLAS_ADDRESS',
    'AUTOMATON_FORTUNA_ADDRESS',
];

describe('config', () => {
    let tmp: string;
    let path: string;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const key of ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
        tmp = mkdtempSync(join(tmpdir(), 'titon-automaton-test-'));
        path = join(tmp, 'config.json');
    });

    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true });
        for (const key of ENV_KEYS) {
            const original = savedEnv[key];
            if (original === undefined) delete process.env[key];
            else process.env[key] = original;
        }
    });

    describe('round-trip', () => {
        it('testnet defaults save+load unchanged', () => {
            const cfg = defaultConfig('testnet');
            saveConfig(cfg, path);
            expect(loadConfig(path)).toEqual(cfg);
        });

        it('mainnet defaults save+load unchanged', () => {
            const cfg = defaultConfig('mainnet');
            saveConfig(cfg, path);
            expect(loadConfig(path)).toEqual(cfg);
        });

        it('default config matches CONFIG_VERSION', () => {
            expect(defaultConfig('testnet').configVersion).toBe(CONFIG_VERSION);
            expect(defaultConfig('mainnet').configVersion).toBe(CONFIG_VERSION);
        });

        it('saved file has 0600 perms', () => {
            saveConfig(defaultConfig('testnet'), path);
            expect(statSync(path).mode & 0o777).toBe(0o600);
        });

        it('saved file is pretty-printed JSON (diff-friendly)', () => {
            saveConfig(defaultConfig('testnet'), path);
            const raw = readFileSync(path, 'utf8');
            expect(raw).toContain('\n');
            expect(raw).toMatch(/\n$/);
        });

        it('overwriting an existing config succeeds', () => {
            saveConfig(defaultConfig('testnet'), path);
            saveConfig(defaultConfig('mainnet'), path);
            expect(loadConfig(path).network).toBe('mainnet');
        });
    });

    describe('validation errors', () => {
        it('missing file throws ConfigNotFoundError with a useful message', () => {
            let caught: unknown;
            try {
                loadConfig(path);
            } catch (err) {
                caught = err;
            }
            expect(caught).toBeInstanceOf(ConfigNotFoundError);
            expect((caught as Error).message).toContain(path);
            expect((caught as Error).message).toContain('automaton init');
        });

        it('invalid JSON throws ConfigValidationError', () => {
            writeFileSync(path, '{not valid json');
            expect(() => loadConfig(path)).toThrow(ConfigValidationError);
            expect(() => loadConfig(path)).toThrow(/not valid JSON/);
        });

        it('empty endpoints array rejected with clear message', () => {
            const cfg = { ...defaultConfig('testnet'), endpoints: [] };
            writeFileSync(path, JSON.stringify(cfg));
            expect(() => loadConfig(path)).toThrow(/at least one endpoint/);
        });

        it('wrong configVersion rejected', () => {
            const cfg = { ...defaultConfig('testnet'), configVersion: 99 };
            writeFileSync(path, JSON.stringify(cfg));
            expect(() => loadConfig(path)).toThrow(ConfigValidationError);
        });

        it('non-decimal TON amount rejected', () => {
            const cfg = { ...defaultConfig('testnet'), maxGasPerExecute: '0.5abc' };
            writeFileSync(path, JSON.stringify(cfg));
            expect(() => loadConfig(path)).toThrow(/decimal TON amount/);
        });

        it('out-of-range metricsPort rejected', () => {
            const cfg = { ...defaultConfig('testnet'), metricsPort: 70000 };
            writeFileSync(path, JSON.stringify(cfg));
            expect(() => loadConfig(path)).toThrow(ConfigValidationError);
        });

        it('invalid endpoint URL rejected', () => {
            const cfg = { ...defaultConfig('testnet'), endpoints: [{ url: 'not-a-url' }] };
            writeFileSync(path, JSON.stringify(cfg));
            expect(() => loadConfig(path)).toThrow(ConfigValidationError);
        });

        it('saveConfig rejects invalid config before writing', () => {
            const bad = { ...defaultConfig('testnet'), metricsPort: -1 } as never;
            expect(() => saveConfig(bad, path)).toThrow();
            expect(() => loadConfig(path)).toThrow(ConfigNotFoundError);
        });
    });

    describe('webhook SSRF guard', () => {
        // Hard refusal: cloud-metadata link-local IPs + non-http schemes.
        // Allowed: hostnames, RFC1918, loopback (operators legitimately use
        // those for internal alerting like Alertmanager-on-localhost).
        it('rejects AWS / GCP / Azure metadata-service IP (169.254.169.254)', () => {
            const cfg = {
                ...defaultConfig('testnet'),
                alertWebhookUrl: 'http://169.254.169.254/latest/meta-data/',
            };
            writeFileSync(path, JSON.stringify(cfg));
            expect(() => loadConfig(path)).toThrow(/SSRF|link-local/);
        });

        it('rejects any 169.254.* link-local address', () => {
            const cfg = {
                ...defaultConfig('testnet'),
                alertWebhookUrl: 'https://169.254.1.2/webhook',
            };
            writeFileSync(path, JSON.stringify(cfg));
            expect(() => loadConfig(path)).toThrow(/SSRF|link-local/);
        });

        it('rejects IPv6 link-local (fe80::*)', () => {
            const cfg = {
                ...defaultConfig('testnet'),
                alertWebhookUrl: 'http://[fe80::1]/webhook',
            };
            writeFileSync(path, JSON.stringify(cfg));
            expect(() => loadConfig(path)).toThrow(/SSRF|link-local/);
        });

        it('rejects IPv4-mapped IPv6 form of metadata IP (::ffff:169.254.169.254)', () => {
            const cfg = {
                ...defaultConfig('testnet'),
                alertWebhookUrl: 'http://[::ffff:169.254.169.254]/latest/meta-data/',
            };
            writeFileSync(path, JSON.stringify(cfg));
            expect(() => loadConfig(path)).toThrow(/SSRF|link-local/);
        });

        it('rejects hex-encoded IPv4-mapped IPv6 form (::ffff:a9fe:a9fe)', () => {
            const cfg = {
                ...defaultConfig('testnet'),
                alertWebhookUrl: 'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
            };
            writeFileSync(path, JSON.stringify(cfg));
            expect(() => loadConfig(path)).toThrow(/SSRF|link-local/);
        });

        it('rejects Alibaba Cloud metadata IP (100.100.100.200)', () => {
            const cfg = {
                ...defaultConfig('testnet'),
                alertWebhookUrl: 'http://100.100.100.200/latest/meta-data/',
            };
            writeFileSync(path, JSON.stringify(cfg));
            expect(() => loadConfig(path)).toThrow(/SSRF|link-local/);
        });

        it('rejects non-http(s) schemes', () => {
            const cfg = {
                ...defaultConfig('testnet'),
                alertWebhookUrl: 'file:///etc/passwd',
            };
            writeFileSync(path, JSON.stringify(cfg));
            expect(() => loadConfig(path)).toThrow();
        });

        it('accepts a normal https hostname webhook', () => {
            const cfg = {
                ...defaultConfig('testnet'),
                alertWebhookUrl: 'https://hooks.example.com/automaton/slash',
            };
            writeFileSync(path, JSON.stringify(cfg));
            expect(loadConfig(path).alertWebhookUrl).toBe(
                'https://hooks.example.com/automaton/slash',
            );
        });

        it('accepts loopback (operators may run an internal alerter on 127.0.0.1)', () => {
            const cfg = {
                ...defaultConfig('testnet'),
                alertWebhookUrl: 'http://127.0.0.1:9093/api/v2/alerts',
            };
            writeFileSync(path, JSON.stringify(cfg));
            expect(loadConfig(path).alertWebhookUrl).toBe(
                'http://127.0.0.1:9093/api/v2/alerts',
            );
        });

        it('accepts RFC1918 (operators may POST to private alerting infra)', () => {
            const cfg = {
                ...defaultConfig('testnet'),
                alertWebhookUrl: 'https://10.0.0.5/automaton/slash',
            };
            writeFileSync(path, JSON.stringify(cfg));
            expect(loadConfig(path).alertWebhookUrl).toBe(
                'https://10.0.0.5/automaton/slash',
            );
        });

        it('accepts undefined (webhook disabled)', () => {
            const cfg = defaultConfig('testnet');
            // Default has no alertWebhookUrl.
            saveConfig(cfg, path);
            expect(loadConfig(path).alertWebhookUrl).toBeUndefined();
        });
    });

    describe('env overlay', () => {
        it('AUTOMATON_NETWORK overrides network', () => {
            saveConfig(defaultConfig('testnet'), path);
            process.env.AUTOMATON_NETWORK = 'mainnet';
            expect(loadConfig(path).network).toBe('mainnet');
        });

        it('AUTOMATON_METRICS_PORT overrides metricsPort', () => {
            saveConfig(defaultConfig('testnet'), path);
            process.env.AUTOMATON_METRICS_PORT = '12345';
            expect(loadConfig(path).metricsPort).toBe(12345);
        });

        it('AUTOMATON_LOG_LEVEL overrides logLevel', () => {
            saveConfig(defaultConfig('testnet'), path);
            process.env.AUTOMATON_LOG_LEVEL = 'debug';
            expect(loadConfig(path).logLevel).toBe('debug');
        });

        it('missing env vars leave config unchanged', () => {
            const cfg = defaultConfig('testnet');
            expect(applyEnvOverlay(cfg)).toEqual(cfg);
        });

        it('invalid AUTOMATON_NETWORK throws ConfigEnvOverlayError', () => {
            saveConfig(defaultConfig('testnet'), path);
            process.env.AUTOMATON_NETWORK = 'moonnet';
            expect(() => loadConfig(path)).toThrow(ConfigEnvOverlayError);
            expect(() => loadConfig(path)).toThrow(/AUTOMATON_NETWORK/);
        });

        it('out-of-range AUTOMATON_METRICS_PORT throws', () => {
            saveConfig(defaultConfig('testnet'), path);
            process.env.AUTOMATON_METRICS_PORT = '99999';
            expect(() => loadConfig(path)).toThrow(/1-65535/);
        });

        it('non-numeric AUTOMATON_METRICS_PORT throws', () => {
            saveConfig(defaultConfig('testnet'), path);
            process.env.AUTOMATON_METRICS_PORT = 'abc';
            expect(() => loadConfig(path)).toThrow(/1-65535/);
        });

        it('invalid AUTOMATON_LOG_LEVEL throws', () => {
            saveConfig(defaultConfig('testnet'), path);
            process.env.AUTOMATON_LOG_LEVEL = 'verbose';
            expect(() => loadConfig(path)).toThrow(/AUTOMATON_LOG_LEVEL/);
        });

        it('AUTOMATON_ATLAS_ADDRESS populates fortuna.atlasAddress', () => {
            saveConfig(defaultConfig('testnet'), path);
            process.env.AUTOMATON_ATLAS_ADDRESS =
                '0:1111111111111111111111111111111111111111111111111111111111111111';
            const loaded = loadConfig(path);
            expect(loaded.fortuna?.atlasAddress).toBe(
                '0:1111111111111111111111111111111111111111111111111111111111111111',
            );
            expect(loaded.fortuna?.fortunaAddress).toBeUndefined();
        });

        it('AUTOMATON_FORTUNA_ADDRESS populates fortuna.fortunaAddress', () => {
            saveConfig(defaultConfig('testnet'), path);
            process.env.AUTOMATON_FORTUNA_ADDRESS =
                '0:2222222222222222222222222222222222222222222222222222222222222222';
            const loaded = loadConfig(path);
            expect(loaded.fortuna?.fortunaAddress).toBe(
                '0:2222222222222222222222222222222222222222222222222222222222222222',
            );
            expect(loaded.fortuna?.atlasAddress).toBeUndefined();
        });

        it('both atlas + fortuna env vars merge into fortuna block', () => {
            saveConfig(defaultConfig('testnet'), path);
            process.env.AUTOMATON_ATLAS_ADDRESS =
                '0:1111111111111111111111111111111111111111111111111111111111111111';
            process.env.AUTOMATON_FORTUNA_ADDRESS =
                '0:2222222222222222222222222222222222222222222222222222222222222222';
            const loaded = loadConfig(path);
            expect(loaded.fortuna?.atlasAddress).toMatch(/1111/);
            expect(loaded.fortuna?.fortunaAddress).toMatch(/2222/);
        });

        it('env vars merge with existing fortuna block from file (atlas from env, fortuna from file)', () => {
            const cfg = defaultConfig('testnet');
            cfg.fortuna = {
                fortunaAddress:
                    '0:3333333333333333333333333333333333333333333333333333333333333333',
            };
            saveConfig(cfg, path);
            process.env.AUTOMATON_ATLAS_ADDRESS =
                '0:1111111111111111111111111111111111111111111111111111111111111111';
            const loaded = loadConfig(path);
            expect(loaded.fortuna?.atlasAddress).toMatch(/1111/);
            expect(loaded.fortuna?.fortunaAddress).toMatch(/3333/);
        });
    });

    describe('fortuna block schema', () => {
        it('fortuna block is optional (default config has none)', () => {
            const cfg = defaultConfig('testnet');
            expect(cfg.fortuna).toBeUndefined();
            saveConfig(cfg, path);
            expect(loadConfig(path).fortuna).toBeUndefined();
        });

        it('fortuna block round-trips both addresses', () => {
            const cfg = defaultConfig('testnet');
            cfg.fortuna = {
                atlasAddress:
                    '0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                fortunaAddress:
                    '0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            };
            saveConfig(cfg, path);
            expect(loadConfig(path).fortuna).toEqual(cfg.fortuna);
        });

        it('fortuna block with only one address is valid (both fields optional)', () => {
            const cfg = defaultConfig('testnet');
            cfg.fortuna = {
                atlasAddress:
                    '0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            };
            saveConfig(cfg, path);
            const loaded = loadConfig(path);
            expect(loaded.fortuna?.atlasAddress).toMatch(/aaaa/);
            expect(loaded.fortuna?.fortunaAddress).toBeUndefined();
        });

        it('non-string address values rejected', () => {
            const cfg = defaultConfig('testnet') as unknown as Record<string, unknown>;
            cfg.fortuna = { atlasAddress: 12345 };
            writeFileSync(path, JSON.stringify(cfg));
            expect(() => loadConfig(path)).toThrow(ConfigValidationError);
        });
    });
});

describe('paths', () => {
    const savedEnv: Record<string, string | undefined> = {};
    const ENV = ['TITON_HOME', 'AUTOMATON_CONFIG', 'HOME'];

    beforeEach(() => {
        for (const key of ENV) savedEnv[key] = process.env[key];
    });

    afterEach(() => {
        for (const key of ENV) {
            const original = savedEnv[key];
            if (original === undefined) delete process.env[key];
            else process.env[key] = original;
        }
    });

    it('titonHome defaults to <homedir>/.titon when TITON_HOME unset', () => {
        delete process.env.TITON_HOME;
        // We can't reliably mutate os.homedir() at test time (libuv caches),
        // so just assert the default ends in /.titon and lives under the
        // real homedir. The TITON_HOME override test covers the actual knob.
        const { homedir } = require('os') as typeof import('os');
        expect(titonHome()).toBe(`${homedir()}/.titon`);
    });

    it('TITON_HOME env overrides default', () => {
        process.env.TITON_HOME = '/custom/root';
        expect(titonHome()).toBe('/custom/root');
        expect(automatonDir()).toBe('/custom/root/automaton');
        expect(configPath()).toBe('/custom/root/automaton/config.json');
        expect(walletPath()).toBe('/custom/root/automaton/wallet.enc');
        expect(blsPath()).toBe('/custom/root/automaton/bls.enc');
        expect(statePath()).toBe('/custom/root/automaton/state.json');
        expect(lockPath()).toBe('/custom/root/automaton/automaton.lock');
        expect(logsDir()).toBe('/custom/root/automaton/logs');
    });

    it('blsPath lives alongside wallet.enc under automatonDir()', () => {
        process.env.TITON_HOME = '/tmp/titon-test';
        expect(blsPath()).toBe('/tmp/titon-test/automaton/bls.enc');
        // Parallel to wallet.enc: same directory, different filename
        expect(blsPath().replace('bls.enc', 'wallet.enc')).toBe(walletPath());
    });

    it('AUTOMATON_CONFIG overrides only the config path', () => {
        process.env.TITON_HOME = '/custom/root';
        process.env.AUTOMATON_CONFIG = '/other/place/cfg.json';
        expect(configPath()).toBe('/other/place/cfg.json');
        // Other paths still under TITON_HOME:
        expect(walletPath()).toBe('/custom/root/automaton/wallet.enc');
    });

    it('paths re-read env on every call (so tests can mutate mid-run)', () => {
        process.env.TITON_HOME = '/first';
        expect(titonHome()).toBe('/first');
        process.env.TITON_HOME = '/second';
        expect(titonHome()).toBe('/second');
    });
});
