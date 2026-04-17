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
        expect(statePath()).toBe('/custom/root/automaton/state.json');
        expect(lockPath()).toBe('/custom/root/automaton/automaton.lock');
        expect(logsDir()).toBe('/custom/root/automaton/logs');
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
