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
    resolveEditor,
    validateConfigAt,
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

describe('validateConfigAt', () => {
    let tmp: string;

    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), 'titon-validateconf-'));
    });

    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    it('reports missing file with a single issue', () => {
        const res = validateConfigAt(join(tmp, 'nope.json'));
        expect(res.ok).toBe(false);
        expect(res.issues).toHaveLength(1);
        expect(res.issues[0]).toMatch(/file does not exist/);
        expect(res.configVersion).toBeUndefined();
    });

    it('reports invalid JSON with a parse-error issue', () => {
        const path = join(tmp, 'bad.json');
        writeFileSync(path, '{ not valid', 'utf8');
        const res = validateConfigAt(path);
        expect(res.ok).toBe(false);
        expect(res.issues[0]).toMatch(/not valid JSON/);
    });

    it('reports schema-failure issues with field paths', () => {
        const path = join(tmp, 'wrong.json');
        // Drop required `network` and `endpoints` fields.
        writeFileSync(path, JSON.stringify({ configVersion: 1 }), 'utf8');
        const res = validateConfigAt(path);
        expect(res.ok).toBe(false);
        // Each issue lists its field path so the operator knows where to fix.
        expect(res.issues.length).toBeGreaterThan(0);
        for (const issue of res.issues) {
            expect(issue).toMatch(/^\w+(\.\w+)?:/);
        }
    });

    it('returns ok with config metadata on a valid file', () => {
        const path = join(tmp, 'good.json');
        writeFileSync(path, JSON.stringify(defaultConfig('testnet')), 'utf8');
        const res = validateConfigAt(path);
        expect(res.ok).toBe(true);
        expect(res.issues).toEqual([]);
        expect(res.configVersion).toBe(1);
        expect(res.network).toBe('testnet');
        expect(res.endpointCount).toBeGreaterThan(0);
    });
});

describe('resolveEditor', () => {
    const savedVisual = process.env.VISUAL;
    const savedEditor = process.env.EDITOR;

    beforeEach(() => {
        delete process.env.VISUAL;
        delete process.env.EDITOR;
    });

    afterEach(() => {
        if (savedVisual === undefined) delete process.env.VISUAL;
        else process.env.VISUAL = savedVisual;
        if (savedEditor === undefined) delete process.env.EDITOR;
        else process.env.EDITOR = savedEditor;
    });

    it('--editor flag wins over $VISUAL and $EDITOR', () => {
        process.env.VISUAL = 'visual-cmd';
        process.env.EDITOR = 'editor-cmd';
        expect(resolveEditor('flag-cmd')).toEqual({ cmd: 'flag-cmd', args: [] });
    });

    it('falls back to $VISUAL before $EDITOR', () => {
        process.env.VISUAL = 'visual-cmd';
        process.env.EDITOR = 'editor-cmd';
        expect(resolveEditor(undefined)).toEqual({ cmd: 'visual-cmd', args: [] });
    });

    it('falls back to $EDITOR when $VISUAL is unset', () => {
        process.env.EDITOR = 'editor-cmd';
        expect(resolveEditor(undefined)).toEqual({ cmd: 'editor-cmd', args: [] });
    });

    it('splits multi-token editor strings into cmd + args', () => {
        // Common operator pattern: `code --wait`, `nvim -p`, etc.
        expect(resolveEditor('code --wait')).toEqual({
            cmd: 'code',
            args: ['--wait'],
        });
        expect(resolveEditor('nvim -p --headless')).toEqual({
            cmd: 'nvim',
            args: ['-p', '--headless'],
        });
    });

    it('falls back to platform default when nothing is set', () => {
        const expected = process.platform === 'win32' ? 'notepad' : 'vi';
        expect(resolveEditor(undefined).cmd).toBe(expected);
    });
});
