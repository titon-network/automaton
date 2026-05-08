// kronos ProductModule — coverage for the methods that wire the product
// into runtime: openContracts, schemaChecks, eventStreams, bootstrapWorker,
// KronosWorker.tick / hasInFlight / eventHandler, and the buildHandlers-
// internal handlers (kronosAwarenessHandler, kronosHealthHandler).
//
// Companion to products-kronos.spec.ts (which only exercises
// isEnabled / resolveAddresses / explainError / doctorInstallChecks)
// and events.spec.ts (which already covers mirrorPatchHandler).
//
// Handler-dispatch tests dispatch each event through ALL handlers
// returned by `kronos.buildHandlers(ctx)`, then assert on the observable
// log line. This mirrors production (drainEvents fans every event to
// every handler) and avoids coupling tests to the order of returned handlers.

import { type Address, type OpenedContract } from '@ton/core';
import type { KronosRegistry, KronosEvent } from '@titon-network/kronos-sdk';
import { defaultConfig } from '../src/config/schema';
import { kronos, KronosWorker, REGISTRY_SOURCE } from '../src/products/kronos';
import { createDaemonMetrics } from '../src/daemon/metrics';
import type { EventHandler, TxContext } from '../src/worker/events';
import type { ProductContext, ProductHandle } from '../src/products/types';
import type { WorkerLogger } from '../src/worker/loop';
import type { FailoverTonClient } from '../src/chain/ton-client';
import { captureLogger, silentLogger } from './helpers/logger';
import { fakeAddress, fakeTxContext, fakeWallet } from './helpers/fixtures';

const ME = fakeAddress(0xaa);
const OTHER = fakeAddress(0xbb);
const REGISTRY_ADDR = fakeAddress(0xc1);

/** Registry stub with the methods schemaChecks + runWorkerCycle call. */
function stubRegistryContract(): unknown {
    return {
        address: REGISTRY_ADDR,
        getStorageVersion: jest.fn().mockResolvedValue(1),
        // tick() reads these via runWorkerCycle.
        getJobCount: jest.fn().mockResolvedValue(0n),
        getIsPaused: jest.fn().mockResolvedValue(false),
        getConfig: jest.fn().mockResolvedValue({
            minReward: 1_000_000n,
            minFunding: 500_000_000n,
            minInterval: 60,
            maxInterval: 31_536_000,
            protocolFeeBps: 100,
            minStorageReserve: 1_000_000_000n,
            minGasReserve: 30_000_000n,
            primaryWindowSeconds: 30,
            slashGasCost: 30_000_000n,
        }),
        // Mirror is empty by default — refresh becomes a no-op so tests
        // exercising .tick() don't need the per-slot getAutomatonAt mock.
        getActiveAutomatonCount: jest.fn().mockResolvedValue(0n),
        getAutomatonAt: jest.fn().mockResolvedValue(null),
    };
}

function stubClient(opens: { registry?: unknown } = {}): FailoverTonClient {
    return {
        open: (contract: { address?: Address }) => {
            if (contract.address?.equals(REGISTRY_ADDR)) return opens.registry;
            // Wallet-side `client.open(walletContract).sender()` paths.
            return { sender: () => ({ send: () => Promise.resolve() }) };
        },
        call: jest.fn(),
    } as unknown as FailoverTonClient;
}

/** Build a ProductContext for the kronos ProductModule. */
function makeProductContext(opts: {
    me?: Address;
    contracts?: ProductContext['contracts'];
    logger?: WorkerLogger;
    worker?: KronosWorker;
    metrics?: ReturnType<typeof createDaemonMetrics>;
} = {}): ProductContext {
    const registry = stubRegistryContract();
    const ctx: ProductContext = {
        client: stubClient({ registry }),
        addresses: { registry: REGISTRY_ADDR },
        contracts: opts.contracts ?? {
            registry: registry as OpenedContract<KronosRegistry>,
        },
        config: defaultConfig('testnet'),
        wallet: fakeWallet(opts.me ?? ME),
        walletPassword: 'pw',
        logger: opts.logger ?? silentLogger(),
    };
    if (opts.metrics !== undefined) ctx.metrics = opts.metrics;
    if (opts.worker !== undefined) ctx.worker = opts.worker;
    return ctx;
}

/** Build a KronosWorker against a stub registry. */
function makeStubWorker(): KronosWorker {
    const registry = stubRegistryContract();
    return new KronosWorker({
        registry: registry as OpenedContract<KronosRegistry>,
        client: stubClient({ registry }),
        wallet: fakeWallet(ME),
        logger: silentLogger(),
        counters: createDaemonMetrics().counters,
    });
}

/** Fan an event through every handler's `on[REGISTRY_SOURCE]` callback. */
async function dispatchToAll(
    handlers: readonly EventHandler[],
    event: KronosEvent,
    ctx: TxContext = fakeTxContext(),
): Promise<void> {
    for (const h of handlers) {
        const cb = h.on?.[REGISTRY_SOURCE];
        if (cb !== undefined) await cb(event, ctx);
    }
}

describe('kronos ProductModule.openContracts', () => {
    it('returns a registry handle when the address is present', () => {
        const registry = stubRegistryContract();
        const handle: ProductHandle = {
            client: stubClient({ registry }),
            addresses: { registry: REGISTRY_ADDR },
            contracts: {},
        };
        const contracts = kronos.openContracts(handle);

        expect(Object.keys(contracts)).toEqual(['registry']);
        expect(contracts.registry).toBe(registry);
    });

    it('returns {} when the address bag is empty (product disabled)', () => {
        const handle: ProductHandle = {
            client: stubClient(),
            addresses: {},
            contracts: {},
        };
        expect(kronos.openContracts(handle)).toEqual({});
    });
});

describe('kronos ProductModule.schemaChecks', () => {
    it('returns a single task with read fn hitting registry.getStorageVersion()', async () => {
        const registry = stubRegistryContract();
        const handle: ProductHandle = {
            client: stubClient(),
            addresses: { registry: REGISTRY_ADDR },
            contracts: { registry: registry as OpenedContract<KronosRegistry> },
        };

        const tasks = kronos.schemaChecks(handle);
        expect(tasks).toHaveLength(1);
        expect(tasks[0]!.contract).toBe('registry');
        expect(tasks[0]!.address.equals(REGISTRY_ADDR)).toBe(true);
        expect(tasks[0]!.sdkVariable).toBe('REGISTRY_STORAGE_VERSION');
        await expect(tasks[0]!.read()).resolves.toBe(1);
        expect((registry as { getStorageVersion: jest.Mock }).getStorageVersion).toHaveBeenCalled();
    });

    it('returns [] when the registry contract is missing (product disabled)', () => {
        const handle: ProductHandle = {
            client: stubClient(),
            addresses: {},
            contracts: {},
        };
        expect(kronos.schemaChecks(handle)).toEqual([]);
    });
});

describe('kronos ProductModule.eventStreams', () => {
    it('returns a single registry EventSource using the SDK decoder', () => {
        const handle: ProductHandle = {
            client: stubClient(),
            addresses: { registry: REGISTRY_ADDR },
            contracts: {},
        };

        const sources = kronos.eventStreams(handle);
        expect(sources).toHaveLength(1);
        expect(sources[0]!.source).toBe(REGISTRY_SOURCE);
        expect(sources[0]!.address.equals(REGISTRY_ADDR)).toBe(true);
        expect(sources[0]!.decode([])).toEqual([]);
    });

    it('returns [] when the registry address is absent', () => {
        const handle: ProductHandle = {
            client: stubClient(),
            addresses: {},
            contracts: {},
        };
        expect(kronos.eventStreams(handle)).toEqual([]);
    });
});

describe('kronos ProductModule.bootstrapWorker', () => {
    it('returns a KronosWorker when the registry contract is present', async () => {
        const worker = await kronos.bootstrapWorker!(
            makeProductContext({ metrics: createDaemonMetrics() }),
        );
        expect(worker).toBeInstanceOf(KronosWorker);
    });

    it('throws when the registry contract was never opened (defense-in-depth)', async () => {
        await expect(
            kronos.bootstrapWorker!(makeProductContext({ contracts: {} })),
        ).rejects.toThrow(/openContracts returned no registry handle/);
    });

    it('falls back to NOOP_COUNTERS when no DaemonMetrics are supplied', async () => {
        const worker = await kronos.bootstrapWorker!(makeProductContext());
        expect(worker).toBeInstanceOf(KronosWorker);
    });
});

describe('KronosWorker — non-tick surface', () => {
    it('hasInFlight is false on a fresh worker', () => {
        expect(makeStubWorker().hasInFlight()).toBe(false);
    });

    it('hasInFlight reflects entries in the inFlight set', () => {
        const worker = makeStubWorker();
        worker.inFlight.add(1n);
        expect(worker.hasInFlight()).toBe(true);
        worker.inFlight.delete(1n);
        expect(worker.hasInFlight()).toBe(false);
    });

    it('eventHandler returns an empty handler — registry events flow through buildHandlers', () => {
        const handler = makeStubWorker().eventHandler();
        expect(handler.on).toBeUndefined();
        expect(handler.onCycleEnd).toBeUndefined();
    });

    it('exposes the AutomatonMirror constructed for it', () => {
        expect(makeStubWorker().mirror).toBeDefined();
    });
});

describe('KronosWorker.tick — wires runWorkerCycle', () => {
    it('returns successfully when there are no jobs (cycle no-op)', async () => {
        await expect(makeStubWorker().tick()).resolves.not.toThrow();
    });

    it('skips the cycle cleanly when registry is paused', async () => {
        // Paused-cycle path needs a registry where getIsPaused returns true.
        const registry = stubRegistryContract();
        (registry as { getIsPaused: jest.Mock }).getIsPaused.mockResolvedValue(true);
        const worker = new KronosWorker({
            registry: registry as OpenedContract<KronosRegistry>,
            client: stubClient({ registry }),
            wallet: fakeWallet(ME),
            logger: silentLogger(),
            counters: createDaemonMetrics().counters,
        });

        await expect(worker.tick()).resolves.not.toThrow();
    });
});

// ----- Handler dispatch (composed handler set, behavior assertions) -----

describe('kronos handler dispatch — AssignedAutomatonMissed awareness', () => {
    it('warns when this automaton was the assigned one', async () => {
        const { log, messages } = captureLogger();
        const handlers = kronos.buildHandlers(makeProductContext({ logger: log }));

        await dispatchToAll(handlers, {
            kind: 'AssignedAutomatonMissed',
            opcode: 0,
            jobId: 7n,
            assigned: ME,
            executor: OTHER,
        });

        expect(messages).toHaveLength(1);
        expect(messages[0]!.level).toBe('warn');
        expect(messages[0]!.msg).toContain('missed an assigned slot');
        expect(messages[0]!.fields?.jobId).toBe('7');
        expect(messages[0]!.fields?.executor).toBe(OTHER.toString());
    });

    it('logs at info when this automaton claimed a fallback slot', async () => {
        const { log, messages } = captureLogger();
        const handlers = kronos.buildHandlers(makeProductContext({ logger: log }));

        await dispatchToAll(handlers, {
            kind: 'AssignedAutomatonMissed',
            opcode: 0,
            jobId: 7n,
            assigned: OTHER,
            executor: ME,
        });

        expect(messages).toHaveLength(1);
        expect(messages[0]!.level).toBe('info');
        expect(messages[0]!.msg).toContain('executed a fallback slot');
        expect(messages[0]!.fields?.missedBy).toBe(OTHER.toString());
    });

    it('silently drops AssignedAutomatonMissed for unrelated parties', async () => {
        const { log, messages } = captureLogger();
        const handlers = kronos.buildHandlers(makeProductContext({ logger: log }));

        await dispatchToAll(handlers, {
            kind: 'AssignedAutomatonMissed',
            opcode: 0,
            jobId: 7n,
            assigned: OTHER,
            executor: fakeAddress(0xcc),
        });

        expect(messages).toEqual([]);
    });
});

describe('kronos handler dispatch — JobExecuted awareness', () => {
    it('debugs JobExecuted when this automaton executed', async () => {
        const { log, messages } = captureLogger();
        const handlers = kronos.buildHandlers(makeProductContext({ logger: log }));

        await dispatchToAll(handlers, {
            kind: 'JobExecuted',
            opcode: 0,
            jobId: 1n,
            automaton: ME,
            executionCount: 5,
            reward: 100n,
            protocolFee: 1n,
            executedAt: 1_700_000_000,
        });

        expect(messages).toHaveLength(1);
        expect(messages[0]!.level).toBe('debug');
        expect(messages[0]!.msg).toContain('JobExecuted observed for self');
        expect(messages[0]!.fields?.executionCount).toBe(5);
    });

    it('silently drops JobExecuted from OTHER', async () => {
        const { log, messages } = captureLogger();
        const handlers = kronos.buildHandlers(makeProductContext({ logger: log }));

        await dispatchToAll(handlers, {
            kind: 'JobExecuted',
            opcode: 0,
            jobId: 1n,
            automaton: OTHER,
            executionCount: 5,
            reward: 100n,
            protocolFee: 1n,
            executedAt: 1_700_000_000,
        });

        expect(messages).toEqual([]);
    });
});

describe('kronos handler dispatch — protocol-health logging', () => {
    it('logs PausedChanged at warn when paused', async () => {
        const { log, messages } = captureLogger();
        const handlers = kronos.buildHandlers(makeProductContext({ logger: log }));
        await dispatchToAll(handlers, { kind: 'PausedChanged', opcode: 0, paused: true });

        expect(messages).toHaveLength(1);
        expect(messages[0]!.level).toBe('warn');
        expect(messages[0]!.msg).toContain('PAUSED');
    });

    it('logs PausedChanged at info on unpause', async () => {
        const { log, messages } = captureLogger();
        const handlers = kronos.buildHandlers(makeProductContext({ logger: log }));
        await dispatchToAll(handlers, { kind: 'PausedChanged', opcode: 0, paused: false });

        expect(messages).toHaveLength(1);
        expect(messages[0]!.level).toBe('info');
        expect(messages[0]!.msg).toContain('resumed');
    });

    it('logs ConfigUpdated at info with select tunables', async () => {
        const { log, messages } = captureLogger();
        const handlers = kronos.buildHandlers(makeProductContext({ logger: log }));

        await dispatchToAll(handlers, {
            kind: 'ConfigUpdated',
            opcode: 0,
            minReward: 100n,
            minFunding: 500_000_000n,
            minInterval: 60,
            maxInterval: 86_400,
            protocolFeeBps: 100,
            minStorageReserve: 1_000_000_000n,
            minGasReserve: 30_000_000n,
            primaryWindowSeconds: 30,
            slashGasCost: 30_000_000n,
        });

        expect(messages).toHaveLength(1);
        expect(messages[0]!.level).toBe('info');
        expect(messages[0]!.msg).toContain('registry config updated');
        expect(messages[0]!.fields?.minReward).toBe('100');
        expect(messages[0]!.fields?.protocolFeeBps).toBe(100);
        expect(messages[0]!.fields?.primaryWindowSeconds).toBe(30);
        expect(messages[0]!.fields?.slashGasCost).toBe('30000000');
    });

    it('logs TreasuryUpdated at info', async () => {
        const { log, messages } = captureLogger();
        const handlers = kronos.buildHandlers(makeProductContext({ logger: log }));
        await dispatchToAll(handlers, { kind: 'TreasuryUpdated', opcode: 0, treasury: OTHER });

        expect(messages).toHaveLength(1);
        expect(messages[0]!.level).toBe('info');
        expect(messages[0]!.msg).toContain('treasury address updated');
        expect(messages[0]!.fields?.treasury).toBe(OTHER.toString());
    });

    it('logs HousekeepingJobSet at info with the pinned jobId', async () => {
        const { log, messages } = captureLogger();
        const handlers = kronos.buildHandlers(makeProductContext({ logger: log }));
        await dispatchToAll(handlers, { kind: 'HousekeepingJobSet', opcode: 0, jobId: 42n });

        expect(messages).toHaveLength(1);
        expect(messages[0]!.level).toBe('info');
        expect(messages[0]!.msg).toContain('housekeeping job pinned');
        expect(messages[0]!.fields?.jobId).toBe('42');
    });

    it('logs ForgetonSet at info', async () => {
        const { log, messages } = captureLogger();
        const handlers = kronos.buildHandlers(makeProductContext({ logger: log }));
        await dispatchToAll(handlers, { kind: 'ForgetonSet', opcode: 0, forgeton: OTHER });

        expect(messages).toHaveLength(1);
        expect(messages[0]!.level).toBe('info');
        expect(messages[0]!.msg).toContain('forgeton pool address pinned');
        expect(messages[0]!.fields?.forgeton).toBe(OTHER.toString());
    });

    it.each([
        {
            event: { kind: 'UpgradeProposed', opcode: 0, codeHash: 0xdeadbeefn, eta: 9_999_999 } satisfies KronosEvent,
            level: 'warn',
            substring: 'code upgrade proposed',
        },
        {
            event: { kind: 'UpgradeCancelled', opcode: 0, codeHash: 0xdeadbeefn } satisfies KronosEvent,
            level: 'info',
            substring: 'upgrade cancelled',
        },
        {
            event: {
                kind: 'CodeUpdated',
                opcode: 0,
                codeHash: 0xdeadbeefn,
                oldCodeHash: 0xcafef00dn,
                timestamp: 1_700_000_000,
            } satisfies KronosEvent,
            level: 'warn',
            substring: 'code was upgraded',
        },
    ])('logs $event.kind at $level', async ({ event, level, substring }) => {
        const { log, messages } = captureLogger();
        const handlers = kronos.buildHandlers(makeProductContext({ logger: log }));
        await dispatchToAll(handlers, event);

        expect(messages).toHaveLength(1);
        expect(messages[0]!.level).toBe(level);
        expect(messages[0]!.msg).toContain(substring);
    });

    it('logs SlashRetried at info', async () => {
        const { log, messages } = captureLogger();
        const handlers = kronos.buildHandlers(makeProductContext({ logger: log }));
        await dispatchToAll(handlers, {
            kind: 'SlashRetried',
            opcode: 0,
            automaton: OTHER,
            jobId: 13n,
        });

        expect(messages).toHaveLength(1);
        expect(messages[0]!.level).toBe('info');
        expect(messages[0]!.msg).toContain('SlashRetried');
        expect(messages[0]!.fields?.automaton).toBe(OTHER.toString());
        expect(messages[0]!.fields?.jobId).toBe('13');
    });

    it('silently drops events outside any handler\'s scope (e.g. JobRegistered)', async () => {
        const { log, messages } = captureLogger();
        const handlers = kronos.buildHandlers(makeProductContext({ logger: log }));

        await dispatchToAll(handlers, {
            kind: 'JobRegistered',
            opcode: 0,
            jobId: 1n,
            owner: OTHER,
            target: OTHER,
            reward: 1n,
            interval: 60,
            expireAfter: 0,
        });

        expect(messages).toEqual([]);
    });
});

describe('kronos buildHandlers — composition', () => {
    it('returns 2 handlers (awareness + health) without a worker', () => {
        expect(kronos.buildHandlers(makeProductContext())).toHaveLength(2);
    });

    it('returns 3 handlers (awareness + health + mirror-patch) with a worker', () => {
        const worker = makeStubWorker();
        expect(kronos.buildHandlers(makeProductContext({ worker }))).toHaveLength(3);
    });
});
