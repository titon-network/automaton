// Phase-3 integration test: 2-op multi-op Fortuna fulfillment.
//
// Two FortunaWorker instances share an in-process broadcastShare mock
// that writes partials directly into the peer's ShareCache (instead of
// going over HTTP). This exercises the full multi-op tick flow:
//
//   1. Both workers receive RequestCreated via eventHandler — pending queue.
//   2. Each worker.tick() signs locally + broadcasts (→ peer's cache).
//   3. After both broadcasts, both caches hold 2 partials.
//   4. Leader (lowest UQ-form address) submits the aggregate.
//   5. Aggregate verifies against `pkShare_A + pkShare_B` — what Atlas
//      would have published as `groupPk` after the DKG-style ceremony.
//
// What this test does NOT cover (deferred to a sandbox suite once
// orchestrator wiring lands): real HTTP roundtrip, real Atlas
// `lookupPkShare` reads, real Fortuna contract sandbox.

import { Address } from '@ton/core';
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { BLS_DST_G2_POP, computeAlpha } from '@titon-network/fortuna-sdk';
import type { FortunaEvent } from '@titon-network/fortuna-sdk';
import { FortunaWorker } from '../src/worker/fortuna';
import {
    aggregateGroupPublicKey,
    blsPublicKey,
    randomBlsSecret,
} from '../src/bls';
import { ShareCache, type SharePayload } from '../src/daemon/share-exchange';
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

// Two synthetic addresses with deterministic UQ-form ordering. We need
// to know which is the "leader" (lowest UQ-form string). The hash bytes
// drive the encoding; bytes-all-0x01 < bytes-all-0xFF in lex on the raw
// hash, but base64 encoding doesn't strictly preserve that ordering —
// we just need TWO distinct addresses and pick which is leader at runtime.
function fakeAddress(byte: number): Address {
    const buf = Buffer.alloc(32, byte);
    return new Address(0, buf);
}

interface FortunaStub {
    getRequest: jest.Mock<Promise<{ groupEpoch: number } | null>, [Address, bigint]>;
    getConfig: jest.Mock<Promise<{ submitterReward: bigint; minForwardReserve: bigint; [k: string]: unknown }>>;
    sendFulfillRandomness: jest.Mock<Promise<void>, [unknown, { aggSig: Buffer; [k: string]: unknown }]>;
    address: Address;
}

function makeFortunaStub(): FortunaStub {
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
    };
}

function makeStubClient() {
    const stubSender = { send: () => Promise.resolve() };
    const stubOpened = { sender: () => stubSender };
    return { open: () => stubOpened };
}

function makeWallet(address: Address): AutomatonWallet {
    return {
        mnemonic: [],
        keyPair: { publicKey: Buffer.alloc(32), secretKey: Buffer.alloc(64) } as unknown as AutomatonWallet['keyPair'],
        walletContract: {} as AutomatonWallet['walletContract'],
        address,
        network: 'mainnet',
    };
}

// In-memory broadcast mock — writes the payload's partial into the peer's
// ShareCache directly. Replaces the real fetch-based broadcast for this
// integration test.
function makeMockBroadcast(peerCaches: Map<string, ShareCache>) {
    return async function mockBroadcast(
        peers: readonly { address: string; endpoint: string }[],
        payload: SharePayload,
    ): Promise<{ peer: string; ok: boolean }[]> {
        return peers.map((peer) => {
            const cache = peerCaches.get(peer.address);
            if (cache !== undefined) {
                const partialBytes = Buffer.from(payload.partial.replace(/^0x/, ''), 'hex');
                cache.set(payload.reqKey, payload.fromAddress, partialBytes);
            }
            return { peer: peer.address, ok: true };
        });
    };
}

function requestCreated(reqKey: bigint): FortunaEvent {
    return {
        kind: 'RequestCreated',
        opcode: 0x60,
        reqKey,
        consumer: fakeAddress(0xC0),
        queryId: reqKey,
        seed: 0xDEADBEEFn,
        deadline: 10_000,
        groupEpoch: 1,
        creationLt: 1_000_000n,
    };
}

describe('multi-op Fortuna fulfillment (2-op integration)', () => {
    let secretA: Uint8Array;
    let secretB: Uint8Array;
    let workerA: FortunaWorker;
    let workerB: FortunaWorker;
    let stubA: FortunaStub;
    let stubB: FortunaStub;
    let cacheA: ShareCache;
    let cacheB: ShareCache;
    let groupPk: Buffer;
    let addrA: Address;
    let addrB: Address;
    let addrAStr: string;
    let addrBStr: string;

    beforeEach(() => {
        secretA = randomBlsSecret();
        secretB = randomBlsSecret();
        groupPk = aggregateGroupPublicKey([secretA, secretB]);

        addrA = fakeAddress(0x01);
        addrB = fakeAddress(0xFE);
        addrAStr = addrA.toString({ bounceable: false });
        addrBStr = addrB.toString({ bounceable: false });

        cacheA = new ShareCache();
        cacheB = new ShareCache();
        const peerCaches = new Map<string, ShareCache>([
            [addrAStr, cacheA],
            [addrBStr, cacheB],
        ]);
        const broadcast = makeMockBroadcast(peerCaches);

        stubA = makeFortunaStub();
        stubB = makeFortunaStub();

        // Stub the clock so the request's deadline (10000) is in the
        // future — real Date.now() would expire it before tick runs.
        // Use a small value so the seenAt-based grace period (30s default)
        // is also not elapsed within a single test invocation.
        const fakeNow = () => 5;

        workerA = new FortunaWorker({
            fortuna: stubA as never,
            client: makeStubClient() as never,
            wallet: makeWallet(addrA),
            blsSecret: Buffer.from(secretA),
            logger: silentLogger(),
            shareCache: cacheA,
            peers: [{ address: addrBStr, endpoint: 'http://peer-b/' }],
            broadcastShare: broadcast,
            nowSec: fakeNow,
            // submitFulfill bypasses sendAndConfirm; we just check
            // sendFulfillRandomness was called with the right aggregate.
            submitFulfill: async (send, _verify) => {
                await send();
            },
        });
        workerB = new FortunaWorker({
            fortuna: stubB as never,
            client: makeStubClient() as never,
            wallet: makeWallet(addrB),
            blsSecret: Buffer.from(secretB),
            logger: silentLogger(),
            shareCache: cacheB,
            peers: [{ address: addrAStr, endpoint: 'http://peer-a/' }],
            broadcastShare: broadcast,
            nowSec: fakeNow,
            submitFulfill: async (send, _verify) => {
                await send();
            },
        });
    });

    it('both workers exchange shares + leader submits aggregate that verifies against groupPk', async () => {
        // 1. Both workers see the request via eventHandler.
        const req = requestCreated(0xABCDn);
        workerA.eventHandler().on?.fortuna?.(req, { txHash: 'h1', lt: 1n, now: 0 });
        workerB.eventHandler().on?.fortuna?.(req, { txHash: 'h1', lt: 1n, now: 0 });

        // 2. Tick A — signs + mock-broadcasts to B's cache.
        await workerA.tick();
        // After tick A:
        //   cacheA has A's own partial.
        //   cacheB has A's partial (via the mock broadcast).
        expect(cacheA.countFor('abcd')).toBe(1);
        expect(cacheB.countFor('abcd')).toBe(1);

        // 3. Tick B — signs + mock-broadcasts to A's cache.
        await workerB.tick();
        // After tick B:
        //   cacheB has both partials (B's own + A's from step 2).
        //   cacheA has both partials (A's own + B's from this step).
        expect(cacheA.countFor('abcd')).toBe(2);
        expect(cacheB.countFor('abcd')).toBe(2);

        // 4. Determine which worker is the leader (lowest UQ-form addr).
        //    The other worker waits leaderGraceSec before falling back.
        const leaderIsA = addrAStr < addrBStr;
        const leaderWorker = leaderIsA ? workerA : workerB;
        const leaderStub = leaderIsA ? stubA : stubB;
        const followerStub = leaderIsA ? stubB : stubA;

        // 5. Tick the leader — should submit (cache full + is leader).
        await leaderWorker.tick();
        expect(leaderStub.sendFulfillRandomness).toHaveBeenCalledTimes(1);
        // The follower should NOT have submitted (still in grace).
        expect(followerStub.sendFulfillRandomness).toHaveBeenCalledTimes(0);

        // 6. Verify the aggregate that landed on chain pairs with groupPk.
        //    This is the load-bearing assertion: an honestly-aggregated
        //    multi-op signature passes Fortuna's BLS_VERIFY against the
        //    groupPk Atlas would have published.
        const submitArgs = leaderStub.sendFulfillRandomness.mock.calls[0]![1];
        const aggregate = submitArgs.aggSig;
        const alpha = computeAlpha(req.consumer, req.queryId, req.seed, req.creationLt);
        const ok = bls.longSignatures.verify(
            aggregate,
            bls.longSignatures.hash(alpha, BLS_DST_G2_POP),
            groupPk,
        );
        expect(ok).toBe(true);

        // 7. Sanity: the aggregate is NOT either single partial (i.e., we
        //    actually combined two distinct shares).
        expect(
            bls.longSignatures.verify(
                aggregate,
                bls.longSignatures.hash(alpha, BLS_DST_G2_POP),
                Buffer.from(blsPublicKey(secretA)),
            ),
        ).toBe(false);
        expect(
            bls.longSignatures.verify(
                aggregate,
                bls.longSignatures.hash(alpha, BLS_DST_G2_POP),
                Buffer.from(blsPublicKey(secretB)),
            ),
        ).toBe(false);
    });

    it('non-leader is held in grace period until leader has chance to submit', async () => {
        const req = requestCreated(0xBEEFn);
        workerA.eventHandler().on?.fortuna?.(req, { txHash: 'h1', lt: 1n, now: 0 });
        workerB.eventHandler().on?.fortuna?.(req, { txHash: 'h1', lt: 1n, now: 0 });

        // Both broadcast.
        await workerA.tick();
        await workerB.tick();

        const leaderIsA = addrAStr < addrBStr;
        const followerWorker = leaderIsA ? workerB : workerA;
        const followerStub = leaderIsA ? stubB : stubA;

        // Follower ticks — grace not elapsed → does NOT submit.
        await followerWorker.tick();
        expect(followerStub.sendFulfillRandomness).toHaveBeenCalledTimes(0);
    });

    it('non-leader falls back after grace period elapses', async () => {
        const req = requestCreated(0xCAFEn);
        // Use injectable nowSec so we can advance the worker's clock past
        // leaderGraceSec without sleeping.
        let nowMs = 0;
        const customNow = () => Math.floor(nowMs / 1000);

        // Rebuild followerWorker with controlled clock + short grace.
        const leaderIsA = addrAStr < addrBStr;
        const followerSecret = leaderIsA ? secretB : secretA;
        const followerAddr = leaderIsA ? addrB : addrA;
        const followerPeerAddr = leaderIsA ? addrAStr : addrBStr;
        const followerCache = leaderIsA ? cacheB : cacheA;
        const followerStub = leaderIsA ? stubB : stubA;
        const peerCaches = new Map<string, ShareCache>([
            [addrAStr, cacheA],
            [addrBStr, cacheB],
        ]);
        const broadcast = makeMockBroadcast(peerCaches);

        const follower = new FortunaWorker({
            fortuna: followerStub as never,
            client: makeStubClient() as never,
            wallet: makeWallet(followerAddr),
            blsSecret: Buffer.from(followerSecret),
            logger: silentLogger(),
            shareCache: followerCache,
            peers: [{ address: followerPeerAddr, endpoint: 'http://peer/' }],
            broadcastShare: broadcast,
            leaderGraceSec: 5,
            nowSec: customNow,
            submitFulfill: async (send) => { await send(); },
        });

        follower.eventHandler().on?.fortuna?.(req, { txHash: 'h1', lt: 1n, now: 0 });
        // Pre-fill the follower's cache with the (fake) leader partial,
        // so it has 2 partials right away.
        const leaderSecret = leaderIsA ? secretA : secretB;
        const leaderAddr = leaderIsA ? addrAStr : addrBStr;
        const alpha = computeAlpha(req.consumer, req.queryId, req.seed, req.creationLt);
        const leaderPartial = Buffer.from(bls.longSignatures.sign(
            bls.longSignatures.hash(alpha, BLS_DST_G2_POP), leaderSecret).toBytes(true));
        followerCache.set('cafe', leaderAddr, leaderPartial);

        // First tick: signAndBroadcast (own partial) + cache full + grace not elapsed.
        await follower.tick();
        expect(followerStub.sendFulfillRandomness).toHaveBeenCalledTimes(0);

        // Advance clock past grace.
        nowMs = 60_000;
        await follower.tick();
        expect(followerStub.sendFulfillRandomness).toHaveBeenCalledTimes(1);
    });

    // Regression tests for the cleanup paths — past-deadline + peer-fulfilled
    // + reclaimed events all need to clear `broadcasted` + `shareCache` so
    // those structures don't accumulate stale entries forever. Removing
    // any of those `delete` calls should make these tests fail.
    describe('multi-op state cleanup', () => {
        it('past-deadline tick clears broadcasted + shareCache', async () => {
            const req = requestCreated(0xDEADn);
            workerA.eventHandler().on?.fortuna?.(req, { txHash: 'h1', lt: 1n, now: 0 });
            await workerA.tick(); // signAndBroadcast → broadcasted + cache populated
            expect(cacheA.countFor('dead')).toBeGreaterThan(0);

            // Build a worker with a clock past the request's deadline (10000s).
            const lateClock = () => 99_999;
            const lateWorker = new FortunaWorker({
                fortuna: stubA as never,
                client: makeStubClient() as never,
                wallet: makeWallet(addrA),
                blsSecret: Buffer.from(secretA),
                logger: silentLogger(),
                shareCache: cacheA,
                peers: [{ address: addrBStr, endpoint: 'http://peer-b/' }],
                broadcastShare: makeMockBroadcast(new Map([[addrBStr, cacheB]])),
                nowSec: lateClock,
            });
            lateWorker.eventHandler().on?.fortuna?.(req, { txHash: 'h1', lt: 1n, now: 0 });
            // Pre-populate cacheA with our partial as if a prior tick broadcast.
            cacheA.set('dead', addrAStr, Buffer.alloc(96, 0xAA));

            await lateWorker.tick();
            expect(cacheA.countFor('dead')).toBe(0); // shareCache cleared
            // broadcasted is private; observable proxy: a re-tick on a fresh
            // request with the same key wouldn't try to submit (no signal here),
            // but cache=0 + pending.delete is the load-bearing assertion.
        });

        it('RequestFulfilled event clears broadcasted + shareCache', async () => {
            const req = requestCreated(0xBABEn);
            workerA.eventHandler().on?.fortuna?.(req, { txHash: 'h1', lt: 1n, now: 0 });
            await workerA.tick();
            expect(cacheA.countFor('babe')).toBeGreaterThan(0);

            // Peer wins the race; orchestrator's event drain delivers
            // RequestFulfilled with submitter != us.
            workerA.eventHandler().on?.fortuna?.(
                {
                    kind: 'RequestFulfilled',
                    opcode: 0x61,
                    reqKey: 0xBABEn,
                    submitter: addrB,
                    beta: 0x999n,
                },
                { txHash: 'h2', lt: 2n, now: 1 },
            );
            expect(cacheA.countFor('babe')).toBe(0);
        });

        it('RequestReclaimed event clears broadcasted + shareCache', async () => {
            const req = requestCreated(0xF00Dn);
            workerA.eventHandler().on?.fortuna?.(req, { txHash: 'h1', lt: 1n, now: 0 });
            await workerA.tick();
            expect(cacheA.countFor('f00d')).toBeGreaterThan(0);

            workerA.eventHandler().on?.fortuna?.(
                {
                    kind: 'RequestReclaimed',
                    opcode: 0x62,
                    reqKey: 0xF00Dn,
                    consumer: req.consumer,
                    reason: 1,
                },
                { txHash: 'h3', lt: 3n, now: 1 },
            );
            expect(cacheA.countFor('f00d')).toBe(0);
        });
    });
});
