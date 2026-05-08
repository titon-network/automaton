// fortuna ProductModule — coverage for the methods that wire the product
// into runtime: openContracts, schemaChecks, eventStreams, bootstrapWorker,
// and the buildHandlers-internal handlers (config-cache invalidator,
// fortunaAwarenessHandler, fortunaHealthHandler).
//
// Companion to products-fortuna.spec.ts (which only exercises
// isEnabled / resolveAddresses / explainError / doctorInstallChecks).
//
// Handler-dispatch tests dispatch each event through ALL handlers
// returned by `fortuna.buildHandlers(ctx)`, then assert on the observable
// side-effect (log line OR worker-spy invocation). This mirrors production
// (drainEvents fans every event to every handler) and avoids coupling
// tests to the order of returned handlers.

import { type Cell, type OpenedContract } from '@ton/core';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Atlas, Fortuna, FortunaEvent } from '@titon-network/fortuna-sdk';
import { lockBlsKeystore, randomBlsSecret, saveBlsKeystore } from '../src/bls';
import { defaultConfig } from '../src/config/schema';
import { fortuna, FORTUNA_SOURCE } from '../src/products/fortuna';
import { FortunaWorker } from '../src/worker/fortuna';
import type { EventHandler, TxContext } from '../src/worker/events';
import type { ProductContext, ProductHandle, ProductWorker } from '../src/products/types';
import type { WorkerLogger } from '../src/worker/loop';
import type { FailoverTonClient } from '../src/chain/ton-client';
import { captureLogger, silentLogger } from './helpers/logger';
import { fakeAddress, fakeTxContext, fakeWallet } from './helpers/fixtures';

const PASSWORD = 'correct-horse-battery-staple';
// Production scrypt N=2^17 spends ~300-500 ms unlocking — too slow for
// dozens of test cases. Crypto primitives are identical, so the tamper
// vectors covered in bls/keystore.spec.ts remain meaningful at full N.
const FAST_KDF = { kdfN: 2048 };

const ME = fakeAddress(0xaa);
const OTHER = fakeAddress(0xbb);
const ATLAS_ADDR = fakeAddress(0xa1);
const FORTUNA_ADDR = fakeAddress(0xfa);

/** Fortuna stub with the methods both schemaChecks + FortunaWorker call. */
function stubFortunaContract(opts: { storageVersion?: number } = {}): unknown {
    return {
        address: FORTUNA_ADDR,
        getSchemaVersions: jest
            .fn()
            .mockResolvedValue({ storage: opts.storageVersion ?? 1 }),
        getConfig: jest.fn(),
        getRequest: jest.fn(),
        sendFulfillRandomness: jest.fn().mockResolvedValue(undefined),
    };
}

function stubAtlasContract(opts: { storageVersion?: number } = {}): unknown {
    return {
        address: ATLAS_ADDR,
        getSchemaVersions: jest
            .fn()
            .mockResolvedValue({ storage: opts.storageVersion ?? 1 }),
    };
}

/**
 * FailoverTonClient stub. ProductModule.openContracts calls
 * `client.open(Atlas.createFromAddress(addr))` / `client.open(Fortuna.createFromAddress(addr))`
 * — we route by address identity to the supplied opens map.
 */
function stubClient(opens: { atlas?: unknown; fortuna?: unknown }): FailoverTonClient {
    return {
        open: (contract: { address?: import('@ton/core').Address }) => {
            if (contract.address?.equals(ATLAS_ADDR)) return opens.atlas;
            if (contract.address?.equals(FORTUNA_ADDR)) return opens.fortuna;
            // Wallet-side `client.open(walletContract).sender()` paths.
            return { sender: () => ({ send: () => Promise.resolve() }) };
        },
    } as unknown as FailoverTonClient;
}

/**
 * Build a ProductContext for the fortuna ProductModule. Tests for
 * worker-bearing methods (bootstrapWorker / buildHandlers) all pass
 * through here so the shape stays consistent.
 */
function makeProductContext(opts: {
    me?: import('@ton/core').Address;
    contracts?: ProductContext['contracts'];
    logger?: WorkerLogger;
    worker?: ProductWorker;
} = {}): ProductContext {
    const fortunaContract = stubFortunaContract();
    const ctx: ProductContext = {
        client: stubClient({ fortuna: fortunaContract }),
        addresses: { atlas: ATLAS_ADDR, fortuna: FORTUNA_ADDR },
        contracts: opts.contracts ?? {
            fortuna: fortunaContract as OpenedContract<Fortuna>,
        },
        config: defaultConfig('testnet'),
        wallet: fakeWallet(opts.me ?? ME),
        walletPassword: PASSWORD,
        logger: opts.logger ?? silentLogger(),
    };
    if (opts.worker !== undefined) ctx.worker = opts.worker;
    return ctx;
}

/** Fan an event through every handler's `on[FORTUNA_SOURCE]` callback —
 *  the same composition `drainEvents` applies in production. */
async function dispatchToAll(
    handlers: readonly EventHandler[],
    event: FortunaEvent,
    ctx: TxContext = fakeTxContext(),
): Promise<void> {
    for (const h of handlers) {
        const cb = h.on?.[FORTUNA_SOURCE];
        if (cb !== undefined) await cb(event, ctx);
    }
}

/** Construct a FortunaWorker instance with a stubbed contract. Used by
 *  buildHandlers tests to materialise the config-invalidator handler. */
function makeStubWorker(): { worker: FortunaWorker; fortunaContract: unknown } {
    const fortunaContract = stubFortunaContract();
    const worker = new FortunaWorker({
        fortuna: fortunaContract as OpenedContract<Fortuna>,
        client: stubClient({ fortuna: fortunaContract }),
        wallet: fakeWallet(ME),
        blsSecret: Buffer.from(randomBlsSecret()),
        logger: silentLogger(),
    });
    return { worker, fortunaContract };
}

describe('fortuna ProductModule.openContracts', () => {
    it('returns atlas + fortuna handles when addresses are present', () => {
        const atlasOpened = stubAtlasContract();
        const fortunaOpened = stubFortunaContract();

        const handle: ProductHandle = {
            client: stubClient({ atlas: atlasOpened, fortuna: fortunaOpened }),
            addresses: { atlas: ATLAS_ADDR, fortuna: FORTUNA_ADDR },
            contracts: {},
        };
        const contracts = fortuna.openContracts(handle);

        expect(Object.keys(contracts).sort()).toEqual(['atlas', 'fortuna']);
        expect(contracts.atlas).toBe(atlasOpened);
        expect(contracts.fortuna).toBe(fortunaOpened);
    });

    it('returns {} when addresses bag is empty (product disabled)', () => {
        const handle: ProductHandle = {
            client: stubClient({}),
            addresses: {},
            contracts: {},
        };
        expect(fortuna.openContracts(handle)).toEqual({});
    });
});

describe('fortuna ProductModule.schemaChecks', () => {
    it('returns 2 tasks (atlas + fortuna) with read fns hitting getSchemaVersions().storage', async () => {
        const atlasContract = stubAtlasContract({ storageVersion: 1 });
        const fortunaContract = stubFortunaContract({ storageVersion: 1 });

        const handle: ProductHandle = {
            client: stubClient({}),
            addresses: { atlas: ATLAS_ADDR, fortuna: FORTUNA_ADDR },
            contracts: {
                atlas: atlasContract as OpenedContract<Atlas>,
                fortuna: fortunaContract as OpenedContract<Fortuna>,
            },
        };

        const tasks = fortuna.schemaChecks(handle);
        expect(tasks).toHaveLength(2);

        const atlasTask = tasks.find((t) => t.contract === 'atlas')!;
        const fortunaTask = tasks.find((t) => t.contract === 'fortuna')!;
        expect(atlasTask.address.equals(ATLAS_ADDR)).toBe(true);
        expect(atlasTask.sdkVariable).toBe('ATLAS_STORAGE_VERSION');
        expect(fortunaTask.address.equals(FORTUNA_ADDR)).toBe(true);
        expect(fortunaTask.sdkVariable).toBe('FORTUNA_STORAGE_VERSION');

        await expect(atlasTask.read()).resolves.toBe(1);
        await expect(fortunaTask.read()).resolves.toBe(1);
        expect((atlasContract as { getSchemaVersions: jest.Mock }).getSchemaVersions).toHaveBeenCalled();
        expect((fortunaContract as { getSchemaVersions: jest.Mock }).getSchemaVersions).toHaveBeenCalled();
    });

    it('returns [] when atlas or fortuna contracts are missing (product disabled)', () => {
        const handle: ProductHandle = {
            client: stubClient({}),
            addresses: {},
            contracts: {},
        };
        expect(fortuna.schemaChecks(handle)).toEqual([]);
    });
});

describe('fortuna ProductModule.eventStreams', () => {
    it('returns a single EventSource targeting the fortuna address with the SDK decoder', () => {
        const handle: ProductHandle = {
            client: stubClient({}),
            addresses: { atlas: ATLAS_ADDR, fortuna: FORTUNA_ADDR },
            contracts: {},
        };

        const sources = fortuna.eventStreams(handle);
        expect(sources).toHaveLength(1);
        expect(sources[0]!.source).toBe(FORTUNA_SOURCE);
        expect(sources[0]!.address.equals(FORTUNA_ADDR)).toBe(true);
        expect(sources[0]!.decode([] as Cell[])).toEqual([]);
    });

    it('returns [] when the fortuna address is absent', () => {
        const handle: ProductHandle = {
            client: stubClient({}),
            addresses: {},
            contracts: {},
        };
        expect(fortuna.eventStreams(handle)).toEqual([]);
    });
});

describe('fortuna ProductModule.bootstrapWorker', () => {
    let tmp: string;
    const savedHome = process.env.TITON_HOME;

    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), 'titon-automaton-fortuna-bootstrap-'));
        // Sub-dir mirrors blsPath()'s join pattern (TITON_HOME/automaton/bls.enc).
        mkdirSync(join(tmp, 'automaton'), { recursive: true });
        process.env.TITON_HOME = tmp;
    });

    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true });
        if (savedHome === undefined) {
            delete process.env.TITON_HOME;
        } else {
            process.env.TITON_HOME = savedHome;
        }
    });

    it('throws a clear error when bls.enc is missing', async () => {
        await expect(fortuna.bootstrapWorker!(makeProductContext())).rejects.toThrow(
            /bls\.enc is missing/,
        );
    });

    it('returns a FortunaWorker when bls.enc exists and unlocks with walletPassword', async () => {
        // Materialise a real bls.enc under TITON_HOME.
        saveBlsKeystore(lockBlsKeystore(randomBlsSecret(), PASSWORD, FAST_KDF));

        const { log, messages } = captureLogger();
        const worker = await fortuna.bootstrapWorker!(makeProductContext({ logger: log }));

        expect(worker).toBeInstanceOf(FortunaWorker);
        // bootstrapWorker logs an init line with the pkShare hex (48 bytes / 96 hex chars).
        const initLog = messages.find((m) => m.msg === 'fortuna worker initialised');
        expect(initLog).toBeDefined();
        expect(initLog!.fields?.pkShare).toMatch(/^[0-9a-f]{96}$/);
        expect(initLog!.fields?.atlas).toBe(ATLAS_ADDR.toString());
        expect(initLog!.fields?.fortuna).toBe(FORTUNA_ADDR.toString());
    });

    it('throws when openContracts skipped fortuna (defense-in-depth assertion)', async () => {
        // bls.enc present so the first guard passes — verifies the SECOND
        // guard (no fortuna contract handle) fires correctly.
        saveBlsKeystore(lockBlsKeystore(randomBlsSecret(), PASSWORD, FAST_KDF));

        await expect(
            fortuna.bootstrapWorker!(makeProductContext({ contracts: {} })),
        ).rejects.toThrow(/openContracts returned no fortuna handle/);
    });
});

describe('fortuna ProductModule.buildHandlers — composition', () => {
    it('returns 2 handlers (awareness + health) when no worker is bootstrapped', () => {
        expect(fortuna.buildHandlers(makeProductContext())).toHaveLength(2);
    });

    it('returns 3 handlers (awareness + health + config-invalidator) when a worker is present', () => {
        const { worker } = makeStubWorker();
        expect(fortuna.buildHandlers(makeProductContext({ worker }))).toHaveLength(3);
    });
});

// ----- Handler dispatch (composed handler set, behavior assertions) -----

describe('fortuna handler dispatch — OperatorMirrored awareness', () => {
    it('logs at info when this automaton is the subject', async () => {
        const { log, messages } = captureLogger();
        const handlers = fortuna.buildHandlers(makeProductContext({ logger: log }));

        const event: FortunaEvent = {
            kind: 'OperatorMirrored',
            opcode: 0,
            automaton: ME,
            isActive: true,
            cause: 1,
        };
        await dispatchToAll(handlers, event);

        expect(messages).toHaveLength(1);
        expect(messages[0]!.level).toBe('info');
        expect(messages[0]!.msg).toContain('operator mirror updated for self');
        expect(messages[0]!.fields?.isActive).toBe(true);
        expect(messages[0]!.fields?.cause).toBe(1);
    });

    it('silently drops OperatorMirrored for OTHER', async () => {
        const { log, messages } = captureLogger();
        const handlers = fortuna.buildHandlers(makeProductContext({ logger: log }));

        const event: FortunaEvent = {
            kind: 'OperatorMirrored',
            opcode: 0,
            automaton: OTHER,
            isActive: true,
            cause: 1,
        };
        await dispatchToAll(handlers, event);

        expect(messages).toEqual([]);
    });

    it('silently drops awareness-irrelevant kinds (e.g. RequestCreated)', async () => {
        const { log, messages } = captureLogger();
        const handlers = fortuna.buildHandlers(makeProductContext({ logger: log }));

        const event: FortunaEvent = {
            kind: 'RequestCreated',
            opcode: 0,
            reqKey: 1n,
            consumer: OTHER,
            queryId: 1n,
            seed: 0n,
            deadline: 9_999_999,
            groupEpoch: 1,
            creationLt: 1n,
        };
        await dispatchToAll(handlers, event);

        expect(messages).toEqual([]);
    });
});

describe('fortuna handler dispatch — protocol-health logging', () => {
    it('logs Paused at warn', async () => {
        const { log, messages } = captureLogger();
        const handlers = fortuna.buildHandlers(makeProductContext({ logger: log }));
        await dispatchToAll(handlers, { kind: 'Paused', opcode: 0 });

        expect(messages).toHaveLength(1);
        expect(messages[0]!.level).toBe('warn');
        expect(messages[0]!.msg).toContain('PAUSED');
    });

    it('logs Unpaused at info', async () => {
        const { log, messages } = captureLogger();
        const handlers = fortuna.buildHandlers(makeProductContext({ logger: log }));
        await dispatchToAll(handlers, { kind: 'Unpaused', opcode: 0 });

        expect(messages).toHaveLength(1);
        expect(messages[0]!.level).toBe('info');
        expect(messages[0]!.msg).toContain('resumed');
    });

    it('logs GroupKeyCached at warn with rotation context', async () => {
        const { log, messages } = captureLogger();
        const handlers = fortuna.buildHandlers(makeProductContext({ logger: log }));

        await dispatchToAll(handlers, {
            kind: 'GroupKeyCached',
            opcode: 0,
            groupId: 1,
            oldEpoch: 1,
            newEpoch: 2,
            groupPk: Buffer.alloc(48, 0xa1),
            threshold: 1,
            memberCount: 1,
        });

        expect(messages).toHaveLength(1);
        expect(messages[0]!.level).toBe('warn');
        expect(messages[0]!.msg).toContain('group key rotated');
        expect(messages[0]!.fields?.oldEpoch).toBe(1);
        expect(messages[0]!.fields?.newEpoch).toBe(2);
    });

    it.each([
        {
            event: {
                kind: 'CodeUpgradeProposed',
                opcode: 0,
                newCodeHash: 0xdeadbeefn,
                eta: 9_999_999,
            } satisfies FortunaEvent,
            level: 'warn',
        },
        {
            event: {
                kind: 'CodeUpgradeExecuted',
                opcode: 0,
                newCodeHash: 0xdeadbeefn,
                oldCodeHash: 0xcafef00dn,
            } satisfies FortunaEvent,
            level: 'warn',
        },
        {
            event: {
                kind: 'CodeUpgradeCancelled',
                opcode: 0,
                newCodeHash: 0xdeadbeefn,
            } satisfies FortunaEvent,
            level: 'info',
        },
    ])('logs $event.kind at $level with the new code hash', async ({ event, level }) => {
        const { log, messages } = captureLogger();
        const handlers = fortuna.buildHandlers(makeProductContext({ logger: log }));
        await dispatchToAll(handlers, event);

        expect(messages).toHaveLength(1);
        expect(messages[0]!.level).toBe(level);
        expect(messages[0]!.fields?.newCodeHash).toBe('deadbeef');
    });

    it('logs FeesWithdrawn at info', async () => {
        const { log, messages } = captureLogger();
        const handlers = fortuna.buildHandlers(makeProductContext({ logger: log }));

        await dispatchToAll(handlers, {
            kind: 'FeesWithdrawn',
            opcode: 0,
            to: OTHER,
            amount: 1_000_000n,
        });

        expect(messages).toHaveLength(1);
        expect(messages[0]!.level).toBe('info');
        expect(messages[0]!.msg).toContain('owner withdrew');
        expect(messages[0]!.fields?.to).toBe(OTHER.toString());
        expect(messages[0]!.fields?.amount).toBe('1000000');
    });
});

describe('fortuna handler dispatch — config-cache invalidator', () => {
    it('drops the worker config cache on Fortuna ConfigUpdated', async () => {
        const { worker } = makeStubWorker();
        const dropSpy = jest.spyOn(worker, 'dropConfigCache');

        const handlers = fortuna.buildHandlers(makeProductContext({ worker }));
        await dispatchToAll(handlers, {
            kind: 'ConfigUpdated',
            opcode: 0,
            baseRequestFee: 100n,
            submitterReward: 50n,
            requestTtl: 3600,
            minForwardReserve: 30n,
            minStorageReserve: 0n,
        });

        expect(dropSpy).toHaveBeenCalledTimes(1);
    });

    it('does NOT poke the worker on unrelated event kinds (e.g. Paused)', async () => {
        const { worker } = makeStubWorker();
        const dropSpy = jest.spyOn(worker, 'dropConfigCache');

        const handlers = fortuna.buildHandlers(makeProductContext({ worker }));
        await dispatchToAll(handlers, { kind: 'Paused', opcode: 0 });

        expect(dropSpy).not.toHaveBeenCalled();
    });
});
