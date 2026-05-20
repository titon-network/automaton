// Cross-protocol integration — exercises the daemon's product-pluggability
// surface end-to-end with BOTH Kronos and Fortuna workers wired up.
//
// What the existing tests cover:
//   - Integration.spec.ts: Kronos + ForgeTON on a real sandbox.
//   - fortuna-worker.spec.ts: FortunaWorker pending-queue branches in isolation.
//   - products-fortuna-wiring.spec.ts / products-kronos-wiring.spec.ts:
//     ProductModule shape (openContracts/schemaChecks/eventStreams/buildHandlers).
//
// What this file ADDS:
//   - tickOnce composes BOTH product workers in one cycle (no contention,
//     both .tick() invoked, both .publishMetrics).
//   - Cross-product handler composition: ForgeTON awareness/health +
//     Kronos awareness + Fortuna awareness/health + selfSlash all dispatch
//     correctly.
//   - selfSlashHandler still fires when the automaton is slashed under a
//     daemon that ALSO has Fortuna enabled — verifies the Fortuna worker's
//     presence doesn't break baseline ForgeTON wiring.
//
// Note on Fortuna events: the sandbox harness deploys Kronos + ForgeTON
// only (no Atlas/Fortuna contracts), so real Fortuna external-out events
// don't flow through drainEvents. Fortuna handler dispatch is exercised
// by direct invocation with synthesized FortunaEvent objects — the wire
// format roundtrip is already covered by products-fortuna-wiring.spec.ts
// and the SDK's own decoder tests.

import { type Address, type Cell, type OpenedContract } from '@ton/core';
import type { SandboxContract, TreasuryContract } from '@ton/sandbox';
import {
    Fortuna,
    randomBlsSecret,
    type FortunaEvent,
} from '@titon-network/fortuna-sdk';

import { createSandboxHarness, type SandboxHarness } from './helpers/chain';
import { tickOnce } from '../src/daemon/orchestrator';
import { createDaemonMetrics } from '../src/daemon/metrics';
import {
    baselineEventSources,
    consumerWatchHandler,
    emptyCheckpointState,
    forgetonAwarenessHandler,
    forgetonHealthHandler,
    selfSlashHandler,
    SILENT_LOGGER,
    type EventHandler,
    type EventSource,
    type CheckpointState,
} from '../src/worker';
import { FortunaWorker } from '../src/worker/fortuna';
import { KronosWorker, REGISTRY_SOURCE, kronos } from '../src/products/kronos';
import { fortuna, FORTUNA_SOURCE } from '../src/products/fortuna';
import { defaultConfig } from '../src/config/schema';
import type { ProductContext } from '../src/products/types';
import type { TxContext } from '../src/worker/events';
import { captureLogger } from './helpers/logger';
import { fakeAddress } from './helpers/fixtures';

// Stub Fortuna address — distinct from any real on-chain contract so the
// harness's deployed addresses don't collide.
const FORTUNA_FAKE_ADDR = fakeAddress(0xfa);

/** Stub Fortuna contract with the methods FortunaWorker calls during tick. */
function stubFortunaContract(): unknown {
    return {
        address: FORTUNA_FAKE_ADDR,
        getSchemaVersions: jest.fn().mockResolvedValue({ storage: 1 }),
        getRequest: jest.fn().mockResolvedValue(null),
        getConfig: jest.fn().mockResolvedValue({
            baseRequestFee: 10_000_000n,
            submitterReward: 50_000_000n,
            requestTtl: 3600,
            minForwardReserve: 30_000_000n,
            minStorageReserve: 0n,
            pendingFeeLocked: 0n,
            feeAccumulated: 0n,
        }),
        sendFulfillRandomness: jest.fn().mockResolvedValue(undefined),
    };
}

/** Build a Kronos worker wired to the sandbox harness. */
function makeKronosWorker(
    harness: SandboxHarness,
    me: SandboxContract<TreasuryContract>,
    metrics = createDaemonMetrics(),
): KronosWorker {
    return new KronosWorker({
        registry: harness.runtime.products.kronos!.registry as never,
        client: harness.runtime.client,
        wallet: harness.fakeWalletFor(me),
        logger: SILENT_LOGGER,
        counters: metrics.counters,
        submitExecute: harness.submitExecuteVia(me),
        nowSec: () => harness.nowSec(),
    });
}

/**
 * Build a Fortuna worker against a stub contract. The sandbox harness's
 * client doesn't know about FORTUNA_FAKE_ADDR, so we wrap `.open()` to
 * route that address to the stub while leaving everything else
 * (registry, pool, wallet contract) unchanged.
 */
function makeFortunaWorker(
    harness: SandboxHarness,
    me: SandboxContract<TreasuryContract>,
): { worker: FortunaWorker; fortunaContract: ReturnType<typeof stubFortunaContract> } {
    const fortunaContract = stubFortunaContract();
    const wrappedClient = new Proxy(harness.runtime.client, {
        get(target, prop, receiver) {
            if (prop === 'open') {
                return (contract: { address?: Address }) => {
                    if (contract.address?.equals(FORTUNA_FAKE_ADDR)) return fortunaContract;
                    // Wallet-side open — return a no-op sender stub.
                    return { sender: () => ({ send: () => Promise.resolve() }) };
                };
            }
            return Reflect.get(target, prop, receiver);
        },
    });

    const worker = new FortunaWorker({
        fortuna: fortunaContract as OpenedContract<Fortuna>,
        client: wrappedClient,
        wallet: harness.fakeWalletFor(me),
        blsSecret: Buffer.from(randomBlsSecret()),
        logger: SILENT_LOGGER,
    });
    return { worker, fortunaContract };
}

/** Synthesize the kronos product's registry source for a sandbox harness. */
function kronosRegistrySource(harness: SandboxHarness): EventSource {
    const { decodeEvent } = require('@titon-network/kronos-sdk') as typeof import('@titon-network/kronos-sdk');
    return {
        source: REGISTRY_SOURCE,
        address: harness.runtime.deployment.products.kronos!.registry!,
        decode: (bodies: Cell[]) => {
            const events: import('@titon-network/kronos-sdk').KronosEvent[] = [];
            for (const body of bodies) {
                const e = decodeEvent(body);
                if (e !== null) events.push(e);
            }
            return events;
        },
    };
}

/** Standard sources list for a multi-product tick — baseline pool +
 *  kronos registry. (Fortuna's source isn't included — see file-header
 *  note.) */
function multiProductSources(harness: SandboxHarness): EventSource[] {
    return [...baselineEventSources(harness.runtime), kronosRegistrySource(harness)];
}

async function runMultiProductTick(
    harness: SandboxHarness,
    me: SandboxContract<TreasuryContract>,
    handlers: EventHandler[],
    state: CheckpointState,
): Promise<CheckpointState> {
    const { worker: fortunaWorker } = makeFortunaWorker(harness, me);
    return tickOnce({
        runtime: harness.runtime,
        wallet: harness.fakeWalletFor(me),
        handlers,
        sources: multiProductSources(harness),
        logger: SILENT_LOGGER,
        checkpointState: state,
        productWorkers: {
            kronos: makeKronosWorker(harness, me),
            fortuna: fortunaWorker,
        },
    });
}

describe('multi-product integration: tickOnce composes Kronos + Fortuna', () => {
    jest.setTimeout(60_000);

    it('runs both workers and bumps both products\' metric channels in one tick', async () => {
        const harness = await createSandboxHarness();
        const jobOwner = await harness.blockchain.treasury('jobOwner');
        const target = await harness.blockchain.treasury('target');
        const me = await harness.registerAutomaton('me');
        await harness.registerJob({ jobOwner, target: target.address });

        const metrics = createDaemonMetrics();
        const kronosWorker = makeKronosWorker(harness, me, metrics);
        const { worker: fortunaWorker } = makeFortunaWorker(harness, me);

        await tickOnce({
            runtime: harness.runtime,
            wallet: harness.fakeWalletFor(me),
            handlers: [],
            sources: multiProductSources(harness),
            metrics,
            logger: SILENT_LOGGER,
            checkpointState: emptyCheckpointState(),
            productWorkers: { kronos: kronosWorker, fortuna: fortunaWorker },
        });

        // Kronos executed the registered job; Fortuna's pending queue is
        // empty so its tick was a no-op.
        expect((await harness.registry.getJob(0n))!.executionCount).toBe(1);
        const out = await metrics.registry.metrics();
        expect(out).toMatch(/automaton_execute_success_total\{reason="never-executed"\} 1/);
        // Fortuna pending-requests gauge is published from publishMetrics.
        expect(out).toMatch(/automaton_fortuna_pending_requests 0/);
    });

    it('FortunaWorker.eventHandler enqueues a synthetic RequestCreated', async () => {
        const harness = await createSandboxHarness();
        const me = await harness.blockchain.treasury('me');
        const consumer = await harness.blockchain.treasury('consumer');

        const { worker: fortunaWorker, fortunaContract } = makeFortunaWorker(harness, me);

        const event: FortunaEvent = {
            kind: 'RequestCreated',
            opcode: 0,
            reqKey: 0xfeedbeefn,
            consumer: consumer.address,
            queryId: 1n,
            seed: 0xdeadbeefn,
            deadline: harness.nowSec() + 3600,
            groupEpoch: 1,
            creationLt: 1n,
        };
        const ctx: TxContext = { txHash: 'tx', lt: 1n, now: harness.nowSec() };
        await fortunaWorker.eventHandler().on![FORTUNA_SOURCE]!(event, ctx);

        expect(fortunaWorker.pendingCount()).toBe(1);

        // tickOnce still composes both workers cleanly with the
        // pre-populated queue (Fortuna's tick re-checks each pending
        // request against on-chain state).
        await tickOnce({
            runtime: harness.runtime,
            wallet: harness.fakeWalletFor(me),
            handlers: [],
            sources: multiProductSources(harness),
            logger: SILENT_LOGGER,
            checkpointState: emptyCheckpointState(),
            productWorkers: {
                fortuna: fortunaWorker,
                kronos: makeKronosWorker(harness, me),
            },
        });

        expect((fortunaContract as { getRequest: jest.Mock }).getRequest).toHaveBeenCalled();
    });

    it('selfSlashHandler still fires under a Kronos+Fortuna daemon when the operator is slashed', async () => {
        const harness = await createSandboxHarness();
        const jobOwner = await harness.blockchain.treasury('jobOwner');
        const target = await harness.blockchain.treasury('target');
        const me = await harness.registerAutomaton('me');
        const other = await harness.registerAutomaton('other');

        await harness.registerJob({
            jobOwner,
            target: target.address,
            interval: 300,
            windowBefore: 10,
            windowAfter: 600,
        });

        // Tick 1: first execution → rotation activates.
        const cp1 = await runMultiProductTick(harness, me, [], emptyCheckpointState());
        const assigned = await harness.registry.getAssignedAutomaton(0n, 1);
        const assignedToMe = assigned!.equals(me.address);
        const claimer = assignedToMe ? other : me;
        const willBeSlashed = assignedToMe ? me : other;

        // Advance past primary window so claimer can fallback-claim and slash.
        harness.advanceSeconds(300 + 60);
        const cp2 = await runMultiProductTick(harness, claimer, [], cp1);

        // Now drive a tick AS the slashed party with all baseline ForgeTON
        // handlers wired (including selfSlashHandler), AND multi-product
        // workers active. Asserts that the Fortuna worker's presence
        // doesn't disrupt selfSlash dispatch.
        const webhookCalls: Array<{ url: string; payload: unknown }> = [];
        const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
            webhookCalls.push({ url, payload: JSON.parse(init.body as string) });
            return new Response('ok', { status: 200 });
        };
        const handlers: EventHandler[] = [
            selfSlashHandler({
                me: willBeSlashed.address,
                logger: SILENT_LOGGER,
                webhookUrl: 'https://example.invalid/hook',
                fetch: fakeFetch as unknown as typeof fetch,
            }),
            consumerWatchHandler(SILENT_LOGGER),
            forgetonAwarenessHandler(willBeSlashed.address, SILENT_LOGGER),
            forgetonHealthHandler(SILENT_LOGGER),
        ];

        await runMultiProductTick(harness, willBeSlashed, handlers, cp2);

        // Detached webhook POST — yield to let .then run.
        await new Promise((r) => setImmediate(r));

        expect(webhookCalls).toHaveLength(1);
        const payload = webhookCalls[0]!.payload as { kind: string; automaton: string };
        expect(payload.kind).toBe('self-slash');
        expect(payload.automaton).toBe(willBeSlashed.address.toString());
    });
});

describe('multi-product integration: cross-product handler composition', () => {
    jest.setTimeout(60_000);

    it('composes ForgeTON + Kronos + Fortuna handlers in a single tick without crashing', async () => {
        const harness = await createSandboxHarness();
        const me = await harness.registerAutomaton('me');

        const kronosCapture = captureLogger();
        const forgetonCapture = captureLogger();
        const fortunaCapture = captureLogger();

        const { worker: fortunaWorker } = makeFortunaWorker(harness, me);
        const kronosWorker = makeKronosWorker(harness, me);

        // Build per-product handlers via the ProductModule.buildHandlers
        // surface so we exercise the production composition path.
        const kronosCtx: ProductContext = {
            client: harness.runtime.client,
            addresses: { registry: harness.runtime.products.kronos!.registry!.address },
            contracts: { registry: harness.runtime.products.kronos!.registry as never },
            config: defaultConfig('testnet'),
            wallet: harness.fakeWalletFor(me),
            walletPassword: 'pw',
            logger: kronosCapture.log,
            worker: kronosWorker,
        };
        const fortunaCtx: ProductContext = {
            client: harness.runtime.client,
            addresses: { fortuna: FORTUNA_FAKE_ADDR },
            contracts: { fortuna: stubFortunaContract() as OpenedContract<Fortuna> },
            config: defaultConfig('testnet'),
            wallet: harness.fakeWalletFor(me),
            walletPassword: 'pw',
            logger: fortunaCapture.log,
            worker: fortunaWorker,
        };
        const handlers: EventHandler[] = [
            // ForgeTON baseline (4 handlers).
            consumerWatchHandler(forgetonCapture.log),
            forgetonAwarenessHandler(me.address, forgetonCapture.log),
            forgetonHealthHandler(forgetonCapture.log),
            selfSlashHandler({ me: me.address, logger: forgetonCapture.log }),
            // Per-product handlers from each ProductModule.
            ...kronos.buildHandlers(kronosCtx),
            ...fortuna.buildHandlers(fortunaCtx),
        ];

        await tickOnce({
            runtime: harness.runtime,
            wallet: harness.fakeWalletFor(me),
            handlers,
            sources: multiProductSources(harness),
            logger: SILENT_LOGGER,
            checkpointState: emptyCheckpointState(),
            productWorkers: { kronos: kronosWorker, fortuna: fortunaWorker },
        });

        // Real on-chain ForgeTON event: AutomatonRegistered for self
        // (emitted by the harness's registerAutomaton).
        expect(
            forgetonCapture.messages.find((m) => m.msg.includes('AutomatonRegistered for self')),
        ).toBeDefined();

        // Real on-chain ForgeTON event: ConsumerUpdated (emitted by
        // bootstrap pool.sendSetConsumer).
        expect(
            forgetonCapture.messages.find((m) => m.msg.includes('consumer set changed')),
        ).toBeDefined();

        // Real on-chain Kronos event: AutomatonMirrorUpdated triggers
        // the mirror-patch handler's onCycleEnd → mirror.refresh().
        expect(kronosWorker.mirror.activeCount).toBe(1n);

        // Synthesized Fortuna event flows through the composed fortuna
        // handler set — the awareness handler routes self-targeted
        // events to fortunaCapture.
        const ctx: TxContext = { txHash: 'h', lt: 1n, now: harness.nowSec() };
        for (const h of handlers) {
            const cb = h.on?.[FORTUNA_SOURCE];
            if (cb !== undefined) {
                await cb(
                    {
                        kind: 'OperatorMirrored',
                        opcode: 0,
                        automaton: me.address,
                        isActive: true,
                        cause: 1,
                    },
                    ctx,
                );
            }
        }
        expect(
            fortunaCapture.messages.find((m) => m.msg.includes('operator mirror updated for self')),
        ).toBeDefined();
    });
});

describe('multi-product integration: ProductWorker contract', () => {
    jest.setTimeout(30_000);

    it('hasInFlight returns false on a fresh kronos worker AND a fresh fortuna worker', async () => {
        const harness = await createSandboxHarness();
        const me = await harness.blockchain.treasury('me');

        expect(makeKronosWorker(harness, me).hasInFlight()).toBe(false);
        expect(makeFortunaWorker(harness, me).worker.hasInFlight()).toBe(false);
    });

    it('publishMetrics on FortunaWorker registers a fortuna_pending_requests gauge', async () => {
        const harness = await createSandboxHarness();
        const me = await harness.blockchain.treasury('me');
        const { worker: fortunaWorker } = makeFortunaWorker(harness, me);

        const metrics = createDaemonMetrics();
        // KronosWorker doesn't define publishMetrics today (the gauge
        // reads happen in snapshotGauges). FortunaWorker does — pendingRequests.
        fortunaWorker.publishMetrics?.(metrics);

        const out = await metrics.registry.metrics();
        expect(out).toMatch(/automaton_fortuna_pending_requests 0/);
    });
});
