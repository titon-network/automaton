// PID-based single-instance lock. Prevents two `automaton run` processes
// from fighting over the same keystore, sending duplicate Execute calls,
// and scribbling on the same state.json.
//
// On-disk shape (JSON), automaton.lock:
//   { "version": 1, "pid": 12345, "startedAt": "2026-04-17T09:30:00.000Z" }
//
// Acquisition strategy:
//   1. Try `open(path, 'wx')` — atomic "create-only". Wins the race on
//      first-to-create; EEXIST if someone beat us.
//   2. On EEXIST, read + parse the existing lock. If the PID is alive
//      (`process.kill(pid, 0)` — signal 0 is a no-op "does this pid exist")
//      throw LockHeldError with pid / age info.
//   3. If the PID is dead (stale lock from a crashed run), unlink and retry.
//      One retry only — a second EEXIST means another automaton is racing
//      us through the same stale-cleanup path; bail loudly.
//
// PID reuse is the one corner case we can't solve in userland: if the OS
// recycled the recorded PID onto an unrelated process, `isPidAlive` will
// say "yes" and we'll refuse to start. That's safer than the inverse
// (starting a second automaton alongside a live one). The startedAt
// timestamp in the error surface lets operators eyeball "lock is 6 months
// old → almost certainly a zombie, rm it" in practice.
//
// One narrow, documented race: between `inspectLock` (find stale) and
// `unlinkSync`, another process could have noticed the same stale lock,
// unlinked it, and written its own fresh lock. Our `unlinkSync` would
// then drop that other process's live lock, and both processes would
// believe they own the lock. Window: two syscalls during startup
// (microseconds). We do not currently guard against it because a proper
// fix needs `renameat2(NOREPLACE)` (not exposed by Node's fs module) to
// atomically "replace-only-if-unchanged." Two automatons starting within
// microseconds of each other on the same host is not a realistic failure
// mode; the lock is best-effort coordination, not a security boundary.

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'fs';
import { dirname } from 'path';
import { lockPath } from '../config/paths';

export const LOCK_VERSION = 1;

export interface LockInfo {
    version: number;
    pid: number;
    startedAt: string;
}

export interface LockOptions {
    path?: string;
    /** Injected for tests. Defaults to the real `process.kill(pid, 0)` probe. */
    isPidAlive?: (pid: number) => boolean;
}

export class LockHeldError extends Error {
    constructor(public readonly path: string, public readonly info: LockInfo) {
        const ageMs = Date.now() - new Date(info.startedAt).getTime();
        const ageMin = Number.isFinite(ageMs) ? Math.round(ageMs / 60_000) : NaN;
        const ageStr = Number.isFinite(ageMin) ? `~${ageMin} min ago` : `at ${info.startedAt}`;
        super(
            `automaton is already running: pid ${info.pid} started ${ageStr} ` +
                `(lock: ${path}).\n` +
                `If you are certain no automaton is running (and the PID was reused or the ` +
                `previous run crashed), remove the lock manually: rm ${path}`,
        );
        this.name = 'LockHeldError';
    }
}

export class LockCorruptError extends Error {
    constructor(public readonly path: string, message: string) {
        super(
            `lock file at ${path} is corrupt: ${message}\n` +
                `Confirm no automaton is running, then remove it: rm ${path}`,
        );
        this.name = 'LockCorruptError';
    }
}

export function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // ESRCH → no such process. EPERM → exists but we can't signal it (still alive).
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

export function inspectLock(path: string = lockPath()): LockInfo | null {
    let raw: string;
    try {
        raw = readFileSync(path, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new LockCorruptError(path, `not valid JSON: ${msg}`);
    }
    if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as { pid?: unknown }).pid !== 'number' ||
        typeof (parsed as { startedAt?: unknown }).startedAt !== 'string' ||
        typeof (parsed as { version?: unknown }).version !== 'number'
    ) {
        throw new LockCorruptError(path, 'missing pid / startedAt / version fields');
    }
    const info = parsed as LockInfo;
    if (info.version !== LOCK_VERSION) {
        throw new LockCorruptError(
            path,
            `unexpected version ${info.version} (expected ${LOCK_VERSION})`,
        );
    }
    return info;
}

export function acquireLock(options: LockOptions = {}): LockInfo {
    const path = options.path ?? lockPath();
    const alive = options.isPidAlive ?? isPidAlive;
    mkdirSync(dirname(path), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return writeLock(path);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }

        const existing = inspectLock(path);
        if (existing === null) continue;
        if (alive(existing.pid)) throw new LockHeldError(path, existing);

        try {
            unlinkSync(path);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
    }

    throw new Error(
        `lockfile race on ${path}: another automaton acquired the lock while we were ` +
            `cleaning up a stale one. Retry.`,
    );
}

export function releaseLock(path: string = lockPath()): void {
    let info: LockInfo | null;
    try {
        info = inspectLock(path);
    } catch {
        // Corrupt — don't touch it. Leave for operator to resolve.
        return;
    }
    if (info === null) return;
    if (info.pid !== process.pid) return;
    try {
        unlinkSync(path);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
}

function writeLock(path: string): LockInfo {
    const info: LockInfo = {
        version: LOCK_VERSION,
        pid: process.pid,
        startedAt: new Date().toISOString(),
    };
    const fd = openSync(path, 'wx', 0o600);
    try {
        writeSync(fd, JSON.stringify(info, null, 2) + '\n');
    } finally {
        closeSync(fd);
    }
    return info;
}
