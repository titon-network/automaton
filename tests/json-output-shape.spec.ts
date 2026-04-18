// Snapshot tests for the stable JSON payload shapes emitted by agent-
// facing commands. These pin the shape — not the volatile values — so
// any accidental rename / removal / silent-field-add fails CI (the
// snapshot diff surfaces the change).
//
// Pattern: build the payload via its exported factory (buildDoctorPayload,
// buildStatusPayload, renderConfigShowJson, explainExitCode) and feed
// it through toMatchInlineSnapshot with expect.any(...) on the
// volatile fields (paths, timestamps, version strings, randomly-
// generated addresses).
//
// When a test fails, READ the diff before blindly re-snapshotting.
// Adding a field to a user-facing payload is a soft API change and
// should be reviewed; renaming or removing is a hard break.

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { toNano } from '@ton/core';

import { defaultConfig, saveConfig } from '../src/config';
import type { Keystore } from '../src/wallet';
import { KEYSTORE_VERSION } from '../src/wallet/keystore';
import {
    buildStatusPayload,
    type StatusJsonPayload,
} from '../src/cli/commands/status';
import {
    buildDoctorPayload,
    type DoctorJsonPayload,
    type NamedCheckResult,
} from '../src/cli/commands/doctor';
import {
    computeView,
    renderConfigShowJson,
} from '../src/cli/commands/config';
import { explainExitCode } from '../src/errors';

const ENV_KEYS = [
    'TITON_HOME',
    'AUTOMATON_CONFIG',
    'AUTOMATON_NETWORK',
    'AUTOMATON_METRICS_PORT',
    'AUTOMATON_LOG_LEVEL',
];

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

describe('JSON output shapes (drift guard)', () => {
    const savedEnv: Record<string, string | undefined> = {};
    let tmp: string;

    beforeEach(() => {
        for (const key of ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
        tmp = mkdtempSync(join(tmpdir(), 'titon-shape-'));
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

    it('doctor: DoctorJsonPayload shape (snapshot)', () => {
        const canned: NamedCheckResult[] = [
            { name: 'node >= 22', status: 'ok', detail: 'node 22.22.2' },
            { name: 'forgeton-sdk resolves', status: 'ok', detail: '26 exports' },
            { name: 'kronos-sdk resolves', status: 'ok', detail: '30 exports' },
            {
                name: 'wallet balance >= minFreeBalance',
                status: 'warn',
                detail: '1 TON < 2 TON (minFreeBalance)',
            },
            {
                name: 'lockfile',
                status: 'skip',
                detail: 'absent (daemon not running)',
            },
        ];
        const payload: DoctorJsonPayload = buildDoctorPayload(canned);

        expect(payload).toMatchInlineSnapshot(
            { version: expect.any(String) },
            `
{
  "checks": [
    {
      "detail": "node 22.22.2",
      "name": "node >= 22",
      "status": "ok",
    },
    {
      "detail": "26 exports",
      "name": "forgeton-sdk resolves",
      "status": "ok",
    },
    {
      "detail": "30 exports",
      "name": "kronos-sdk resolves",
      "status": "ok",
    },
    {
      "detail": "1 TON < 2 TON (minFreeBalance)",
      "name": "wallet balance >= minFreeBalance",
      "status": "warn",
    },
    {
      "detail": "absent (daemon not running)",
      "name": "lockfile",
      "status": "skip",
    },
  ],
  "summary": {
    "fail": 0,
    "ok": 3,
    "skip": 1,
    "total": 5,
    "warn": 1,
  },
  "version": Any<String>,
}
`,
        );
    });

    it('status: StatusJsonPayload shape for a registered active automaton (snapshot)', () => {
        const payload: StatusJsonPayload = buildStatusPayload({
            config: defaultConfig('testnet'),
            keystore: makeKeystore(),
            runtime: undefined,
            deploymentUnavailable: undefined,
            snapshot: {
                balance: toNano('3.5'),
                automaton: {
                    schemaVersion: 1,
                    stake: toNano('10'),
                    isActive: true,
                    slashCount: 2,
                    registeredAt: Math.floor(
                        new Date('2026-04-01T12:00:00.000Z').getTime() / 1000,
                    ),
                    unstakeRequestedAt: 0,
                },
                activeAutomatonCount: 7n,
                syncesReceived: 42n,
                slashesRequested: 5n,
                errors: [],
            },
        });

        expect(payload).toMatchInlineSnapshot(
            {
                version: expect.any(String),
                paths: {
                    config: expect.any(String),
                    keystore: expect.any(String),
                },
                daemon: {
                    lockfile: {
                        kind: expect.any(String),
                        detail: expect.any(String),
                    },
                    metricsPort: expect.any(Number),
                    metricsHost: expect.any(String),
                },
            },
            `
{
  "automaton": {
    "isActive": true,
    "registeredAt": "2026-04-01T12:00:00.000Z",
    "slashCount": 2,
    "stake": {
      "nano": "10000000000",
      "ton": "10",
    },
    "state": "active",
  },
  "daemon": {
    "lockfile": {
      "detail": Any<String>,
      "kind": Any<String>,
    },
    "metricsHost": Any<String>,
    "metricsPort": Any<Number>,
  },
  "deploymentUnavailable": null,
  "endpoints": {
    "configured": [
      {
        "url": "https://testnet.toncenter.com/api/v2/jsonRPC",
      },
    ],
    "current": null,
  },
  "errors": [],
  "network": "testnet",
  "paths": {
    "config": Any<String>,
    "keystore": Any<String>,
  },
  "pool": null,
  "registry": null,
  "version": Any<String>,
  "wallet": {
    "address": "0QBsK1tN7AiqL_Hovc1p6HdWC8tYFZ4wt-Jch1vg9arryx5N",
    "balance": {
      "nano": "3500000000",
      "ton": "3.5",
    },
    "publicKey": "deadbeef",
  },
}
`,
        );
    });

    it('status: StatusJsonPayload shape when unregistered (null state)', () => {
        const payload: StatusJsonPayload = buildStatusPayload({
            config: defaultConfig('testnet'),
            keystore: makeKeystore(),
            runtime: undefined,
            deploymentUnavailable: undefined,
            snapshot: {
                balance: toNano('5.2'),
                automaton: null,
                errors: [],
            },
        });
        expect(payload.automaton).toEqual({ state: 'not-registered' });
        expect(payload.wallet.balance).toEqual({ nano: '5200000000', ton: '5.2' });
    });

    it('config show: payload shape includes effective + envOverrides blocks', () => {
        saveConfig(defaultConfig('testnet'));
        process.env.AUTOMATON_LOG_LEVEL = 'debug';
        const raw = renderConfigShowJson(computeView());
        const obj = JSON.parse(raw) as {
            path: string;
            effective: { network: string; logLevel: string; endpoints: { url: string }[] };
            envOverrides: { envVar: string; applied: boolean }[];
        };
        expect(obj.effective.network).toBe('testnet');
        expect(obj.effective.logLevel).toBe('debug');
        expect(obj.envOverrides).toHaveLength(1);
        expect(obj.envOverrides[0]).toMatchObject({
            envVar: 'AUTOMATON_LOG_LEVEL',
            applied: true,
        });
        // path is volatile; assert shape only
        expect(typeof obj.path).toBe('string');
        // apiKey must never leak — defensive even in this test config
        for (const ep of obj.effective.endpoints) {
            expect(ep).not.toHaveProperty('apiKey');
        }
    });

    it('explainExitCode: Explanation shape is stable', () => {
        const exp = explainExitCode(160);
        expect(Object.keys(exp).sort()).toEqual(
            ['code', 'hint', 'message', 'name', 'origin'].sort(),
        );
        expect(exp.code).toBe(160);
        expect(['kronos', 'forgeton', 'tvm', 'unknown']).toContain(exp.origin);
        expect(typeof exp.name).toBe('string');
        expect(typeof exp.message).toBe('string');
    });
});

// Explicitly referenced so 'no unused var' rules stay quiet if the
// matcher helpers are imported for convenience but not directly asserted.
void writeFileSync;
