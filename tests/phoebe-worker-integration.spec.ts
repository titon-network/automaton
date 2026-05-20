// Phase-3 integration test: 2-op multi-op Phoebe snapshot push.
//
// Mirror of multi-op-fortuna.spec.ts. Two PhoebeWorker instances share
// an in-process broadcastPhoebeShare mock that writes partials directly
// into the peer's PhoebeShareCache (no HTTP). Exercises the full multi-op
// tick flow:
//
//   1. Both workers tick — each rounds `now` to the same windowStart
//      (static feeds + identical pushIntervalSec → byte-identical root).
//   2. Each tick signs locally + mock-broadcasts to peer cache.
//   3. After both ticks, both caches hold 2 partials.
//   4. Leader (lowest UQ-form address) tick → aggregates + submits.
//   5. Aggregate verifies against `pkShare_A + pkShare_B` — the
//      groupPk Atlas publishes after the DKG-style ceremony.
//
// The "static feeds → identical roots" requirement is the CRITICAL
// invariant for strict t=n attestation in multi-op (see CLAUDE.md
// caveat). This test pins it.

import { Address } from '@ton/core';
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import {
    BLS_DST_G2_POP,
    aggregateGroupPublicKey,
    blsPublicKey,
    computeSnapshotHash,
    randomBlsSecret,
} from '@titon-network/phoebe-sdk';
import { PhoebeWorker, type PhoebeFeedEntry } from '../src/worker/phoebe';
import {
    PhoebeShareCache,
    snapshotKey,
    type PhoebePeerEndpoint,
    type PhoebeSharePayload,
} from '../src/daemon/share-exchange-phoebe';
import { fakeWallet } from './helpers/fixtures';
import { silentLogger } from './helpers/logger';

function fakeAddress(byte: number): Address {
    return new Address(0, Buffer.alloc(32, byte));
}

interface PhoebeStub {
    address: Address;
    sendPushSnapshot: jest.Mock<Promise<void>, [unknown, { aggSig: Buffer; root: bigint; timestamp: number; value: bigint }]>;
    getLastSubmitter: jest.Mock<Promise<Address | null>>;
}

function makePhoebeStub(): PhoebeStub {
    return {
        address: fakeAddress(0xfa),
        sendPushSnapshot: jest.fn().mockResolvedValue(undefined),
        getLastSubmitter: jest.fn().mockResolvedValue(null),
    };
}

function makeStubClient() {
    const stubSender = { send: () => Promise.resolve() };
    return { open: () => ({ sender: () => stubSender }) };
}

/** In-memory broadcast — writes the partial into the peer's cache
 *  directly (no fetch round-trip). Mirrors fortuna's pattern. */
function makeMockBroadcast(peerCaches: Map<string, PhoebeShareCache>) {
    return async function mockBroadcast(
        peers: readonly PhoebePeerEndpoint[],
        payload: PhoebeSharePayload,
    ): Promise<{ peer: string; ok: boolean; status?: number; error?: string }[]> {
        return peers.map((peer) => {
            const cache = peerCaches.get(peer.address);
            if (cache !== undefined) {
                const key = snapshotKey(payload.timestamp, payload.rootHex);
                const partial = Buffer.from(payload.partial.replace(/^0x/, ''), 'hex');
                cache.set(key, payload.fromAddress, partial);
            }
            return { peer: peer.address, ok: true };
        });
    };
}

describe('multi-op Phoebe snapshot push (2-op integration)', () => {
    let secretA: Uint8Array;
    let secretB: Uint8Array;
    let workerA: PhoebeWorker;
    let workerB: PhoebeWorker;
    let stubA: PhoebeStub;
    let stubB: PhoebeStub;
    let cacheA: PhoebeShareCache;
    let cacheB: PhoebeShareCache;
    let groupPk: Buffer;
    let addrA: Address;
    let addrB: Address;
    let addrAStr: string;
    let addrBStr: string;

    const FEEDS: PhoebeFeedEntry[] = [
        { kind: 'static', feedId: 1, mantissa: 6_500_000n, expo: -6, confBps: 50 },
        { kind: 'static', feedId: 2, mantissa: 65_000_000_000n, expo: -6, confBps: 100 },
    ];
    const WINDOW_START = 1_000_020; // floor(1_000_030 / 30) * 30
    const NOW_SEC = 1_000_030;

    beforeEach(() => {
        secretA = randomBlsSecret();
        secretB = randomBlsSecret();
        groupPk = aggregateGroupPublicKey([secretA, secretB]);

        addrA = fakeAddress(0x01); // lowest → leader
        addrB = fakeAddress(0xfe);
        addrAStr = addrA.toString({ bounceable: false });
        addrBStr = addrB.toString({ bounceable: false });

        cacheA = new PhoebeShareCache();
        cacheB = new PhoebeShareCache();
        const peerCaches = new Map<string, PhoebeShareCache>([
            [addrAStr, cacheA],
            [addrBStr, cacheB],
        ]);
        const broadcast = makeMockBroadcast(peerCaches);

        stubA = makePhoebeStub();
        stubB = makePhoebeStub();

        // Both workers share the SAME stub Phoebe address — that's the
        // value used in computeSnapshotHash, must match across operators.
        const sharedPhoebeAddr = stubA.address;
        stubB.address = sharedPhoebeAddr;

        const nowSec = () => NOW_SEC;
        const initialGroupEpoch = 1;

        workerA = new PhoebeWorker({
            phoebe: stubA as never,
            client: makeStubClient() as never,
            wallet: fakeWallet(addrA),
            blsSecret: Buffer.from(secretA),
            logger: silentLogger(),
            feeds: FEEDS,
            nowSec,
            pushIntervalSec: 30,
            peers: [{ address: addrBStr, endpoint: 'http://peer-b/' }],
            shareCache: cacheA,
            broadcastShare: broadcast,
            initialGroupEpoch,
            sender: { send: () => Promise.resolve() } as never,
            submitPush: async (send) => {
                await send();
            },
        });
        workerB = new PhoebeWorker({
            phoebe: stubB as never,
            client: makeStubClient() as never,
            wallet: fakeWallet(addrB),
            blsSecret: Buffer.from(secretB),
            logger: silentLogger(),
            feeds: FEEDS,
            nowSec,
            pushIntervalSec: 30,
            peers: [{ address: addrAStr, endpoint: 'http://peer-a/' }],
            shareCache: cacheB,
            broadcastShare: broadcast,
            initialGroupEpoch,
            sender: { send: () => Promise.resolve() } as never,
            submitPush: async (send) => {
                await send();
            },
        });
    });

    it('both workers exchange shares + leader submits aggregate that verifies against groupPk', async () => {
        // Tick A — signs + mock-broadcasts to B's cache.
        await workerA.tick();
        expect(cacheA.size()).toBe(1); // own partial
        expect(cacheB.size()).toBe(1); // received from A

        // Tick B — signs + mock-broadcasts to A's cache.
        await workerB.tick();
        // Now both caches hold both partials for the same (windowStart, root).
        const onlyKeyA = [...(cacheA as unknown as { entries: Map<string, unknown> }).entries.keys()][0]!;
        const onlyKeyB = [...(cacheB as unknown as { entries: Map<string, unknown> }).entries.keys()][0]!;
        expect(onlyKeyA).toBe(onlyKeyB); // CRITICAL: same root across operators
        expect(cacheA.countFor(onlyKeyA)).toBe(2);
        expect(cacheB.countFor(onlyKeyB)).toBe(2);

        // Determine leader (lowest UQ-form). addrA = 0x01 → "UQAB..." should be lower.
        const leaderIsA = addrAStr < addrBStr;
        const leaderWorker = leaderIsA ? workerA : workerB;
        const leaderStub = leaderIsA ? stubA : stubB;
        const followerStub = leaderIsA ? stubB : stubA;

        // Leader tick — aggregate + submit.
        await leaderWorker.tick();
        expect(leaderStub.sendPushSnapshot).toHaveBeenCalledTimes(1);
        expect(followerStub.sendPushSnapshot).toHaveBeenCalledTimes(0);

        // Verify the on-chain aggregate pairs with groupPk —
        // the load-bearing assertion: the on-chain BLS_VERIFY against
        // Atlas's groupPk would succeed on this signature.
        const submitArgs = leaderStub.sendPushSnapshot.mock.calls[0]![1];
        const aggregate = submitArgs.aggSig;
        const root = submitArgs.root;
        const timestamp = submitArgs.timestamp;
        expect(timestamp).toBe(WINDOW_START);

        const msg = computeSnapshotHash(stubA.address, timestamp, root);
        const ok = bls.longSignatures.verify(
            aggregate,
            bls.longSignatures.hash(msg, BLS_DST_G2_POP),
            groupPk,
        );
        expect(ok).toBe(true);

        // Sanity: the aggregate is NOT either single partial — combining
        // two shares actually produced a distinct signature.
        expect(
            bls.longSignatures.verify(
                aggregate,
                bls.longSignatures.hash(msg, BLS_DST_G2_POP),
                Buffer.from(blsPublicKey(secretA)),
            ),
        ).toBe(false);
        expect(
            bls.longSignatures.verify(
                aggregate,
                bls.longSignatures.hash(msg, BLS_DST_G2_POP),
                Buffer.from(blsPublicKey(secretB)),
            ),
        ).toBe(false);
    });

    it('non-leader is held in grace until leader has time to submit', async () => {
        await workerA.tick();
        await workerB.tick();
        const leaderIsA = addrAStr < addrBStr;
        const followerWorker = leaderIsA ? workerB : workerA;
        const followerStub = leaderIsA ? stubB : stubA;
        // Follower tick within the same NOW_SEC → grace not elapsed → does NOT submit.
        await followerWorker.tick();
        expect(followerStub.sendPushSnapshot).toHaveBeenCalledTimes(0);
    });

    it('static-feeds invariant: identical feeds across operators yield identical roots', async () => {
        // The cryptographic guarantee of multi-op + static feeds.
        // If this invariant ever breaks (a worker change causes the
        // tree to depend on per-operator state), multi-op stops being
        // strict-t-of-n.
        await workerA.tick();
        await workerB.tick();
        // Reach into the broadcast payloads via the mock — both should
        // carry the same `timestamp` and `rootHex`.
        const broadcastsToB = stubA.sendPushSnapshot.mock.calls;
        const broadcastsToA = stubB.sendPushSnapshot.mock.calls;
        // Neither has submitted yet (only ticks 1 + 2 — no aggregate
        // tick). But cacheA + cacheB should agree on the snapshot key
        // they share.
        void broadcastsToA;
        void broadcastsToB;
        const keysA = [...(cacheA as unknown as { entries: Map<string, unknown> }).entries.keys()];
        const keysB = [...(cacheB as unknown as { entries: Map<string, unknown> }).entries.keys()];
        expect(keysA).toEqual(keysB);
    });
});
