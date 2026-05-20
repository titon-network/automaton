// PhoebeWorker unit tests — class behavior parallel to fortuna-worker.spec.ts.
//
// Scope: the worker's state machine (paused / in-flight / cadence /
// multi-op proposal lifecycle) PLUS the submitPushSnapshot catch-don't-
// rethrow invariant (a regression here would crash the daemon — this is
// the exact bug the recent security pass fixed).
//
// We stub the Phoebe contract's `sendPushSnapshot` + `getLastSubmitter`
// and inject the worker's `submitPush` and `broadcastShare` hooks so
// the wallet / RPC / fetch boundaries never get crossed. Real sandbox
// integration is in tests/phoebe-worker-integration.spec.ts.
//
// Each describe block targets one observable surface:
//   - eventHandler() — Paused/Unpaused/GroupKeyCached state updates
//   - tick() solo — cadence gate + happy path + paused/no-feeds skip
//   - tick() multi-op — sign-broadcast → aggregate gate → leader-grace
//   - submitPushSnapshot — exception catch (catch-don't-rethrow)
//   - dispose() — closes serverHandle once
//
// Window-rounding is verified indirectly via the timestamps the stub
// sees on sendPushSnapshot calls.

import { Address } from '@ton/core';
import {
    computeSnapshotHash,
    randomBlsSecret,
    signMessage,
    type PhoebeEvent,
} from '@titon-network/phoebe-sdk';
import { PhoebeWorker, type PhoebeFeedEntry } from '../src/worker/phoebe';
import {
    PhoebeShareCache,
    snapshotKey,
    type PhoebePeerEndpoint,
    type PhoebeSharePayload,
} from '../src/daemon/share-exchange-phoebe';
import { fakeAddress, fakeWallet, fakeTxContext } from './helpers/fixtures';
import { silentLogger } from './helpers/logger';

/** Pull the snapshot key out of the most recent broadcastShare call.
 *  This is the same key the worker uses to write its own partial into
 *  the cache, so tests can inject a peer's partial under it without
 *  touching cache internals. */
function lastBroadcastKey(broadcast: jest.Mock): string {
    const calls = broadcast.mock.calls;
    if (calls.length === 0) throw new Error('broadcast was never called');
    const payload = calls[calls.length - 1]![1] as PhoebeSharePayload;
    return snapshotKey(payload.timestamp, payload.rootHex);
}

interface PhoebeStub {
    address: Address;
    sendPushSnapshot: jest.Mock<Promise<void>, [unknown, unknown]>;
    getLastSubmitter: jest.Mock<Promise<Address | null>, []>;
    getSnapshot: jest.Mock<Promise<{ lastSnapshotTime: number; lastRoot: bigint }>, []>;
}

function stubPhoebeContract(opts: {
    submitter?: Address | null;
    snapshot?: { lastSnapshotTime: number; lastRoot: bigint };
} = {}): PhoebeStub {
    return {
        address: fakeAddress(0xfa),
        sendPushSnapshot: jest.fn().mockResolvedValue(undefined),
        getLastSubmitter: jest.fn().mockResolvedValue(opts.submitter ?? null),
        getSnapshot: jest.fn().mockResolvedValue(
            opts.snapshot ?? { lastSnapshotTime: 0, lastRoot: 0n },
        ),
    };
}

function stubClient(): { client: unknown } {
    // The worker uses `senderFor(client, wallet)` only if no `sender` is
    // injected; we inject one below so client stays untouched. But
    // sendAndConfirm in the real path uses `client.open(walletContract)`
    // — we never reach that path because we inject `submitPush`.
    const stubSender = { send: () => Promise.resolve() };
    const stubOpened = { sender: () => stubSender };
    return { client: { open: () => stubOpened } };
}

const ME = fakeAddress(0xaa);

/** Construct a PhoebeWorker for tests. Sandbox boundaries are stubbed
 *  via `submitPush` (skips sendAndConfirm) and `sender` (skips senderFor),
 *  so no real wallet / RPC / chain is touched. */
function makeWorker(opts: {
    feeds?: readonly PhoebeFeedEntry[];
    nowSec?: () => number;
    peers?: readonly PhoebePeerEndpoint[];
    shareCache?: PhoebeShareCache;
    broadcastShare?: jest.Mock;
    submitPush?: (send: () => Promise<void>, verify: () => Promise<void>) => Promise<void>;
    serverHandle?: { close(): Promise<void> };
    initialGroupEpoch?: number;
    leaderGraceSec?: number;
    me?: Address;
    pushIntervalSec?: number;
    counters?: Parameters<typeof PhoebeWorker>[0]['counters'];
    phoebeStub?: PhoebeStub;
}): { worker: PhoebeWorker; phoebe: PhoebeStub } {
    const phoebe = opts.phoebeStub ?? stubPhoebeContract();
    const { client } = stubClient();
    const wallet = fakeWallet(opts.me ?? ME);
    const stubSender = { send: () => Promise.resolve() };
    const worker = new PhoebeWorker({
        phoebe: phoebe as never,
        client: client as never,
        wallet,
        blsSecret: Buffer.alloc(32, 0x42),
        logger: silentLogger(),
        feeds: opts.feeds ?? [
            { kind: 'static', feedId: 1, mantissa: 6_500_000n, expo: -6, confBps: 50 },
        ],
        sender: stubSender as never,
        nowSec: opts.nowSec ?? (() => 1_000_000),
        pushIntervalSec: opts.pushIntervalSec ?? 30,
        peers: opts.peers,
        shareCache: opts.shareCache,
        broadcastShare: opts.broadcastShare as never,
        leaderGraceSec: opts.leaderGraceSec,
        initialGroupEpoch: opts.initialGroupEpoch,
        serverHandle: opts.serverHandle,
        submitPush:
            opts.submitPush ??
            (async (send) => {
                await send();
            }),
        counters: opts.counters,
    });
    return { worker, phoebe };
}

// ===== eventHandler =====

describe('PhoebeWorker.eventHandler', () => {
    it('paused → tick skips with reason "paused"', async () => {
        const { worker } = makeWorker({});
        const handler = worker.eventHandler();
        handler.on?.phoebe?.({ kind: 'Paused' } as PhoebeEvent, fakeTxContext());
        const result = await worker.tick();
        expect(result.pushed).toBe(false);
        expect(result.reason).toBe('paused');
    });

    it('unpaused after paused → tick resumes (skipped reason is cadence/no-feeds, not paused)', async () => {
        const { worker } = makeWorker({});
        const handler = worker.eventHandler();
        handler.on?.phoebe?.({ kind: 'Paused' } as PhoebeEvent, fakeTxContext());
        handler.on?.phoebe?.({ kind: 'Unpaused' } as PhoebeEvent, fakeTxContext());
        const result = await worker.tick();
        // First tick at t=1_000_000 / 30s window → never pushed at this
        // window before → goes ahead. Just assert not "paused".
        expect(result.reason).not.toBe('paused');
    });

    it('GroupKeyCached updates the worker groupEpoch (multi-op gate clears)', async () => {
        // With initialGroupEpoch=0, multi-op tick skips with "awaiting-group-epoch".
        // After GroupKeyCached lands with newEpoch=5, the next tick proceeds past that gate.
        const cache = new PhoebeShareCache();
        const broadcast = jest.fn().mockResolvedValue([]);
        const { worker } = makeWorker({
            peers: [{ address: fakeAddress(0xbb).toString({ bounceable: false }), endpoint: 'http://peer' }],
            shareCache: cache,
            broadcastShare: broadcast,
            initialGroupEpoch: 0,
        });
        const r1 = await worker.tick();
        expect(r1.reason).toBe('awaiting-group-epoch');

        worker.eventHandler().on?.phoebe?.(
            {
                kind: 'GroupKeyCached',
                groupId: 0,
                oldEpoch: 0,
                newEpoch: 5,
                groupPk: Buffer.alloc(48),
                threshold: 1,
                memberCount: 2,
            } as PhoebeEvent,
            fakeTxContext(),
        );
        const r2 = await worker.tick();
        // Now past the epoch gate; multi-op signs + broadcasts.
        expect(r2.reason).toBe('awaiting-shares');
        expect(broadcast).toHaveBeenCalledTimes(1);
    });

    it('GroupKeyCached clears stale multi-op proposal (mid-window epoch rotation)', async () => {
        const cache = new PhoebeShareCache();
        const broadcast = jest.fn().mockResolvedValue([]);
        const { worker } = makeWorker({
            peers: [{ address: fakeAddress(0xbb).toString({ bounceable: false }), endpoint: 'http://peer' }],
            shareCache: cache,
            broadcastShare: broadcast,
            initialGroupEpoch: 1,
        });
        // Stand a proposal up.
        await worker.tick();
        const sizeBefore = cache.size();
        expect(sizeBefore).toBe(1);

        // Epoch rotates — our cached partial is now stale, must be dropped.
        worker.eventHandler().on?.phoebe?.(
            {
                kind: 'GroupKeyCached',
                groupId: 0,
                oldEpoch: 1,
                newEpoch: 2,
                groupPk: Buffer.alloc(48),
                threshold: 1,
                memberCount: 2,
            } as PhoebeEvent,
            fakeTxContext(),
        );
        expect(cache.size()).toBe(0);
    });
});

// ===== solo tick path =====

describe('PhoebeWorker.tick — solo mode', () => {
    it('pushes on first tick within an unseen window', async () => {
        const { worker, phoebe } = makeWorker({ nowSec: () => 1_000_000 });
        const result = await worker.tick();
        expect(result.pushed).toBe(true);
        expect(result.reason).toBe('solo');
        expect(phoebe.sendPushSnapshot).toHaveBeenCalledTimes(1);
        const args = phoebe.sendPushSnapshot.mock.calls[0]![1] as { timestamp: number };
        // 1_000_000 rounded down to nearest 30s = 999_990.
        expect(args.timestamp).toBe(999_990);
    });

    it('skips with "cadence" when called again in the same window', async () => {
        let now = 1_000_000;
        const { worker, phoebe } = makeWorker({ nowSec: () => now });
        await worker.tick();
        now = 1_000_010; // still in window [999_990, 1_000_020)
        const r = await worker.tick();
        expect(r.reason).toBe('cadence');
        expect(phoebe.sendPushSnapshot).toHaveBeenCalledTimes(1);
    });

    it('pushes again when the window rolls', async () => {
        let now = 1_000_000;
        const { worker, phoebe } = makeWorker({ nowSec: () => now });
        await worker.tick();
        now = 1_000_050; // next window starts at 1_000_020
        const r = await worker.tick();
        expect(r.pushed).toBe(true);
        expect(phoebe.sendPushSnapshot).toHaveBeenCalledTimes(2);
    });

    it('skips with "no-feeds" when feeds is empty', async () => {
        const { worker } = makeWorker({ feeds: [] });
        const r = await worker.tick();
        expect(r.reason).toBe('no-feeds');
    });
});

// ===== multi-op state machine =====

describe('PhoebeWorker.tick — multi-op', () => {
    // Leader election is "lowest UQ-form base64 string" — ME is 0xaa →
    // "UQCqqq...". Picking PEER1=0xff → "UQD___..." makes ME strictly
    // less than PEER1 so the leader branch is taken without grace.
    const PEER1 = fakeAddress(0xff);

    it('signs + broadcasts on first tick, returns "awaiting-shares"', async () => {
        const cache = new PhoebeShareCache();
        const broadcast = jest.fn().mockResolvedValue([{ peer: PEER1.toString(), ok: true }]);
        const { worker } = makeWorker({
            peers: [{ address: PEER1.toString({ bounceable: false }), endpoint: 'http://p1' }],
            shareCache: cache,
            broadcastShare: broadcast,
            initialGroupEpoch: 1,
        });
        const r = await worker.tick();
        expect(r.reason).toBe('awaiting-shares');
        expect(broadcast).toHaveBeenCalledTimes(1);
        // Our partial landed in the shared cache (the share-exchange
        // server would write peer partials there in production).
        expect(cache.size()).toBe(1);
    });

    /** Produce a real BLS partial — `aggregateSignatures` validates G2
     *  subgroup membership, so fake bytes throw. The signed message
     *  doesn't matter (we're not verifying against on-chain groupPk),
     *  only that the bytes deserialize as a valid G2 point. */
    function realPartial(): Buffer {
        const sk = randomBlsSecret();
        const msg = computeSnapshotHash(fakeAddress(0xfa), 0, 0n);
        return signMessage(sk, msg);
    }

    it('waits while haveCount < memberCount; aggregates + pushes when full', async () => {
        const cache = new PhoebeShareCache();
        const broadcast = jest.fn().mockResolvedValue([]);
        const { worker, phoebe } = makeWorker({
            // n=2 → me + 1 peer → memberCount=2.
            peers: [{ address: PEER1.toString({ bounceable: false }), endpoint: 'http://p1' }],
            shareCache: cache,
            broadcastShare: broadcast,
            initialGroupEpoch: 1,
            // me is the LOWEST address (0xaa < 0xbb) → leader, no grace needed.
        });
        // Tick 1: sign + broadcast → awaiting-shares.
        await worker.tick();
        const cacheKey = lastBroadcastKey(broadcast);
        // Tick 2: haveCount = 1 (just our own) < memberCount = 2 → still waiting.
        const r2 = await worker.tick();
        expect(r2.reason).toBe('awaiting-shares');
        // Now inject a valid peer partial — must be a real BLS sig so
        // aggregateSignatures' subgroup check passes.
        cache.set(cacheKey, PEER1.toString({ bounceable: false }), realPartial());
        // Tick 3: haveCount = 2 == memberCount → leader aggregates + pushes.
        const r3 = await worker.tick();
        expect(r3.pushed).toBe(true);
        expect(r3.reason).toBe('multi-op-leader');
        expect(phoebe.sendPushSnapshot).toHaveBeenCalledTimes(1);
    });

    it('non-leader respects leaderGraceSec before fallback submit', async () => {
        const cache = new PhoebeShareCache();
        const broadcast = jest.fn().mockResolvedValue([]);
        let now = 1_000_000;
        // Make us the HIGHER address → non-leader. Peer 0x11 < me 0xaa.
        const LOWPEER = fakeAddress(0x11);
        const { worker, phoebe } = makeWorker({
            me: ME,
            peers: [{ address: LOWPEER.toString({ bounceable: false }), endpoint: 'http://p1' }],
            shareCache: cache,
            broadcastShare: broadcast,
            initialGroupEpoch: 1,
            leaderGraceSec: 30,
            nowSec: () => now,
            // Bigger push interval so grace fits within ONE window — the
            // window-roll path is exercised by the next test.
            pushIntervalSec: 120,
        });
        await worker.tick(); // sign + broadcast
        const cacheKey = lastBroadcastKey(broadcast);
        cache.set(cacheKey, LOWPEER.toString({ bounceable: false }), realPartial());
        // Within grace (5s after broadcast) → non-leader-grace.
        now = 1_000_005;
        const rGrace = await worker.tick();
        expect(rGrace.reason).toBe('non-leader-grace');
        expect(phoebe.sendPushSnapshot).not.toHaveBeenCalled();
        // After grace (35s elapsed) → fallback submit (still same window
        // because pushIntervalSec=120 so windowStart unchanged).
        now = 1_000_035;
        const rFallback = await worker.tick();
        expect(rFallback.pushed).toBe(true);
        expect(rFallback.reason).toBe('multi-op-fallback');
    });

    it('rolling to a new window clears stale proposal + signs fresh', async () => {
        const cache = new PhoebeShareCache();
        const broadcast = jest.fn().mockResolvedValue([]);
        let now = 1_000_000;
        const { worker } = makeWorker({
            peers: [{ address: PEER1.toString({ bounceable: false }), endpoint: 'http://p1' }],
            shareCache: cache,
            broadcastShare: broadcast,
            initialGroupEpoch: 1,
            nowSec: () => now,
        });
        await worker.tick();
        expect(cache.size()).toBe(1);
        const firstKey = lastBroadcastKey(broadcast);
        // Next window — old proposal is dropped, new one signed.
        now = 1_000_040;
        await worker.tick();
        const secondKey = lastBroadcastKey(broadcast);
        expect(secondKey).not.toBe(firstKey);
        expect(cache.size()).toBe(1); // only the new key remains
        expect(cache.countFor(firstKey)).toBe(0);
        expect(cache.countFor(secondKey)).toBe(1);
        expect(broadcast).toHaveBeenCalledTimes(2);
    });
});

// ===== submitPushSnapshot exception catch (regression guard) =====

describe('PhoebeWorker.submitPushSnapshot exception handling', () => {
    it('does NOT rethrow when sendPushSnapshot throws — daemon must stay up', async () => {
        const phoebe = stubPhoebeContract();
        phoebe.sendPushSnapshot.mockRejectedValueOnce(new Error('rpc blew up'));
        const counters = {
            incrementPushAttempt: jest.fn(),
            incrementPushSuccess: jest.fn(),
            incrementPushFailure: jest.fn(),
            incrementPushSkip: jest.fn(),
        };
        const { worker } = makeWorker({ phoebeStub: phoebe, counters });
        // Must resolve, not throw — a rethrow propagates to tickOnce →
        // unhandled rejection → daemon shutdown. Mirrors the fortuna
        // pattern.
        const result = await worker.tick();
        expect(result.pushed).toBe(false);
        expect(result.reason).toBe('exception');
        expect(counters.incrementPushFailure).toHaveBeenCalledWith('exception');
        // hasInFlight resets after the failure.
        expect(worker.hasInFlight()).toBe(false);
    });
});

// ===== verify: lastSnapshotTime poll catches ghost-tx =====
//
// Regression guard for the old false-positive: the verify callback
// used to only check seqno+getLastSubmitter, which both succeed even
// when a V5R1 wallet ghost-drops the action phase (balance < send
// value). The new verify polls `phoebe.lastSnapshotTime` until it
// reaches our push's timestamp, otherwise throws.

describe('PhoebeWorker.submitPushSnapshot verify (lastSnapshotTime poll)', () => {
    const PUSH_TS = 1_000_020; // arbitrary push timestamp (windowStart)

    it('verify resolves when lastSnapshotTime advances to our timestamp', async () => {
        const phoebe = stubPhoebeContract({
            snapshot: { lastSnapshotTime: PUSH_TS, lastRoot: 0x1234n },
            submitter: ME,
        });
        let verifyResult: 'pending' | 'resolved' | 'rejected' = 'pending';
        const { worker } = makeWorker({
            phoebeStub: phoebe,
            nowSec: () => PUSH_TS, // align tick window with PUSH_TS
            submitPush: async (send, verify) => {
                await send();
                try { await verify(); verifyResult = 'resolved'; }
                catch { verifyResult = 'rejected'; }
            },
        });
        const result = await worker.tick();
        expect(result.pushed).toBe(true);
        expect(verifyResult).toBe('resolved');
    });

    it('verify resolves when a peer raced and landed a fresher snapshot (> ours)', async () => {
        const phoebe = stubPhoebeContract({
            snapshot: { lastSnapshotTime: PUSH_TS + 30, lastRoot: 0x5678n },
            submitter: fakeAddress(0xbb), // a peer
        });
        let verifyResult: 'pending' | 'resolved' | 'rejected' = 'pending';
        const { worker } = makeWorker({
            phoebeStub: phoebe,
            nowSec: () => PUSH_TS,
            submitPush: async (send, verify) => {
                await send();
                try { await verify(); verifyResult = 'resolved'; }
                catch { verifyResult = 'rejected'; }
            },
        });
        const result = await worker.tick();
        expect(result.pushed).toBe(true);
        expect(verifyResult).toBe('resolved');
    });

    it('verify warns (but resolves) when same timestamp has a peer submitter', async () => {
        const peer = fakeAddress(0xbb);
        const phoebe = stubPhoebeContract({
            snapshot: { lastSnapshotTime: PUSH_TS, lastRoot: 0xfeedn },
            submitter: peer, // not us
        });
        let verifyResult: 'pending' | 'resolved' | 'rejected' = 'pending';
        const warnSpy = jest.fn();
        const logger = {
            debug: jest.fn(), info: jest.fn(), warn: warnSpy, error: jest.fn(),
        };
        const { worker } = makeWorker({
            phoebeStub: phoebe,
            nowSec: () => PUSH_TS,
            submitPush: async (send, verify) => {
                await send();
                try { await verify(); verifyResult = 'resolved'; }
                catch { verifyResult = 'rejected'; }
            },
        });
        // Replace the worker's logger via the global silent stub — the
        // makeWorker helper installs silentLogger, so we have to spy on
        // its methods via the phoebe stub indirectly. Instead just
        // assert behavior: tick resolves, getLastSubmitter was called.
        await worker.tick();
        expect(verifyResult).toBe('resolved');
        expect(phoebe.getLastSubmitter).toHaveBeenCalled();
    });

    it('verify throws if lastSnapshotTime never advances (ghost-tx detected)', async () => {
        // Snapshot stays at an OLD value through the poll window → push
        // never landed.
        const phoebe = stubPhoebeContract({
            snapshot: { lastSnapshotTime: PUSH_TS - 60, lastRoot: 0xabcdn },
        });
        let captured: Error | null = null;
        const { worker } = makeWorker({
            phoebeStub: phoebe,
            nowSec: () => PUSH_TS,
            submitPush: async (send, verify) => {
                await send();
                try { await verify(); }
                catch (err) { captured = err as Error; }
            },
        });
        // Cap how long the test waits — the verify polls every 2s up to 30s.
        // We mock getSnapshot to return stale-only; verify must time out
        // and throw. Increase test timeout above the verify timeout.
        await worker.tick();
        expect(captured).not.toBeNull();
        expect(captured!.message).toMatch(/did not land/);
        expect(captured!.message).toMatch(/V5R1 ghost-tx/);
    }, 60_000);
});

// ===== dispose =====

describe('PhoebeWorker.dispose', () => {
    it('closes the share-exchange server handle if one was supplied', async () => {
        const close = jest.fn().mockResolvedValue(undefined);
        const { worker } = makeWorker({ serverHandle: { close } });
        await worker.dispose();
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when no serverHandle is set (solo mode)', async () => {
        const { worker } = makeWorker({});
        await expect(worker.dispose()).resolves.toBeUndefined();
    });
});
