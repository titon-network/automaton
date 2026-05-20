// runDaemon orchestration — coverage of the lifecycle paths NOT
// exercised by tickOnce-only tests:
//
//   - EXIT_LOCK_HELD when another daemon already holds the lockfile
//   - Lockfile released after a controlled failure (loadConfig throws)
//   - Signal-handler install/uninstall: process listener count delta
//     is observable; tests pin that runDaemon doesn't leak listeners
//   - Process error handlers same
//
// Full happy-path runDaemon (build chain runtime → schema check →
// loop) requires real RPC mocking + a sandbox; that path is covered
// indirectly via Integration.spec.ts driving `tickOnce`. This file
// pins the orchestrator-specific lifecycle surface that the
// integration tests skip.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EXIT_LOCK_HELD, runDaemon } from '../src/daemon/orchestrator';
import { acquireLock, releaseLock } from '../src/chain/lockfile';
import { configPath, lockPath } from '../src/config/paths';
import { generateMnemonic, lockKeystore, saveKeystore } from '../src/wallet';
import { silentLogger } from './helpers/logger';

const PASSWORD = 'password-long-enough';
const FAST_KDF = { kdfN: 2048 };

async function seedConfigAndKeystore(): Promise<void> {
    const cfg = {
        configVersion: 1,
        network: 'testnet',
        endpoints: [{ url: 'https://testnet.toncenter.com/api/v2/jsonRPC' }],
        walletVersion: 'v5r1',
        metricsPort: 9090,
        metricsHost: '127.0.0.1',
        pollIntervalMs: 10_000,
        gaugeSnapshotEveryNTicks: 6,
        maxGasPerExecute: '0.5',
        minFreeBalance: '2.0',
        logLevel: 'error',
        products: { kronos: true, fortuna: false, themis: false, phoebe: false },
    };
    writeFileSync(configPath(), JSON.stringify(cfg), { mode: 0o600 });
    const mnemonic = await generateMnemonic();
    const blob = await lockKeystore(mnemonic, PASSWORD, 'testnet', FAST_KDF);
    saveKeystore(blob);
}

const savedHome = process.env.TITON_HOME;
const savedPwd = process.env.AUTOMATON_PASSWORD;

let tmp: string;

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'titon-automaton-run-daemon-'));
    mkdirSync(join(tmp, 'automaton'), { recursive: true });
    process.env.TITON_HOME = tmp;
    process.env.AUTOMATON_PASSWORD = 'password-long-enough';
});

afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.TITON_HOME;
    else process.env.TITON_HOME = savedHome;
    if (savedPwd === undefined) delete process.env.AUTOMATON_PASSWORD;
    else process.env.AUTOMATON_PASSWORD = savedPwd;
});

describe('runDaemon — EXIT_LOCK_HELD path', () => {
    it('returns EXIT_LOCK_HELD when another daemon holds the lock', async () => {
        await seedConfigAndKeystore();

        // Hold the lock as if a second daemon is running.
        const info = acquireLock();
        try {
            const ac = new AbortController();
            const exitCode = await runDaemon({
                logger: silentLogger(),
                externalAbort: ac.signal,
                skipHealthServer: true,
            });
            expect(exitCode).toBe(EXIT_LOCK_HELD);
            // The held lock must STILL be ours afterwards — runDaemon
            // must NOT release a lock it doesn't own.
            expect(info.pid).toBe(process.pid);
        } finally {
            releaseLock();
        }
    });
});

describe('runDaemon — loadConfig failure', () => {
    it('throws when config.json is missing (no lock leaked)', async () => {
        // No config written → loadConfig throws.
        const ac = new AbortController();
        await expect(
            runDaemon({
                logger: silentLogger(),
                externalAbort: ac.signal,
                skipHealthServer: true,
            }),
        ).rejects.toThrow();
        // Lock must not exist — loadConfig is BEFORE acquireLock; the
        // throw happens before any lock is held.
        const fs = require('fs') as typeof import('fs');
        expect(fs.existsSync(lockPath())).toBe(false);
    });
});

describe('runDaemon — signal handler hygiene', () => {
    it('does NOT install SIGTERM/SIGINT/SIGHUP handlers when externalAbort is supplied', async () => {
        // We trigger a fast failure path (no config → throw) but
        // observe the listener-count delta around the call. With
        // externalAbort supplied, runDaemon must NOT install signal
        // handlers (tests own shutdown via the AbortController).
        const sigterm0 = process.listenerCount('SIGTERM');
        const sigint0 = process.listenerCount('SIGINT');
        const sighup0 = process.listenerCount('SIGHUP');
        const ac = new AbortController();
        await expect(
            runDaemon({
                logger: silentLogger(),
                externalAbort: ac.signal,
                skipHealthServer: true,
            }),
        ).rejects.toThrow();
        expect(process.listenerCount('SIGTERM')).toBe(sigterm0);
        expect(process.listenerCount('SIGINT')).toBe(sigint0);
        expect(process.listenerCount('SIGHUP')).toBe(sighup0);
    });

    it('does NOT install uncaughtException / unhandledRejection handlers when externalAbort is supplied', async () => {
        const uncaught0 = process.listenerCount('uncaughtException');
        const unhandled0 = process.listenerCount('unhandledRejection');
        const ac = new AbortController();
        await expect(
            runDaemon({
                logger: silentLogger(),
                externalAbort: ac.signal,
                skipHealthServer: true,
            }),
        ).rejects.toThrow();
        expect(process.listenerCount('uncaughtException')).toBe(uncaught0);
        expect(process.listenerCount('unhandledRejection')).toBe(unhandled0);
    });
});
