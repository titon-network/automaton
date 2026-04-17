// Unit tests for src/util/atomic-write.ts and src/config/paths.ts.
//
// atomic-write: the write-tmp + chmod + rename dance. We verify the final
// file ends up with the right contents, the right mode, and leaves no tmp
// sibling behind. We do NOT verify the atomicity guarantee itself — that's
// a property of rename(2), out of our test scope.
//
// paths: env-var-driven — TITON_HOME + AUTOMATON_CONFIG override the
// default locations so tests and Docker/systemd contexts can redirect
// writes away from $HOME. Verify both overrides and the unmodified defaults.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

import { atomicWriteFile } from '../src/util/atomic-write';
import {
    automatonDir,
    configPath,
    lockPath,
    logsDir,
    statePath,
    titonHome,
    walletPath,
} from '../src/config/paths';

describe('atomicWriteFile', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'atomic-write-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('writes the payload and leaves no tmp sibling', () => {
        const path = join(dir, 'target.json');
        atomicWriteFile(path, 'hello world');
        expect(readFileSync(path, 'utf8')).toBe('hello world');
        const siblings = readdirSync(dir);
        expect(siblings).toEqual(['target.json']);
    });

    it('applies the specified mode (default 0o600)', () => {
        const path = join(dir, 'secret');
        atomicWriteFile(path, 'x');
        const mode = statSync(path).mode & 0o777;
        expect(mode).toBe(0o600);
    });

    it('honours a custom mode argument', () => {
        const path = join(dir, 'world-readable');
        atomicWriteFile(path, 'x', 0o644);
        const mode = statSync(path).mode & 0o777;
        expect(mode).toBe(0o644);
    });

    it('creates parent directories recursively', () => {
        const path = join(dir, 'nested', 'deep', 'file.txt');
        atomicWriteFile(path, 'hi');
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path, 'utf8')).toBe('hi');
    });

    it('overwrites an existing file in place', () => {
        const path = join(dir, 'rewrite.txt');
        atomicWriteFile(path, 'first');
        atomicWriteFile(path, 'second');
        expect(readFileSync(path, 'utf8')).toBe('second');
        expect(readdirSync(dir)).toEqual(['rewrite.txt']);
    });
});

describe('config/paths', () => {
    const savedTitonHome = process.env.TITON_HOME;
    const savedAutomatonConfig = process.env.AUTOMATON_CONFIG;

    afterEach(() => {
        if (savedTitonHome === undefined) {
            delete process.env.TITON_HOME;
        } else {
            process.env.TITON_HOME = savedTitonHome;
        }
        if (savedAutomatonConfig === undefined) {
            delete process.env.AUTOMATON_CONFIG;
        } else {
            process.env.AUTOMATON_CONFIG = savedAutomatonConfig;
        }
    });

    it('defaults to ~/.titon when TITON_HOME unset', () => {
        delete process.env.TITON_HOME;
        expect(titonHome()).toBe(join(homedir(), '.titon'));
    });

    it('honours TITON_HOME override', () => {
        process.env.TITON_HOME = '/custom/root';
        expect(titonHome()).toBe('/custom/root');
        expect(automatonDir()).toBe('/custom/root/automaton');
    });

    it('derives all paths under automatonDir by default', () => {
        process.env.TITON_HOME = '/t';
        delete process.env.AUTOMATON_CONFIG;
        expect(configPath()).toBe('/t/automaton/config.json');
        expect(walletPath()).toBe('/t/automaton/wallet.enc');
        expect(statePath()).toBe('/t/automaton/state.json');
        expect(lockPath()).toBe('/t/automaton/automaton.lock');
        expect(logsDir()).toBe('/t/automaton/logs');
    });

    it('AUTOMATON_CONFIG overrides only the config path — other files stay under TITON_HOME', () => {
        process.env.TITON_HOME = '/t';
        process.env.AUTOMATON_CONFIG = '/etc/titon/custom.json';
        expect(configPath()).toBe('/etc/titon/custom.json');
        // Keystore / state / lock / logs stay under automatonDir.
        expect(walletPath()).toBe('/t/automaton/wallet.enc');
        expect(statePath()).toBe('/t/automaton/state.json');
        expect(lockPath()).toBe('/t/automaton/automaton.lock');
        expect(logsDir()).toBe('/t/automaton/logs');
    });

    it('re-reads env vars on each call (not cached)', () => {
        process.env.TITON_HOME = '/a';
        expect(titonHome()).toBe('/a');
        process.env.TITON_HOME = '/b';
        expect(titonHome()).toBe('/b');
    });
});
