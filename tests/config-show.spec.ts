// `automaton config show` — pure rendering of the effective config.
// Computation + env-overlay behaviour live in config.spec.ts; this suite
// pins the human + JSON output shape.

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { defaultConfig, saveConfig } from '../src/config';
import {
    computeView,
    renderConfigShowHuman,
    renderConfigShowJson,
    type ConfigView,
} from '../src/cli/commands/config';

const ENV_KEYS = [
    'TITON_HOME',
    'AUTOMATON_CONFIG',
    'AUTOMATON_NETWORK',
    'AUTOMATON_METRICS_PORT',
    'AUTOMATON_LOG_LEVEL',
];

describe('config show', () => {
    const savedEnv: Record<string, string | undefined> = {};
    let tmp: string;

    beforeEach(() => {
        for (const key of ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
        tmp = mkdtempSync(join(tmpdir(), 'titon-configshow-'));
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

    function seedConfig(): void {
        saveConfig(defaultConfig('testnet'));
    }

    it('computeView loads baseline + applies overlay with no env overrides', () => {
        seedConfig();
        const view = computeView();
        expect(view.effective.network).toBe('testnet');
        expect(view.baseline).toEqual(view.effective);
        expect(view.overrides).toHaveLength(0);
    });

    it('records an applied override when AUTOMATON_NETWORK differs from the file', () => {
        seedConfig();
        process.env.AUTOMATON_NETWORK = 'mainnet';
        const view = computeView();
        expect(view.baseline.network).toBe('testnet');
        expect(view.effective.network).toBe('mainnet');
        expect(view.overrides).toHaveLength(1);
        expect(view.overrides[0]).toMatchObject({
            envVar: 'AUTOMATON_NETWORK',
            baselineValue: 'testnet',
            effectiveValue: 'mainnet',
        });
    });

    it('flags a no-op override when the env matches the file', () => {
        seedConfig();
        process.env.AUTOMATON_NETWORK = 'testnet';
        const view = computeView();
        expect(view.overrides).toHaveLength(1);
        expect(view.overrides[0]?.baselineValue).toBe(view.overrides[0]?.effectiveValue);
    });

    it('renderConfigShowHuman surfaces core fields + endpoint list', () => {
        seedConfig();
        const view = computeView();
        const out = renderConfigShowHuman(view);
        expect(out).toContain('network:');
        expect(out).toContain('testnet');
        expect(out).toContain('metricsPort:');
        expect(out).toContain('9090');
        expect(out).toContain('Endpoints');
        expect(out).toContain('testnet.toncenter.com');
    });

    it('renderConfigShowHuman prints an applied env override block', () => {
        seedConfig();
        process.env.AUTOMATON_METRICS_PORT = '19090';
        const view = computeView();
        const out = renderConfigShowHuman(view);
        expect(out).toContain('Env overrides');
        expect(out).toContain('AUTOMATON_METRICS_PORT');
        expect(out).toContain('applied');
    });

    it('renderConfigShowJson emits stable JSON and redacts apiKeys', () => {
        // Write a config that includes an apiKey.
        const cfg = defaultConfig('testnet');
        cfg.endpoints = [
            { url: 'https://ep-a.example/api', apiKey: 'SUPERSECRET' },
            { url: 'https://ep-b.example/api' },
        ];
        saveConfig(cfg);

        const view = computeView();
        const out = renderConfigShowJson(view);
        expect(out).not.toContain('SUPERSECRET');
        const obj = JSON.parse(out);
        expect(obj.effective.network).toBe('testnet');
        expect(obj.effective.endpoints[0].url).toBe('https://ep-a.example/api');
        expect(obj.effective.endpoints[0].apiKey).toBeUndefined();
        expect(obj.envOverrides).toEqual([]);
    });

    it('renderConfigShowJson records env-override deltas with applied flag', () => {
        seedConfig();
        process.env.AUTOMATON_LOG_LEVEL = 'debug';
        const view = computeView();
        const obj = JSON.parse(renderConfigShowJson(view));
        expect(obj.envOverrides).toHaveLength(1);
        expect(obj.envOverrides[0]).toMatchObject({
            envVar: 'AUTOMATON_LOG_LEVEL',
            baselineValue: 'info',
            effectiveValue: 'debug',
            applied: true,
        });
    });

    it('throws if no config file exists at TITON_HOME', () => {
        expect(() => computeView()).toThrow(/no config/);
        expect(() => computeView()).toThrow(/automaton init/);
    });
});
