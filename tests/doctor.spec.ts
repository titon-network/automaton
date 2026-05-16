// `automaton doctor` orchestration coverage. Drives runChecks under
// different on-disk states (no install / corrupt config / corrupt
// keystore / network mismatch / mainnet-no-deployment) and asserts the
// status taxonomy + payload shape. Pure helpers (summarise +
// buildDoctorPayload) get unit-level tests for their bookkeeping.
//
// Chain-check happy paths are deliberately not exercised here — they
// require a live testnet RPC. cli.spec.ts already smokes the binary
// end-to-end including the JSON-format chain output; here we focus on
// the runChecks composition + every doctor-side branch we can drive
// without standing up the network.
//
// Known limitation: the two `<sdk>-sdk resolves` install checks call
// `await import('@titon-network/forgeton-sdk' | '@titon-network/kronos-sdk')`. Under jest's CommonJS
// runtime that throws ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG (the
// import is fine when the binary runs — see cli.spec.ts which smokes
// the JSON output). We treat those two rows as best-effort here and
// only pin shape, not status.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import {
    runChecks,
    summarise,
    buildDoctorPayload,
    type NamedCheckResult,
} from '../src/cli/commands/doctor';
import { defaultConfig, saveConfig, configPath } from '../src/config';
import { generateMnemonic, lockKeystore, saveKeystore } from '../src/wallet';
import { pkgVersion } from '../src/cli/version';

// Match the FAST_KDF discipline from wallet.spec.ts: production scrypt
// N=131072 takes ~400ms per unlock. We're not exercising the crypto
// here, just the keystore presence / network-agreement logic, so the
// fastest valid params are fine.
const FAST_KDF = { kdfN: 2048 };

const ENV_KEYS = [
    'TITON_HOME',
    'AUTOMATON_CONFIG',
    'AUTOMATON_NETWORK',
    'AUTOMATON_PASSWORD',
];

async function seedKeystore(
    network: 'testnet' | 'mainnet',
    password = 'doctor-spec-pw',
): Promise<void> {
    const mnemonic = await generateMnemonic();
    const ks = await lockKeystore(mnemonic, password, network, FAST_KDF);
    saveKeystore(ks);
}

function findCheck(results: NamedCheckResult[], name: string): NamedCheckResult {
    const r = results.find((x) => x.name === name);
    if (r === undefined) {
        throw new Error(`expected check "${name}" — got ${results.map((x) => x.name).join(', ')}`);
    }
    return r;
}

describe('summarise', () => {
    it('counts each status into the matching bucket', () => {
        const results: NamedCheckResult[] = [
            { name: 'a', status: 'ok', detail: '' },
            { name: 'b', status: 'ok', detail: '' },
            { name: 'c', status: 'warn', detail: '' },
            { name: 'd', status: 'fail', detail: '' },
            { name: 'e', status: 'skip', detail: '' },
        ];
        const s = summarise(results);
        expect(s).toEqual({ total: 5, ok: 2, warn: 1, fail: 1, skip: 1 });
    });

    it('returns zero-everywhere on an empty list', () => {
        expect(summarise([])).toEqual({ total: 0, ok: 0, warn: 0, fail: 0, skip: 0 });
    });
});

describe('buildDoctorPayload', () => {
    it('wraps the result list with summary + version', () => {
        const results: NamedCheckResult[] = [
            { name: 'x', status: 'ok', detail: 'ok detail' },
            { name: 'y', status: 'fail', detail: 'oh no' },
        ];
        const payload = buildDoctorPayload(results);
        expect(payload.version).toBe(pkgVersion());
        expect(payload.summary.total).toBe(2);
        expect(payload.summary.fail).toBe(1);
        expect(payload.checks).toBe(results);
    });
});

describe('runChecks', () => {
    const savedEnv: Record<string, string | undefined> = {};
    let tmp: string;

    beforeEach(() => {
        for (const key of ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
        tmp = mkdtempSync(join(tmpdir(), 'titon-doctor-'));
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

    it('runs install + skip-config-and-keystore + lockfile on a fresh TITON_HOME', async () => {
        const results = await runChecks();
        const names = results.map((r) => r.name);

        // Install layer always fires; ordered as defined in buildInstallChecks.
        expect(names.slice(0, 8)).toEqual([
            'node >= 22',
            '@titon-network/forgeton-sdk resolves',
            '@titon-network/kronos-sdk resolves',
            '@titon-network/atlas-sdk resolves',
            '@titon-network/fortuna-sdk resolves',
            '@titon-network/themis-sdk resolves',
            '@titon-network/phoebe-sdk resolves',
            'package version readable',
        ]);
        // node + pkg version checks don't depend on dynamic import; they pass
        // honestly under jest. The SDK rows hit the jest dynamic-import
        // limitation noted at the top of the file — we just verify they ran
        // and produced a result, not the status.
        expect(findCheck(results, 'node >= 22').status).toBe('ok');
        expect(findCheck(results, 'package version readable').status).toBe('ok');
        for (const n of [
            '@titon-network/forgeton-sdk resolves',
            '@titon-network/kronos-sdk resolves',
            '@titon-network/atlas-sdk resolves',
            '@titon-network/fortuna-sdk resolves',
            '@titon-network/themis-sdk resolves',
            '@titon-network/phoebe-sdk resolves',
        ]) {
            const c = findCheck(results, n);
            expect(['ok', 'fail']).toContain(c.status);
            expect(c.detail.length).toBeGreaterThan(0);
        }

        // No config + no keystore → both render as skip with an init pointer.
        const cfg = findCheck(results, 'config');
        expect(cfg.status).toBe('skip');
        expect(cfg.detail).toMatch(/automaton init/);
        const ks = findCheck(results, 'keystore');
        expect(ks.status).toBe('skip');
        expect(ks.detail).toMatch(/automaton init/);

        // Lockfile always fires; absent on a fresh home.
        expect(findCheck(results, 'lockfile').status).toBe('ok');

        // Network-agreement check is omitted when either side is absent.
        expect(names).not.toContain('config / keystore network agree');
    });

    it('surfaces a corrupt config.json as a fail check', async () => {
        // saveConfig() would mkdir the parent for us; here we want broken
        // bytes on disk, so do the mkdir + write manually.
        const path = configPath();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, '{ not valid json', 'utf8');

        const results = await runChecks();
        const cfg = findCheck(results, 'config');
        expect(cfg.status).toBe('fail');
        // Loader error message is preserved verbatim — operators get an
        // actionable parse-error string, not a generic "config bad".
        expect(cfg.detail.length).toBeGreaterThan(0);
    });

    it('reports an ok config row pointing at the file when the config loads', async () => {
        saveConfig(defaultConfig('testnet'));
        // No keystore yet — the chain layer skips because keystore is absent
        // (buildChainChecks gated on both sides). We only need to confirm
        // the config row's ok path renders correctly.
        const results = await runChecks();
        const cfg = findCheck(results, 'config');
        expect(cfg.status).toBe('ok');
        expect(cfg.detail).toMatch(/network=testnet/);
        expect(cfg.detail).toMatch(/endpoints=/);
    });

    it('reports an ok keystore row + fires the network-agreement check when both sides load', async () => {
        saveConfig(defaultConfig('testnet'));
        await seedKeystore('testnet');
        const results = await runChecks();
        const ks = findCheck(results, 'keystore');
        expect(ks.status).toBe('ok');
        expect(ks.detail).toMatch(/network=testnet/);
        expect(ks.detail).toMatch(/address=/);

        // Network-agreement check fires when both sides loaded.
        const agree = findCheck(results, 'config / keystore network agree');
        expect(agree.status).toBe('ok');
        expect(agree.detail).toBe('testnet');
    });

    it('emits a fail row when config and keystore disagree on network', async () => {
        saveConfig(defaultConfig('testnet'));
        await seedKeystore('mainnet');
        const results = await runChecks();
        const agree = findCheck(results, 'config / keystore network agree');
        expect(agree.status).toBe('fail');
        expect(agree.detail).toMatch(/config\.network=testnet/);
        expect(agree.detail).toMatch(/keystore\.network=mainnet/);
        // The detail names the remediation (recreate the keystore).
        expect(agree.detail).toMatch(/keystore must be re-created/);
    });

    it('warns when every endpoint is public toncenter without an apiKey', async () => {
        // defaultConfig('testnet') has exactly one endpoint, the public
        // testnet toncenter URL with no apiKey. This is the worst-case
        // production setup — operator inherits the ~1 req/s limit.
        saveConfig(defaultConfig('testnet'));
        const results = await runChecks();
        const ep = findCheck(results, 'endpoint quality');
        expect(ep.status).toBe('warn');
        expect(ep.detail).toMatch(/rate limit|apiKey/);
    });

    it('endpoint quality reports ok when every endpoint has an apiKey or is private', async () => {
        const cfg = defaultConfig('testnet');
        cfg.endpoints = [
            { url: 'https://testnet.toncenter.com/api/v2/jsonRPC', apiKey: 'KEY' },
            { url: 'https://my-private-rpc.example.com/jsonRPC' },
        ];
        saveConfig(cfg);
        const results = await runChecks();
        const ep = findCheck(results, 'endpoint quality');
        expect(ep.status).toBe('ok');
        expect(ep.detail).toMatch(/all keyed or private/);
    });

    it('endpoint quality warns on partial public-unkeyed when other endpoints are clean', async () => {
        const cfg = defaultConfig('testnet');
        cfg.endpoints = [
            { url: 'https://my-private-rpc.example.com/jsonRPC' },
            { url: 'https://testnet.toncenter.com/api/v2/jsonRPC' },
        ];
        saveConfig(cfg);
        const results = await runChecks();
        const ep = findCheck(results, 'endpoint quality');
        expect(ep.status).toBe('warn');
        // Detail should call out the failover risk, not the all-bad message.
        expect(ep.detail).toMatch(/of \d+ endpoint/);
    });

    it('runs the chain checks against mainnet now that the deployment is live', async () => {
        saveConfig(defaultConfig('mainnet'));
        await seedKeystore('mainnet');
        const results = await runChecks();
        const chainCheckNames = [
            'rpc reachable',
            'wallet balance >= minFreeBalance',
            'on-chain schema versions match',
            'registry admitted on pool',
        ] as const;
        // Each chain check is contributed (status varies depending on
        // whether the test environment can reach toncenter mainnet).
        for (const name of chainCheckNames) {
            const c = findCheck(results, name);
            expect(c.status).toMatch(/^(ok|warn|fail|skip)$/);
        }
    });

    it('aggregates statuses cleanly via summarise on a real run', async () => {
        const results = await runChecks();
        const s = summarise(results);
        expect(s.total).toBe(results.length);
        expect(s.ok + s.warn + s.fail + s.skip).toBe(s.total);
        // Fresh home: node check + pkg version + 2 skip (config/keystore) +
        // 1 ok lockfile = 3 ok minimum (the two SDK-resolves rows hit the
        // jest dynamic-import limitation noted at the top of the file).
        expect(s.ok).toBeGreaterThanOrEqual(3);
        expect(s.skip).toBeGreaterThanOrEqual(2);
    });
});
