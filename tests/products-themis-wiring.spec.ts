// themis ProductModule — coverage for the methods that wire the product
// into runtime: openContracts, schemaChecks, eventStreams, bootstrapWorker,
// and the buildHandlers-internal handlers (awareness + protocol-health +
// per-chamber config invalidator).
//
// Companion to products-themis.spec.ts (which only exercises the unit-
// level isEnabled / resolveAddresses / explainError / doctorInstallChecks).

import { Address, type Cell, type OpenedContract } from '@ton/core';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ThemisChamber, ThemisFactory, ThemisEvent } from '@titon-network/themis-sdk';
import { lockBlsKeystore, randomBlsSecret, saveBlsKeystore } from '../src/bls';
import { defaultConfig } from '../src/config/schema';
import { themis } from '../src/products/themis';
import {
    THEMIS_CHAMBER_SOURCE_PREFIX,
    THEMIS_CHAMBER_ADDR_KEY_PREFIX,
    THEMIS_FACTORY_SOURCE,
    ThemisWorker,
    chamberSourceKey,
    themisChamberAddrKey,
} from '../src/worker/themis';
import type { EventHandler, TxContext } from '../src/worker/events';
import type {
    ProductContext,
    ProductHandle,
    ProductWorker,
} from '../src/products/types';
import type { WorkerLogger } from '../src/worker/loop';
import type { FailoverTonClient } from '../src/chain/ton-client';
import { captureLogger, silentLogger } from './helpers/logger';
import { fakeAddress, fakeTxContext, fakeWallet } from './helpers/fixtures';

const PASSWORD = 'correct-horse-battery-staple';
const FAST_KDF = { kdfN: 2048 };

const ME = fakeAddress(0xaa);
const OTHER = fakeAddress(0xbb);
const ATLAS_ADDR = fakeAddress(0xa1);
const FORGETON_ADDR = fakeAddress(0xf0);
const FACTORY_ADDR = fakeAddress(0xfc);
const CHAMBER1 = fakeAddress(0xc1);
const CHAMBER2 = fakeAddress(0xc2);

function stubFactory(opts: { storageVersion?: number } = {}): unknown {
    return {
        address: FACTORY_ADDR,
        getSchemaVersions: jest.fn().mockResolvedValue({ storage: opts.storageVersion ?? 1 }),
    };
}

function stubChamber(addr: Address, opts: { storageVersion?: number } = {}): unknown {
    return {
        address: addr,
        getSchemaVersions: jest.fn().mockResolvedValue({ storage: opts.storageVersion ?? 2 }),
        getOperator: jest.fn().mockResolvedValue(null),
        getCurrentRound: jest.fn().mockResolvedValue({
            roundId: 0n,
            commitEta: 0,
            revealEta: 0,
        }),
        getGroupKey: jest.fn().mockResolvedValue({
            entryVersion: 0,
            groupPk: Buffer.alloc(48, 0),
            groupEpoch: 0,
            threshold: 0,
            memberCount: 0,
            cachedAt: 0,
        }),
        getConfig: jest.fn().mockResolvedValue({
            configVersion: 1,
            submitFee: 0n,
            revealerReward: 0n,
            callbackGas: 0n,
            commitDuration: 0,
            revealDuration: 0,
            maxBidsPerRound: 0,
            advanceReward: 0n,
            minReserve: 0n,
            minXcGas: 0n,
            rewardPool: 0n,
        }),
    };
}

function stubAtlas(opts: { storageVersion?: number } = {}): unknown {
    return {
        address: ATLAS_ADDR,
        getSchemaVersions: jest.fn().mockResolvedValue({ storage: opts.storageVersion ?? 1 }),
    };
}

function stubClient(opens: Map<string, unknown>): FailoverTonClient {
    return {
        open: (contract: { address?: Address }) => {
            if (contract.address === undefined) {
                return { sender: () => ({ send: () => Promise.resolve() }) };
            }
            const key = contract.address.toString({ bounceable: false });
            return opens.get(key) ?? { sender: () => ({ send: () => Promise.resolve() }) };
        },
    } as unknown as FailoverTonClient;
}

function configWithThemis(overrides?: Partial<{ chambers: string[] }>): ReturnType<typeof defaultConfig> {
    const cfg = defaultConfig('testnet');
    cfg.products.themis = true;
    cfg.themis = {
        atlasAddress: ATLAS_ADDR.toString(),
        forgetonAddress: FORGETON_ADDR.toString(),
        factoryAddress: FACTORY_ADDR.toString(),
        chambers: overrides?.chambers ?? [CHAMBER1.toString(), CHAMBER2.toString()],
    };
    return cfg;
}

function makeProductContext(opts: {
    me?: Address;
    contracts?: ProductContext['contracts'];
    logger?: WorkerLogger;
    worker?: ProductWorker;
    chambers?: string[];
} = {}): ProductContext {
    const cfg = configWithThemis({ chambers: opts.chambers ?? [CHAMBER1.toString(), CHAMBER2.toString()] });
    const opens = new Map<string, unknown>();
    opens.set(ATLAS_ADDR.toString({ bounceable: false }), stubAtlas());
    opens.set(FACTORY_ADDR.toString({ bounceable: false }), stubFactory());
    opens.set(CHAMBER1.toString({ bounceable: false }), stubChamber(CHAMBER1));
    opens.set(CHAMBER2.toString({ bounceable: false }), stubChamber(CHAMBER2));
    const ctx: ProductContext = {
        client: stubClient(opens),
        addresses: themis.resolveAddresses(cfg),
        contracts:
            opts.contracts ?? {
                atlas: opens.get(ATLAS_ADDR.toString({ bounceable: false }))! as OpenedContract<unknown>,
                factory: opens.get(FACTORY_ADDR.toString({ bounceable: false }))! as OpenedContract<unknown>,
                [themisChamberAddrKey(CHAMBER1)]: opens.get(
                    CHAMBER1.toString({ bounceable: false }),
                )! as OpenedContract<unknown>,
                [themisChamberAddrKey(CHAMBER2)]: opens.get(
                    CHAMBER2.toString({ bounceable: false }),
                )! as OpenedContract<unknown>,
            },
        config: cfg,
        wallet: fakeWallet(opts.me ?? ME),
        walletPassword: PASSWORD,
        logger: opts.logger ?? silentLogger(),
    };
    if (opts.worker !== undefined) ctx.worker = opts.worker;
    return ctx;
}

async function dispatchToAll(
    handlers: readonly EventHandler[],
    source: string,
    event: ThemisEvent,
    ctx: TxContext = fakeTxContext(),
): Promise<void> {
    for (const h of handlers) {
        const cb = h.on?.[source];
        if (cb !== undefined) await cb(event, ctx);
    }
}

describe('themis ProductModule.openContracts', () => {
    it('returns atlas + factory + per-chamber handles when addresses are present', () => {
        const cfg = configWithThemis();
        const opens = new Map<string, unknown>();
        opens.set(ATLAS_ADDR.toString({ bounceable: false }), stubAtlas());
        opens.set(FACTORY_ADDR.toString({ bounceable: false }), stubFactory());
        opens.set(CHAMBER1.toString({ bounceable: false }), stubChamber(CHAMBER1));
        opens.set(CHAMBER2.toString({ bounceable: false }), stubChamber(CHAMBER2));

        const handle: ProductHandle = {
            client: stubClient(opens),
            addresses: themis.resolveAddresses(cfg),
            contracts: {},
        };
        const contracts = themis.openContracts(handle);
        const keys = Object.keys(contracts).sort();
        expect(keys).toContain('atlas');
        expect(keys).toContain('factory');
        const chamberKeys = keys.filter((k) => k.startsWith(THEMIS_CHAMBER_ADDR_KEY_PREFIX));
        expect(chamberKeys).toHaveLength(2);
    });

    it('returns {} when addresses bag is empty', () => {
        const handle: ProductHandle = {
            client: stubClient(new Map()),
            addresses: {},
            contracts: {},
        };
        expect(themis.openContracts(handle)).toEqual({});
    });
});

describe('themis ProductModule.schemaChecks', () => {
    it('returns atlas + themis-factory + per-chamber tasks', async () => {
        const atlas = stubAtlas({ storageVersion: 1 });
        const factory = stubFactory({ storageVersion: 1 });
        const chamber1 = stubChamber(CHAMBER1, { storageVersion: 2 });

        const handle: ProductHandle = {
            client: stubClient(new Map()),
            addresses: { atlas: ATLAS_ADDR, factory: FACTORY_ADDR },
            contracts: {
                atlas: atlas as OpenedContract<unknown>,
                factory: factory as OpenedContract<unknown>,
                [themisChamberAddrKey(CHAMBER1)]: chamber1 as OpenedContract<unknown>,
            },
        };

        const tasks = themis.schemaChecks(handle);
        expect(tasks).toHaveLength(3);
        const byContract = Object.fromEntries(tasks.map((t) => [t.contract, t]));
        expect(byContract['atlas']!.sdkVariable).toBe('ATLAS_STORAGE_VERSION');
        expect(byContract['themis-factory']!.sdkVariable).toBe('THEMIS_FACTORY_STORAGE_VERSION');
        const chamberTask = Object.values(byContract).find((t) =>
            t.contract.startsWith(THEMIS_CHAMBER_ADDR_KEY_PREFIX),
        )!;
        expect(chamberTask.sdkVariable).toBe('THEMIS_CHAMBER_STORAGE_VERSION');

        await expect(byContract['atlas']!.read()).resolves.toBe(1);
        await expect(byContract['themis-factory']!.read()).resolves.toBe(1);
        await expect(chamberTask.read()).resolves.toBe(2);
    });

    it('returns [] when atlas or factory contracts are missing', () => {
        const handle: ProductHandle = {
            client: stubClient(new Map()),
            addresses: {},
            contracts: {},
        };
        expect(themis.schemaChecks(handle)).toEqual([]);
    });
});

describe('themis ProductModule.eventStreams', () => {
    it('returns factory + per-chamber streams using the SDK decoder', () => {
        const cfg = configWithThemis();
        const handle: ProductHandle = {
            client: stubClient(new Map()),
            addresses: themis.resolveAddresses(cfg),
            contracts: {},
        };
        const sources = themis.eventStreams(handle);
        // 1 factory + 2 chambers = 3
        expect(sources).toHaveLength(3);
        const sourceNames = sources.map((s) => s.source);
        expect(sourceNames).toContain(THEMIS_FACTORY_SOURCE);
        expect(sourceNames.filter((n) => n.startsWith(`${THEMIS_CHAMBER_SOURCE_PREFIX}:`))).toHaveLength(2);
        // Decoder is functional (returns [] for empty input).
        expect(sources[0]!.decode([] as Cell[])).toEqual([]);
    });

    it('returns [] when the factory address is absent', () => {
        const handle: ProductHandle = {
            client: stubClient(new Map()),
            addresses: {},
            contracts: {},
        };
        expect(themis.eventStreams(handle)).toEqual([]);
    });
});

describe('themis ProductModule.bootstrapWorker', () => {
    let tmp: string;
    const savedHome = process.env.TITON_HOME;

    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), 'titon-automaton-themis-bootstrap-'));
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
        await expect(themis.bootstrapWorker!(makeProductContext())).rejects.toThrow(
            /bls\.enc is missing/,
        );
    });

    it('returns a ThemisWorker when bls.enc exists', async () => {
        saveBlsKeystore(lockBlsKeystore(randomBlsSecret(), PASSWORD, FAST_KDF));

        const { log, messages } = captureLogger();
        const worker = await themis.bootstrapWorker!(makeProductContext({ logger: log }));

        expect(worker).toBeInstanceOf(ThemisWorker);
        const initLog = messages.find((m) => m.msg === 'themis worker initialised');
        expect(initLog).toBeDefined();
        expect(initLog!.fields?.pkShare).toMatch(/^[0-9a-f]{96}$/);
        expect(initLog!.fields?.atlas).toBe(ATLAS_ADDR.toString());
        expect(initLog!.fields?.factory).toBe(FACTORY_ADDR.toString());
        expect(initLog!.fields?.chamberCount).toBe(2);
    });
});

describe('themis ProductModule.buildHandlers — composition', () => {
    it('returns 2 handlers (awareness + health) when no worker is bootstrapped', () => {
        expect(themis.buildHandlers(makeProductContext())).toHaveLength(2);
    });

    it('returns 3 handlers (awareness + health + config-invalidator) when a worker is present', () => {
        // Build a real ThemisWorker — handler-list shape doesn't depend on
        // worker behaviour, just presence.
        const chambersMap = new Map<string, OpenedContract<ThemisChamber>>();
        const worker = new ThemisWorker({
            chambers: chambersMap,
            client: stubClient(new Map()),
            wallet: fakeWallet(ME),
            blsSecret: Buffer.from(randomBlsSecret()),
            logger: silentLogger(),
        });
        expect(themis.buildHandlers(makeProductContext({ worker }))).toHaveLength(3);
    });
});

describe('themis handler dispatch — awareness', () => {
    it('logs ChamberDeployed at info on the factory source', async () => {
        const { log, messages } = captureLogger();
        const handlers = themis.buildHandlers(makeProductContext({ logger: log }));

        const event: ThemisEvent = {
            kind: 'ChamberDeployed',
            opcode: 0,
            serial: 1n,
            chamber: CHAMBER1,
            chamberOwner: OTHER,
            consumer: OTHER,
            groupId: 0,
        };
        await dispatchToAll(handlers, THEMIS_FACTORY_SOURCE, event);

        const hit = messages.find((m) => m.msg.includes('new chamber deployed'));
        expect(hit).toBeDefined();
        expect(hit!.level).toBe('info');
        expect(hit!.fields?.chamber).toBe(CHAMBER1.toString());
    });

    it('logs OperatorSynced at info when this automaton is the subject', async () => {
        const { log, messages } = captureLogger();
        const handlers = themis.buildHandlers(makeProductContext({ logger: log }));

        const event: ThemisEvent = {
            kind: 'OperatorSynced',
            opcode: 0,
            automaton: ME,
            isActive: true,
        };
        await dispatchToAll(handlers, chamberSourceKey(CHAMBER1), event);

        const hit = messages.find((m) => m.msg.includes('operator-mirror updated for self'));
        expect(hit).toBeDefined();
        expect(hit!.level).toBe('info');
    });

    it('silently drops OperatorSynced for OTHER', async () => {
        const { log, messages } = captureLogger();
        const handlers = themis.buildHandlers(makeProductContext({ logger: log }));

        const event: ThemisEvent = {
            kind: 'OperatorSynced',
            opcode: 0,
            automaton: OTHER,
            isActive: true,
        };
        await dispatchToAll(handlers, chamberSourceKey(CHAMBER1), event);

        const operatorMessages = messages.filter((m) => m.msg.includes('operator-mirror'));
        expect(operatorMessages).toEqual([]);
    });
});

describe('themis handler dispatch — protocol-health logging', () => {
    it('logs Paused at warn (factory + chamber)', async () => {
        for (const source of [THEMIS_FACTORY_SOURCE, chamberSourceKey(CHAMBER1)]) {
            const { log, messages } = captureLogger();
            const handlers = themis.buildHandlers(makeProductContext({ logger: log }));
            await dispatchToAll(handlers, source, { kind: 'Paused', opcode: 0 });
            const hit = messages.find((m) => m.msg.includes('PAUSED'));
            expect(hit).toBeDefined();
            expect(hit!.level).toBe('warn');
        }
    });

    it('logs GroupKeyCached at warn with rotation context', async () => {
        const { log, messages } = captureLogger();
        const handlers = themis.buildHandlers(makeProductContext({ logger: log }));

        await dispatchToAll(handlers, chamberSourceKey(CHAMBER1), {
            kind: 'GroupKeyCached',
            opcode: 0,
            groupId: 0,
            oldEpoch: 1,
            newEpoch: 2,
            groupPk: Buffer.alloc(48, 0xa1),
            threshold: 1,
            memberCount: 1,
        });

        const hit = messages.find((m) => m.msg.includes('cached new group key'));
        expect(hit).toBeDefined();
        expect(hit!.level).toBe('warn');
        expect(hit!.fields?.oldEpoch).toBe(1);
        expect(hit!.fields?.newEpoch).toBe(2);
    });

    it('logs FeesWithdrawn at info', async () => {
        const { log, messages } = captureLogger();
        const handlers = themis.buildHandlers(makeProductContext({ logger: log }));

        await dispatchToAll(handlers, chamberSourceKey(CHAMBER1), {
            kind: 'FeesWithdrawn',
            opcode: 0,
            to: OTHER,
            amount: 1_000_000n,
        });

        const hit = messages.find((m) => m.msg.includes('owner withdrew fees'));
        expect(hit).toBeDefined();
        expect(hit!.level).toBe('info');
        expect(hit!.fields?.to).toBe(OTHER.toString());
    });

    it('logs ChildCodeUpdated at warn (factory only)', async () => {
        const { log, messages } = captureLogger();
        const handlers = themis.buildHandlers(makeProductContext({ logger: log }));

        await dispatchToAll(handlers, THEMIS_FACTORY_SOURCE, {
            kind: 'ChildCodeUpdated',
            opcode: 0,
            oldHash: 0xcafef00dn,
            newHash: 0xdeadbeefn,
        });

        const hit = messages.find((m) => m.msg.includes('child-code'));
        expect(hit).toBeDefined();
        expect(hit!.level).toBe('warn');
        expect(hit!.fields?.oldHash).toBe('cafef00d');
        expect(hit!.fields?.newHash).toBe('deadbeef');
    });
});

describe('themis handler dispatch — config-cache invalidator', () => {
    it('drops the worker config cache for the chamber on chamber ConfigUpdated', async () => {
        const chambersMap = new Map<string, OpenedContract<ThemisChamber>>();
        const worker = new ThemisWorker({
            chambers: chambersMap,
            client: stubClient(new Map()),
            wallet: fakeWallet(ME),
            blsSecret: Buffer.from(randomBlsSecret()),
            logger: silentLogger(),
        });
        const dropSpy = jest.spyOn(worker, 'dropConfigCache');

        const handlers = themis.buildHandlers(makeProductContext({ worker }));
        // ConfigUpdated body cell is opaque to the invalidator — it just
        // needs the address from the source key.
        const fakeBodyCell = ({ beginParse: () => ({}) } as unknown as Cell);
        await dispatchToAll(handlers, chamberSourceKey(CHAMBER1), {
            kind: 'ConfigUpdated',
            opcode: 0,
            body: fakeBodyCell,
        });

        expect(dropSpy).toHaveBeenCalledTimes(1);
        const calledWith = dropSpy.mock.calls[0]![0] as Address;
        expect(calledWith.equals(CHAMBER1)).toBe(true);
    });

    it('does NOT poke the worker on unrelated event kinds (e.g. Paused)', async () => {
        const chambersMap = new Map<string, OpenedContract<ThemisChamber>>();
        const worker = new ThemisWorker({
            chambers: chambersMap,
            client: stubClient(new Map()),
            wallet: fakeWallet(ME),
            blsSecret: Buffer.from(randomBlsSecret()),
            logger: silentLogger(),
        });
        const dropSpy = jest.spyOn(worker, 'dropConfigCache');

        const handlers = themis.buildHandlers(makeProductContext({ worker }));
        await dispatchToAll(handlers, chamberSourceKey(CHAMBER1), { kind: 'Paused', opcode: 0 });

        expect(dropSpy).not.toHaveBeenCalled();
    });
});
