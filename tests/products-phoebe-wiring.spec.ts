// phoebe ProductModule wiring — coverage parallel to
// products-fortuna-wiring.spec.ts. Pins the methods that compose phoebe
// into the daemon runtime: openContracts, schemaChecks, eventStreams,
// bootstrapWorker (incl. share-exchange server stand-up + dispose for
// multi-op), buildHandlers + the awareness/health handler dispatch.
//
// Companion to products-phoebe.spec.ts (which only exercises
// isEnabled / resolveAddresses / explainError / doctorInstallChecks).

import { type Cell, type OpenedContract } from '@ton/core';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Atlas } from '@titon-network/atlas-sdk';
import type { Phoebe, PhoebeEvent } from '@titon-network/phoebe-sdk';
import { lockBlsKeystore, randomBlsSecret, saveBlsKeystore } from '../src/bls';
import { defaultConfig } from '../src/config/schema';
import { phoebe, PHOEBE_SOURCE } from '../src/products/phoebe';
import { PhoebeWorker } from '../src/worker/phoebe';
import type { EventHandler, TxContext } from '../src/worker/events';
import type { ProductContext, ProductHandle, ProductWorker } from '../src/products/types';
import type { WorkerLogger } from '../src/worker/loop';
import type { FailoverTonClient } from '../src/chain/ton-client';
import { captureLogger, silentLogger } from './helpers/logger';
import { fakeAddress, fakeTxContext, fakeWallet } from './helpers/fixtures';

const PASSWORD = 'correct-horse-battery-staple';
const FAST_KDF = { kdfN: 2048 };

const ME = fakeAddress(0xaa);
const OTHER = fakeAddress(0xbb);
const ATLAS_ADDR = fakeAddress(0xa1);
const PHOEBE_ADDR = fakeAddress(0xfa);

function stubPhoebeContract(opts: { storageVersion?: number; groupEpoch?: number } = {}): unknown {
    return {
        address: PHOEBE_ADDR,
        getSchemaVersions: jest
            .fn()
            .mockResolvedValue({ storage: opts.storageVersion ?? 1 }),
        getGroupKey: jest
            .fn()
            .mockResolvedValue({ groupEpoch: opts.groupEpoch ?? 0, groupPk: Buffer.alloc(48) }),
        getLastSubmitter: jest.fn().mockResolvedValue(null),
        sendPushSnapshot: jest.fn().mockResolvedValue(undefined),
    };
}

function stubAtlasContract(opts: { storageVersion?: number } = {}): unknown {
    return {
        address: ATLAS_ADDR,
        getSchemaVersions: jest
            .fn()
            .mockResolvedValue({ storage: opts.storageVersion ?? 1 }),
        getOperatorShare: jest.fn().mockResolvedValue(null),
    };
}

function stubClient(opens: { atlas?: unknown; phoebe?: unknown }): FailoverTonClient {
    return {
        open: (contract: { address?: import('@ton/core').Address }) => {
            if (contract.address?.equals(ATLAS_ADDR)) return opens.atlas;
            if (contract.address?.equals(PHOEBE_ADDR)) return opens.phoebe;
            return { sender: () => ({ send: () => Promise.resolve() }) };
        },
    } as unknown as FailoverTonClient;
}

function makeProductContext(opts: {
    me?: import('@ton/core').Address;
    contracts?: ProductContext['contracts'];
    logger?: WorkerLogger;
    worker?: ProductWorker;
    phoebeCfg?: NonNullable<import('../src/config/schema').Config['phoebe']>;
} = {}): ProductContext {
    const phoebeContract = stubPhoebeContract();
    const atlasContract = stubAtlasContract();
    const config = defaultConfig('testnet');
    config.products.phoebe = true;
    if (opts.phoebeCfg !== undefined) config.phoebe = opts.phoebeCfg;
    const ctx: ProductContext = {
        client: stubClient({ atlas: atlasContract, phoebe: phoebeContract }),
        addresses: { atlas: ATLAS_ADDR, phoebe: PHOEBE_ADDR },
        contracts: opts.contracts ?? {
            atlas: atlasContract as OpenedContract<Atlas>,
            phoebe: phoebeContract as OpenedContract<Phoebe>,
        },
        config,
        wallet: fakeWallet(opts.me ?? ME),
        walletPassword: PASSWORD,
        logger: opts.logger ?? silentLogger(),
    };
    if (opts.worker !== undefined) ctx.worker = opts.worker;
    return ctx;
}

async function dispatchToAll(
    handlers: readonly EventHandler[],
    event: PhoebeEvent,
    ctx: TxContext = fakeTxContext(),
): Promise<void> {
    for (const h of handlers) {
        const cb = h.on?.[PHOEBE_SOURCE];
        if (cb !== undefined) await cb(event, ctx);
    }
}

// ===== openContracts =====

describe('phoebe ProductModule.openContracts', () => {
    it('returns atlas + phoebe handles when addresses present', () => {
        const atlasOpened = stubAtlasContract();
        const phoebeOpened = stubPhoebeContract();
        const handle: ProductHandle = {
            client: stubClient({ atlas: atlasOpened, phoebe: phoebeOpened }),
            addresses: { atlas: ATLAS_ADDR, phoebe: PHOEBE_ADDR },
            contracts: {},
        };
        const contracts = phoebe.openContracts(handle);
        expect(Object.keys(contracts).sort()).toEqual(['atlas', 'phoebe']);
        expect(contracts.atlas).toBe(atlasOpened);
        expect(contracts.phoebe).toBe(phoebeOpened);
    });

    it('returns {} when addresses bag is empty (product disabled)', () => {
        const handle: ProductHandle = { client: stubClient({}), addresses: {}, contracts: {} };
        expect(phoebe.openContracts(handle)).toEqual({});
    });
});

// ===== schemaChecks =====

describe('phoebe ProductModule.schemaChecks', () => {
    it('returns 2 tasks (atlas + phoebe) with read fns hitting getSchemaVersions().storage', async () => {
        const atlasContract = stubAtlasContract({ storageVersion: 1 });
        const phoebeContract = stubPhoebeContract({ storageVersion: 1 });
        const handle: ProductHandle = {
            client: stubClient({}),
            addresses: { atlas: ATLAS_ADDR, phoebe: PHOEBE_ADDR },
            contracts: {
                atlas: atlasContract as OpenedContract<Atlas>,
                phoebe: phoebeContract as OpenedContract<Phoebe>,
            },
        };
        const tasks = phoebe.schemaChecks(handle);
        expect(tasks).toHaveLength(2);
        const atlasTask = tasks.find((t) => t.contract === 'atlas')!;
        const phoebeTask = tasks.find((t) => t.contract === 'phoebe')!;
        expect(atlasTask.sdkVariable).toBe('ATLAS_STORAGE_VERSION');
        expect(phoebeTask.sdkVariable).toBe('PHOEBE_STORAGE_VERSION');
        await expect(atlasTask.read()).resolves.toBe(1);
        await expect(phoebeTask.read()).resolves.toBe(1);
    });

    it('returns [] when contracts are missing', () => {
        const handle: ProductHandle = { client: stubClient({}), addresses: {}, contracts: {} };
        expect(phoebe.schemaChecks(handle)).toEqual([]);
    });
});

// ===== eventStreams =====

describe('phoebe ProductModule.eventStreams', () => {
    it('returns a single EventSource for the phoebe address', () => {
        const handle: ProductHandle = {
            client: stubClient({}),
            addresses: { atlas: ATLAS_ADDR, phoebe: PHOEBE_ADDR },
            contracts: {},
        };
        const sources = phoebe.eventStreams(handle);
        expect(sources).toHaveLength(1);
        expect(sources[0]!.source).toBe(PHOEBE_SOURCE);
        expect(sources[0]!.address.equals(PHOEBE_ADDR)).toBe(true);
        expect(sources[0]!.decode([] as Cell[])).toEqual([]);
    });

    it('returns [] when phoebe address is absent', () => {
        const handle: ProductHandle = { client: stubClient({}), addresses: {}, contracts: {} };
        expect(phoebe.eventStreams(handle)).toEqual([]);
    });
});

// ===== bootstrapWorker =====

describe('phoebe ProductModule.bootstrapWorker', () => {
    let tmp: string;
    const savedHome = process.env.TITON_HOME;

    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), 'titon-automaton-phoebe-bootstrap-'));
        mkdirSync(join(tmp, 'automaton'), { recursive: true });
        process.env.TITON_HOME = tmp;
    });

    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true });
        if (savedHome === undefined) delete process.env.TITON_HOME;
        else process.env.TITON_HOME = savedHome;
    });

    it('throws when bls.enc is missing', async () => {
        await expect(phoebe.bootstrapWorker!(makeProductContext())).rejects.toThrow(
            /bls\.enc is missing/,
        );
    });

    it('returns a PhoebeWorker in SOLO mode (peers undefined → no share-exchange server)', async () => {
        saveBlsKeystore(lockBlsKeystore(randomBlsSecret(), PASSWORD, FAST_KDF));
        const { log, messages } = captureLogger();
        const worker = await phoebe.bootstrapWorker!(makeProductContext({ logger: log }));
        expect(worker).toBeInstanceOf(PhoebeWorker);
        // Init log reports solo mode + no shareExchangePort.
        const initLog = messages.find((m) => m.msg === 'phoebe worker initialised');
        expect(initLog).toBeDefined();
        expect(initLog!.fields?.mode).toBe('solo');
        expect(initLog!.fields?.shareExchangePort).toBeUndefined();
        // No "price-source manager started" — no dynamic feeds.
        expect(messages.find((m) => m.msg === 'phoebe: price-source manager started')).toBeUndefined();
        // dispose is a no-op in solo (no serverHandle).
        await expect((worker as PhoebeWorker).dispose()).resolves.toBeUndefined();
    });

    it('stands up share-exchange server in MULTI-OP mode (peers configured)', async () => {
        saveBlsKeystore(lockBlsKeystore(randomBlsSecret(), PASSWORD, FAST_KDF));
        const { log, messages } = captureLogger();
        const ctx = makeProductContext({
            logger: log,
            phoebeCfg: {
                pushIntervalMs: 30_000,
                peers: [
                    {
                        address: OTHER.toString({ bounceable: false }),
                        endpoint: 'http://peer-1:9092',
                    },
                ],
                shareExchangePort: 0, // ephemeral
                shareExchangeHost: '127.0.0.1',
            },
        });
        const worker = await phoebe.bootstrapWorker!(ctx);
        expect(worker).toBeInstanceOf(PhoebeWorker);
        const initLog = messages.find((m) => m.msg === 'phoebe worker initialised');
        expect(initLog).toBeDefined();
        expect(initLog!.fields?.mode).toMatch(/^multi-op \(n=2\)$/);
        expect(initLog!.fields?.shareExchangePort).toBeDefined();
        expect(typeof initLog!.fields?.shareExchangePort).toBe('number');
        // dispose must close the server (no leaked port).
        await expect((worker as PhoebeWorker).dispose()).resolves.toBeUndefined();
    });

    it('throws when openContracts skipped phoebe handle (defense-in-depth)', async () => {
        saveBlsKeystore(lockBlsKeystore(randomBlsSecret(), PASSWORD, FAST_KDF));
        await expect(
            phoebe.bootstrapWorker!(makeProductContext({ contracts: {} })),
        ).rejects.toThrow(/openContracts returned no phoebe handle/);
    });
});

// ===== buildHandlers composition =====

describe('phoebe ProductModule.buildHandlers — composition', () => {
    it('returns 2 handlers (awareness + health)', () => {
        expect(phoebe.buildHandlers(makeProductContext())).toHaveLength(2);
    });
});

// ===== Handler dispatch =====

describe('phoebe handler dispatch — OperatorMirrored / SnapshotPushed / RewardClaimed / OperatorPruned', () => {
    it('logs at info when OperatorMirrored names this automaton', async () => {
        const { log, messages } = captureLogger();
        const handlers = phoebe.buildHandlers(makeProductContext({ logger: log }));
        await dispatchToAll(handlers, {
            kind: 'OperatorMirrored',
            opcode: 0,
            automaton: ME,
            isActive: true,
            cause: 1,
        } as PhoebeEvent);
        expect(messages.some((m) => m.msg.includes('operator mirror updated for self'))).toBe(true);
    });

    it('silently drops OperatorMirrored for OTHER', async () => {
        const { log, messages } = captureLogger();
        const handlers = phoebe.buildHandlers(makeProductContext({ logger: log }));
        await dispatchToAll(handlers, {
            kind: 'OperatorMirrored',
            opcode: 0,
            automaton: OTHER,
            isActive: true,
            cause: 1,
        } as PhoebeEvent);
        expect(messages.find((m) => m.msg.includes('operator mirror updated for self'))).toBeUndefined();
    });

    it('logs at warn on Paused (health handler)', async () => {
        const { log, messages } = captureLogger();
        const handlers = phoebe.buildHandlers(makeProductContext({ logger: log }));
        await dispatchToAll(handlers, { kind: 'Paused' } as PhoebeEvent);
        const m = messages.find((x) => x.msg.includes('phoebe: PAUSED'));
        expect(m).toBeDefined();
        expect(m!.level).toBe('warn');
    });

    it('logs at warn on GroupKeyCached (rotation)', async () => {
        const { log, messages } = captureLogger();
        const handlers = phoebe.buildHandlers(makeProductContext({ logger: log }));
        await dispatchToAll(handlers, {
            kind: 'GroupKeyCached',
            groupId: 0,
            oldEpoch: 1,
            newEpoch: 2,
            groupPk: Buffer.alloc(48),
            threshold: 1,
            memberCount: 2,
        } as PhoebeEvent);
        const m = messages.find((x) => x.msg.includes('group key rotated'));
        expect(m).toBeDefined();
        expect(m!.level).toBe('warn');
    });

    it('logs RewardClaimed for self', async () => {
        const { log, messages } = captureLogger();
        const handlers = phoebe.buildHandlers(makeProductContext({ logger: log }));
        await dispatchToAll(handlers, {
            kind: 'RewardClaimed',
            claimant: ME,
            to: ME,
            amount: 1_000n,
        } as PhoebeEvent);
        expect(messages.some((m) => m.msg.includes('we claimed accrued reward'))).toBe(true);
    });

    it('silently drops RewardClaimed for OTHER', async () => {
        const { log, messages } = captureLogger();
        const handlers = phoebe.buildHandlers(makeProductContext({ logger: log }));
        await dispatchToAll(handlers, {
            kind: 'RewardClaimed',
            claimant: OTHER,
            to: OTHER,
            amount: 1_000n,
        } as PhoebeEvent);
        expect(messages.find((m) => m.msg.includes('we claimed accrued reward'))).toBeUndefined();
    });
});
