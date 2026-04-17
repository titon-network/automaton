import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    LockCorruptError,
    LockHeldError,
    LOCK_VERSION,
    acquireLock,
    describeLock,
    inspectLock,
    isPidAlive,
    releaseLock,
} from '../src/chain/lockfile';

describe('lockfile', () => {
    let dir: string;
    let path: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'titon-automaton-lock-'));
        path = join(dir, 'automaton.lock');
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    describe('acquireLock', () => {
        it('creates the lock with our pid + startedAt + version', () => {
            const info = acquireLock({ path });

            expect(info.pid).toBe(process.pid);
            expect(info.version).toBe(LOCK_VERSION);
            expect(info.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
            expect(existsSync(path)).toBe(true);
        });

        it('persists the lock in JSON on disk', () => {
            acquireLock({ path });

            const onDisk = JSON.parse(readFileSync(path, 'utf8'));
            expect(onDisk).toEqual({
                version: LOCK_VERSION,
                pid: process.pid,
                startedAt: expect.any(String),
            });
        });

        it('creates parent directory if missing', () => {
            const nested = join(dir, 'nested', 'deeper', 'automaton.lock');
            acquireLock({ path: nested });
            expect(existsSync(nested)).toBe(true);
        });

        it('writes the lock with 0600 perms', () => {
            acquireLock({ path });
            const { statSync } = require('fs');
            const mode = statSync(path).mode & 0o777;
            expect(mode).toBe(0o600);
        });

        it('throws LockHeldError when a live pid already holds the lock', () => {
            writeFileSync(
                path,
                JSON.stringify({ version: LOCK_VERSION, pid: 99999, startedAt: new Date().toISOString() }),
            );

            expect(() => acquireLock({ path, isPidAlive: () => true })).toThrow(LockHeldError);
        });

        it('surfaces the held pid + started-at in the error', () => {
            const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
            writeFileSync(path, JSON.stringify({ version: LOCK_VERSION, pid: 12345, startedAt }));

            try {
                acquireLock({ path, isPidAlive: () => true });
                fail('expected throw');
            } catch (err) {
                expect(err).toBeInstanceOf(LockHeldError);
                const held = err as LockHeldError;
                expect(held.info.pid).toBe(12345);
                expect(held.info.startedAt).toBe(startedAt);
                expect(held.message).toContain('12345');
                expect(held.message).toContain(path);
            }
        });

        it('reclaims a stale lock (dead pid) and succeeds', () => {
            writeFileSync(
                path,
                JSON.stringify({ version: LOCK_VERSION, pid: 99999, startedAt: new Date().toISOString() }),
            );

            const info = acquireLock({ path, isPidAlive: () => false });

            expect(info.pid).toBe(process.pid);
            const onDisk = JSON.parse(readFileSync(path, 'utf8'));
            expect(onDisk.pid).toBe(process.pid);
        });

        it('throws LockCorruptError on malformed JSON', () => {
            writeFileSync(path, 'not json at all');

            expect(() => acquireLock({ path })).toThrow(LockCorruptError);
        });

        it('throws LockCorruptError on missing fields', () => {
            writeFileSync(path, JSON.stringify({ pid: 1 }));

            expect(() => acquireLock({ path })).toThrow(LockCorruptError);
        });

        it('throws LockCorruptError on unknown lock version', () => {
            writeFileSync(
                path,
                JSON.stringify({ version: 99, pid: 1, startedAt: new Date().toISOString() }),
            );

            expect(() => acquireLock({ path })).toThrow(/unexpected version 99/);
        });
    });

    describe('releaseLock', () => {
        it('removes the lock if we hold it', () => {
            acquireLock({ path });
            releaseLock(path);
            expect(existsSync(path)).toBe(false);
        });

        it('is a no-op when the lock file is absent', () => {
            expect(() => releaseLock(path)).not.toThrow();
        });

        it('does NOT remove a lock held by a different pid', () => {
            writeFileSync(
                path,
                JSON.stringify({
                    version: LOCK_VERSION,
                    pid: process.pid + 1,
                    startedAt: new Date().toISOString(),
                }),
            );

            releaseLock(path);
            expect(existsSync(path)).toBe(true);
        });

        it('does NOT remove a corrupt lock (leaves for operator)', () => {
            writeFileSync(path, 'garbage');
            releaseLock(path);
            expect(existsSync(path)).toBe(true);
        });
    });

    describe('inspectLock', () => {
        it('returns null when the file does not exist', () => {
            expect(inspectLock(path)).toBeNull();
        });

        it('returns the parsed LockInfo when it does', () => {
            acquireLock({ path });
            const info = inspectLock(path);
            expect(info).not.toBeNull();
            expect(info!.pid).toBe(process.pid);
            expect(info!.version).toBe(LOCK_VERSION);
        });

        it('throws LockCorruptError on corrupt content', () => {
            writeFileSync(path, '{ pid: 1 }');
            expect(() => inspectLock(path)).toThrow(LockCorruptError);
        });
    });

    describe('describeLock', () => {
        it('returns absent when the lock file does not exist', () => {
            const desc = describeLock(path);
            expect(desc.kind).toBe('absent');
            expect(desc.detail).toMatch(/absent/);
        });

        it('returns held-by-us when our own pid owns the lock', () => {
            acquireLock({ path });
            const desc = describeLock(path);
            expect(desc.kind).toBe('held-by-us');
            expect(desc.detail).toMatch(/this process/);
        });

        it('returns held-alive for a live foreign pid', () => {
            writeFileSync(
                path,
                JSON.stringify({ version: LOCK_VERSION, pid: 12345, startedAt: '2026-04-17T00:00:00.000Z' }),
            );
            const desc = describeLock(path, () => true);
            expect(desc.kind).toBe('held-alive');
            expect(desc.detail).toContain('12345');
        });

        it('returns held-stale when the recorded pid is dead', () => {
            writeFileSync(
                path,
                JSON.stringify({ version: LOCK_VERSION, pid: 12345, startedAt: '2026-04-17T00:00:00.000Z' }),
            );
            const desc = describeLock(path, () => false);
            expect(desc.kind).toBe('held-stale');
            expect(desc.detail).toMatch(/STALE/);
            expect(desc.detail).toContain('rm ' + path);
        });

        it('returns corrupt on malformed content', () => {
            writeFileSync(path, 'not json');
            const desc = describeLock(path);
            expect(desc.kind).toBe('corrupt');
            expect(desc.detail).toMatch(/corrupt/);
        });
    });

    describe('isPidAlive', () => {
        it('returns true for our own pid', () => {
            expect(isPidAlive(process.pid)).toBe(true);
        });

        it('returns true for init (pid 1) on Linux', () => {
            expect(isPidAlive(1)).toBe(true);
        });

        it('returns false for a pid above the Linux default max', () => {
            // /proc/sys/kernel/pid_max defaults to 4194304 on modern Linux; a
            // pid beyond that is guaranteed never to have been assigned.
            expect(isPidAlive(9_999_999)).toBe(false);
        });
    });
});
