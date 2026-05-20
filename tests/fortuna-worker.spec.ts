// FortunaWorker unit tests — event-handler queue + tick()/submitOne() branches.
//
// Scope: state-machine behavior of the pending-request queue PLUS the
// decision branches inside submitOne (live freshness, stale epoch,
// deadline expired, in-flight dedup). The real on-chain send+confirm
// path is covered by submit.spec.ts; here we stub the fortuna contract's
// getRequest / getConfig / sendFulfillRandomness to exercise each branch.
// Atlas+Fortuna sandbox integration is deferred to E.2.

import { Address } from '@ton/core';
import type { FortunaEvent } from '@titon-network/fortuna-sdk';
import { FortunaWorker } from '../src/worker/fortuna';
import type { AutomatonWallet } from '../src/wallet';
import type { WorkerLogger } from '../src/worker';

function silentLogger(): WorkerLogger {
    return {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
    };
}

function fakeAddress(byte: number): Address {
    const buf = Buffer.alloc(32, byte);
    return new Address(0, buf);
}

interface FortunaStub {
    getRequest: jest.Mock<Promise<{ groupEpoch: number } | null>, [Address, bigint]>;
    getConfig: jest.Mock<
        Promise<{
            submitterReward: bigint;
            minForwardReserve: bigint;
            [k: string]: unknown;
        }>
    >;
    sendFulfillRandomness: jest.Mock<Promise<void>>;
    address: Address;
}

function makeFortunaStub(overrides: Partial<FortunaStub> = {}): FortunaStub {
    return {
        address: fakeAddress(0xFF),
        getRequest: jest.fn().mockResolvedValue({ groupEpoch: 1 }),
        getConfig: jest.fn().mockResolvedValue({
            submitterReward: 50_000_000n,
            minForwardReserve: 30_000_000n,
            baseRequestFee: 10_000_000n,
            requestTtl: 3600,
            minStorageReserve: 0n,
            pendingFeeLocked: 0n,
            feeAccumulated: 0n,
        }),
        sendFulfillRandomness: jest.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

// Stub deps for FortunaWorker — the worker takes the opened Fortuna
// contract + failover client directly (post-product-module refactor).
// senderFor() calls client.open(walletContract).sender(); we stub both
// so construction succeeds. Tests that exercise .tick() pass a configured
// FortunaStub so submitOne's branches are verifiable without a real chain.
function makeWorkerDeps(
    fortunaStub?: FortunaStub,
): { client: unknown; fortuna: unknown } {
    const stubSender = { send: () => Promise.resolve() };
    const stubOpened = { sender: () => stubSender };
    const client = { open: () => stubOpened };
    const fortuna = fortunaStub ?? makeFortunaStub();
    return { client, fortuna };
}

function makeStubWallet(): AutomatonWallet {
    return {
        mnemonic: [],
        keyPair: { publicKey: Buffer.alloc(32), secretKey: Buffer.alloc(64) } as unknown as AutomatonWallet['keyPair'],
        walletContract: {} as AutomatonWallet['walletContract'],
        address: fakeAddress(0xAA),
        network: 'testnet',
    };
}

function requestCreated(reqKey: bigint, consumer = fakeAddress(0xC0)): FortunaEvent {
    return {
        kind: 'RequestCreated',
        opcode: 0x60,
        reqKey,
        consumer,
        queryId: reqKey,
        seed: 0xDEADBEEFn,
        deadline: 10_000,
        groupEpoch: 1,
        creationLt: 1_000_000n,
    };
}

function requestFulfilled(reqKey: bigint, submitter = fakeAddress(0xAA)): FortunaEvent {
    return {
        kind: 'RequestFulfilled',
        opcode: 0x61,
        reqKey,
        submitter,
        beta: 0x12345678n,
    };
}

function requestReclaimed(reqKey: bigint): FortunaEvent {
    return {
        kind: 'RequestReclaimed',
        opcode: 0x62,
        reqKey,
        consumer: fakeAddress(0xC0),
        reason: 1,
    };
}

describe('FortunaWorker.eventHandler', () => {
    let worker: FortunaWorker;

    beforeEach(() => {
        const deps = makeWorkerDeps();
        worker = new FortunaWorker({
            client: deps.client as never,
            fortuna: deps.fortuna as never,
            wallet: makeStubWallet(),
            blsSecret: Buffer.alloc(32, 0x42),
            logger: silentLogger(),
        });
    });

    it('starts empty', () => {
        expect(worker.pendingCount()).toBe(0);
    });

    it('enqueues on RequestCreated', () => {
        const handler = worker.eventHandler();
        handler.on?.fortuna?.(requestCreated(1n), { txHash: 'h1', lt: 1n, now: 0 });
        expect(worker.pendingCount()).toBe(1);
    });

    it('enqueues multiple distinct reqKeys', () => {
        const handler = worker.eventHandler();
        handler.on?.fortuna?.(requestCreated(1n), { txHash: 'h1', lt: 1n, now: 0 });
        handler.on?.fortuna?.(requestCreated(2n), { txHash: 'h2', lt: 2n, now: 0 });
        handler.on?.fortuna?.(requestCreated(3n), { txHash: 'h3', lt: 3n, now: 0 });
        expect(worker.pendingCount()).toBe(3);
    });

    it('dedupes re-delivery of the same reqKey', () => {
        const handler = worker.eventHandler();
        handler.on?.fortuna?.(requestCreated(7n), { txHash: 'h1', lt: 1n, now: 0 });
        handler.on?.fortuna?.(requestCreated(7n), { txHash: 'h1-replay', lt: 1n, now: 0 });
        expect(worker.pendingCount()).toBe(1);
    });

    it('dequeues on RequestFulfilled', () => {
        const handler = worker.eventHandler();
        handler.on?.fortuna?.(requestCreated(1n), { txHash: 'h1', lt: 1n, now: 0 });
        handler.on?.fortuna?.(requestCreated(2n), { txHash: 'h2', lt: 2n, now: 0 });
        handler.on?.fortuna?.(requestFulfilled(1n), { txHash: 'h3', lt: 3n, now: 0 });
        expect(worker.pendingCount()).toBe(1);
    });

    it('dequeues on RequestReclaimed', () => {
        const handler = worker.eventHandler();
        handler.on?.fortuna?.(requestCreated(1n), { txHash: 'h1', lt: 1n, now: 0 });
        handler.on?.fortuna?.(requestReclaimed(1n), { txHash: 'h2', lt: 2n, now: 0 });
        expect(worker.pendingCount()).toBe(0);
    });

    it('ignores Fulfilled/Reclaimed for unknown reqKeys (no throw)', () => {
        const handler = worker.eventHandler();
        expect(() =>
            handler.on?.fortuna?.(requestFulfilled(999n), { txHash: 'h1', lt: 1n, now: 0 }),
        ).not.toThrow();
        expect(worker.pendingCount()).toBe(0);
    });

    it('ignores unrelated event kinds (Paused/Unpaused/ConfigUpdated)', () => {
        const handler = worker.eventHandler();
        handler.on?.fortuna?.(
            { kind: 'Paused', pausedBy: fakeAddress(0x0A) } as FortunaEvent,
            { txHash: 'h', lt: 1n, now: 0 },
        );
        handler.on?.fortuna?.(
            { kind: 'Unpaused', unpausedBy: fakeAddress(0x0A) } as FortunaEvent,
            { txHash: 'h', lt: 2n, now: 0 },
        );
        expect(worker.pendingCount()).toBe(0);
    });
});

describe('FortunaWorker.tick() decision branches', () => {
    // These tests exercise submitOne's decision tree without crossing the
    // sendAndConfirm boundary (which needs a real wallet + RPC). The
    // branches that DO cross sendAndConfirm are left to future integration
    // tests — here we verify the short-circuit paths (skip reasons) and
    // the in-flight guard.

    function makeWorker(
        fortunaStub: FortunaStub,
        nowSec = () => 100,
    ): { worker: FortunaWorker; stub: FortunaStub } {
        const deps = makeWorkerDeps(fortunaStub);
        const worker = new FortunaWorker({
            client: deps.client as never,
            fortuna: deps.fortuna as never,
            wallet: makeStubWallet(),
            blsSecret: Buffer.alloc(32, 0x42),
            logger: silentLogger(),
            nowSec,
        });
        return { worker, stub: fortunaStub };
    }

    it('skips a request past its deadline', async () => {
        const stub = makeFortunaStub();
        const { worker } = makeWorker(stub, () => 10_001); // after deadline=10_000
        worker
            .eventHandler()
            .on?.fortuna?.(requestCreated(1n), { txHash: 'h', lt: 1n, now: 0 });

        const result = await worker.tick();

        expect(result.skipped).toBe(1);
        expect(result.attempts).toBe(0);
        expect(stub.getRequest).not.toHaveBeenCalled();
        expect(worker.pendingCount()).toBe(0); // dropped from queue
    });

    it('skips when Fortuna reports the request is gone (race-lost) and DROPS from queue', async () => {
        const stub = makeFortunaStub({
            getRequest: jest.fn().mockResolvedValue(null),
        });
        const { worker } = makeWorker(stub);
        worker
            .eventHandler()
            .on?.fortuna?.(requestCreated(1n), { txHash: 'h', lt: 1n, now: 0 });

        const result = await worker.tick();

        expect(stub.getRequest).toHaveBeenCalledTimes(1);
        expect(stub.sendFulfillRandomness).not.toHaveBeenCalled();
        expect(result.failures).toBe(1); // submitOne returned false → failure bucket
        // H4 fix: race-lost is per-request permanent — never going to succeed
        // for this reqKey. We drop instead of retrying every tick.
        expect(worker.pendingCount()).toBe(0);
    });

    it('skips when the groupEpoch is stale (Atlas rotated) and DROPS from queue', async () => {
        const stub = makeFortunaStub({
            getRequest: jest.fn().mockResolvedValue({ groupEpoch: 99 }),
        });
        const { worker } = makeWorker(stub);
        worker
            .eventHandler()
            .on?.fortuna?.(requestCreated(1n), { txHash: 'h', lt: 1n, now: 0 });

        const result = await worker.tick();

        expect(stub.getRequest).toHaveBeenCalledTimes(1);
        expect(stub.sendFulfillRandomness).not.toHaveBeenCalled();
        expect(result.failures).toBe(1);
        // H4 fix: stale epoch is per-request permanent — our signature
        // would never verify against the new groupPk. Drop, don't retry.
        expect(worker.pendingCount()).toBe(0);
    });

    it('caches Fortuna getConfig across ticks (does not re-fetch within TTL)', async () => {
        const stub = makeFortunaStub({
            // Force submitOne to short-circuit before reaching getConfig:
            // stale epoch exits before the config read. So to test the
            // cache we need a path that REACHES getConfig. Use a throwing
            // sendFulfillRandomness so we proceed past getConfig but
            // fail cleanly at the chain boundary.
            getRequest: jest.fn().mockResolvedValue({ groupEpoch: 1 }),
            sendFulfillRandomness: jest.fn().mockRejectedValue(new Error('sandbox-boundary')),
        });
        const { worker } = makeWorker(stub);
        const handler = worker.eventHandler();

        handler.on?.fortuna?.(requestCreated(1n), { txHash: 'h1', lt: 1n, now: 0 });
        handler.on?.fortuna?.(requestCreated(2n), { txHash: 'h2', lt: 2n, now: 0 });

        // Two failures — submitOne will throw at sendAndConfirm because
        // our sendFulfillRandomness mock rejects. But getConfig was read
        // once and cached.
        await worker.tick();

        // getConfig should be called at most once (cached across the two
        // requests in this tick).
        expect(stub.getConfig.mock.calls.length).toBeLessThanOrEqual(1);
    });

    it('config cache TTL is driven by injected nowSec, not Date.now (H3 fix)', async () => {
        // The H3 fix in `getConfigCached` swaps Date.now() for nowSec()*1000
        // so sandbox tests can advance simulated time and trigger cache
        // expiry deterministically. Before the fix, the TTL was tied to
        // wall-clock and untestable.
        const stub = makeFortunaStub({
            getRequest: jest.fn().mockResolvedValue({ groupEpoch: 1 }),
            sendFulfillRandomness: jest.fn().mockRejectedValue(new Error('sandbox-boundary')),
        });

        let nowSecValue = 1_000; // start at t=1000s
        const { worker } = makeWorker(stub, () => nowSecValue);
        const handler = worker.eventHandler();

        // Tick 1 at t=1000 → reads config (cold cache).
        handler.on?.fortuna?.(requestCreated(1n), { txHash: 'h1', lt: 1n, now: 0 });
        await worker.tick();
        const callsAfterTick1 = stub.getConfig.mock.calls.length;
        expect(callsAfterTick1).toBe(1);

        // Tick 2 at t=1100 (within TTL = 5min = 300s) → cache hit.
        nowSecValue = 1_100;
        handler.on?.fortuna?.(requestCreated(2n), { txHash: 'h2', lt: 2n, now: 0 });
        await worker.tick();
        expect(stub.getConfig.mock.calls.length).toBe(callsAfterTick1);

        // Tick 3 at t=1500 (TTL elapsed, was 1000 → now 1500 → 500s > 300s)
        // → cache miss, refetch.
        nowSecValue = 1_500;
        handler.on?.fortuna?.(requestCreated(3n), { txHash: 'h3', lt: 3n, now: 0 });
        await worker.tick();
        expect(stub.getConfig.mock.calls.length).toBe(callsAfterTick1 + 1);
    });
});

describe('FortunaWorker constructor validation', () => {
    const wallet = makeStubWallet();
    const logger = silentLogger();

    it('throws when blsSecret is not 32 bytes', () => {
        const deps = makeWorkerDeps();
        expect(
            () =>
                new FortunaWorker({
                    client: deps.client as never,
                    fortuna: deps.fortuna as never,
                    wallet,
                    blsSecret: Buffer.alloc(16),
                    logger,
                }),
        ).toThrow(/32 bytes/);
    });
});

// Happy-path + verify-fail branches for submitOne, with sendAndConfirm
// mocked at the module boundary. This pins the orchestration INSIDE
// submitOne (compute alpha → read config → build value → send → verify)
// without crossing the real wallet + seqno poll.
describe('FortunaWorker.tick() submission path (mocked sendAndConfirm)', () => {
    let sendAndConfirmMock: jest.Mock;

    beforeAll(() => {
        jest.resetModules();
        jest.doMock('../src/chain', () => {
            const actual = jest.requireActual('../src/chain');
            return {
                ...actual,
                sendAndConfirm: (...args: unknown[]) => sendAndConfirmMock(...args),
                senderFor: () => ({ send: () => Promise.resolve() }),
            };
        });
    });

    afterAll(() => {
        jest.dontMock('../src/chain');
    });

    function loadWorkerWithMock(
        fortunaStub: FortunaStub,
    ): {
        worker: InstanceType<typeof import('../src/worker/fortuna').FortunaWorker>;
        stub: FortunaStub;
    } {
        // Require inside the describe so the mocked module is picked up.
        const { FortunaWorker: LocalFW } =
            require('../src/worker/fortuna') as typeof import('../src/worker/fortuna');
        const deps = makeWorkerDeps(fortunaStub);
        const worker = new LocalFW({
            client: deps.client as never,
            fortuna: deps.fortuna as never,
            wallet: makeStubWallet(),
            blsSecret: Buffer.alloc(32, 0x42),
            logger: silentLogger(),
            nowSec: () => 100,
        });
        return { worker, stub: fortunaStub };
    }

    beforeEach(() => {
        sendAndConfirmMock = jest.fn();
    });

    it('happy path: signs, sends, verifies, dequeues', async () => {
        // Default getRequest stub returns groupEpoch=1 (matches request).
        // sendAndConfirm resolves with a canned result and the verify
        // callback is invoked — mock getRequest to return null on the
        // verify re-read (request was deleted on-chain per contract).
        let verifyRead = false;
        const stub = makeFortunaStub({
            getRequest: jest.fn().mockImplementation(async () => {
                if (verifyRead) return null; // second call = post-send
                verifyRead = true;
                return { groupEpoch: 1 };
            }),
        });
        sendAndConfirmMock.mockImplementation(async (_client, _wallet, send, opts) => {
            await send();
            if (opts?.verify) await opts.verify();
            return {
                txHash: 'abc',
                lt: '100',
                seqnoBefore: 1,
                seqnoAfter: 2,
                explorerUrl: 'https://explorer/tx',
                walletExplorerUrl: 'https://explorer/wallet',
            };
        });

        const { worker, stub: s } = loadWorkerWithMock(stub);
        worker
            .eventHandler()
            .on?.fortuna?.(requestCreated(1n), { txHash: 'h', lt: 1n, now: 0 });

        const result = await worker.tick();

        expect(result.attempts).toBe(1);
        expect(result.successes).toBe(1);
        expect(result.failures).toBe(0);
        expect(s.sendFulfillRandomness).toHaveBeenCalledTimes(1);
        expect(worker.pendingCount()).toBe(0); // dequeued post-success

        // Value passed to sendFulfillRandomness = submitterReward +
        // minForwardReserve + FULFILL_FWD_BUFFER (50M + 30M + 20M). When
        // called through a stub (not a real OpenedContract), the
        // ContractProvider isn't injected, so opts is at index 1.
        const args = s.sendFulfillRandomness.mock.calls[0]! as unknown as [unknown, { value: bigint }];
        expect(args[1]!.value).toBe(100_000_000n);
    });

    it('verify-fail: sendAndConfirm throws via verify; request stays in queue', async () => {
        const stub = makeFortunaStub({
            // Verify re-reads getRequest and finds the request still live
            // → throws "fulfillment did not delete request".
            getRequest: jest.fn().mockResolvedValue({ groupEpoch: 1 }),
        });
        sendAndConfirmMock.mockImplementation(async (_client, _wallet, send, opts) => {
            await send();
            if (opts?.verify) await opts.verify();
            return {};
        });

        const { worker } = loadWorkerWithMock(stub);
        worker
            .eventHandler()
            .on?.fortuna?.(requestCreated(1n), { txHash: 'h', lt: 1n, now: 0 });

        const result = await worker.tick();

        expect(result.failures).toBe(1);
        expect(result.successes).toBe(0);
        expect(worker.pendingCount()).toBe(1); // still queued for retry next tick
    });
});
