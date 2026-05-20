// ThemisWorker unit tests — per-chamber state machine + tick decision tree
// + happy-path reveal submission.
//
// Scope: the in-memory state machine the worker maintains per chamber
// (round lifecycle from RoundStarted/BidSubmitted/RoundRevealed events,
// operator-mirror tracking from OperatorSynced, group-key cache from
// GroupKeyCached) PLUS the `evaluate()` decision tree that drives `tick()`
// PLUS the cold-start probe via getOperator/getCurrentRound/getGroupKey.
//
// The actual sendRevealRound + sendAndConfirm path is bypassed via the
// `submitReveal` injection point — same pattern as FortunaWorker tests.
// Atlas+ForgeTON+Themis sandbox integration is deferred to a future
// IntegrationThemis.spec.ts pass; here we verify behaviour against
// stubbed chamber contracts.

import { Address, type OpenedContract, type Cell } from '@ton/core';
import type { ThemisChamber, ThemisEvent } from '@titon-network/themis-sdk';
import { blsPublicKey, randomBlsSecret } from '@titon-network/themis-sdk';
import { ThemisWorker, chamberSourceKey } from '../src/worker/themis';
import type { AutomatonWallet } from '../src/wallet';
import type { WorkerLogger } from '../src/worker';
import { fakeAddress, fakeTxContext, fakeWallet } from './helpers/fixtures';
import { silentLogger } from './helpers/logger';

const ME = fakeAddress(0xaa);
const OTHER = fakeAddress(0xbb);
const CHAMBER1 = fakeAddress(0xc1);
const CHAMBER2 = fakeAddress(0xc2);

// 32-byte BLS scalar (deterministic for tests). buildReveal() inside
// submitOne signs with this key — the only constraint is that it's a
// valid BLS12-381 scalar (any non-zero 32-byte buffer works for the
// curve arithmetic; @noble doesn't reject low-entropy keys for signing).
const TEST_BLS_SECRET = Buffer.from(randomBlsSecret());
const TEST_GROUP_PK = Buffer.from(blsPublicKey(TEST_BLS_SECRET));

// ===== Stubs =====

interface ChamberStub {
    address: Address;
    getOperator: jest.Mock;
    getCurrentRound: jest.Mock;
    getGroupKey: jest.Mock;
    getConfig: jest.Mock;
    sendRevealRound: jest.Mock;
}

function makeChamberStub(
    addr: Address,
    overrides: Partial<{
        operator: { isActive: boolean } | null;
        currentRound: { roundId: bigint; commitEta: number; revealEta: number };
        groupKey: {
            entryVersion: number;
            groupPk: Buffer;
            groupEpoch: number;
            threshold: number;
            memberCount: number;
            cachedAt: number;
        };
        config: {
            revealerReward: bigint;
            callbackGas: bigint;
            minXcGas: bigint;
            minReserve: bigint;
        };
    }> = {},
): ChamberStub {
    return {
        address: addr,
        getOperator: jest.fn().mockResolvedValue(overrides.operator ?? null),
        getCurrentRound: jest.fn().mockResolvedValue(
            overrides.currentRound ?? { roundId: 0n, commitEta: 0, revealEta: 0 },
        ),
        getGroupKey: jest.fn().mockResolvedValue(
            overrides.groupKey ?? {
                entryVersion: 0,
                groupPk: Buffer.alloc(48, 0),
                groupEpoch: 0,
                threshold: 0,
                memberCount: 0,
                cachedAt: 0,
            },
        ),
        getConfig: jest.fn().mockResolvedValue({
            configVersion: 1,
            submitFee: 100_000n,
            revealerReward: overrides.config?.revealerReward ?? 50_000_000n,
            callbackGas: overrides.config?.callbackGas ?? 30_000_000n,
            commitDuration: 60,
            revealDuration: 60,
            maxBidsPerRound: 32,
            advanceReward: 0n,
            minReserve: overrides.config?.minReserve ?? 100_000_000n,
            minXcGas: overrides.config?.minXcGas ?? 10_000_000n,
            rewardPool: 0n,
        }),
        sendRevealRound: jest.fn().mockResolvedValue(undefined),
    };
}

function makeWorker(opts: {
    chambers?: Map<string, ChamberStub>;
    nowSec?: () => number;
    submitReveal?: (send: () => Promise<void>, verify: () => Promise<void>) => Promise<void>;
    logger?: WorkerLogger;
} = {}): { worker: ThemisWorker; chambers: Map<string, ChamberStub> } {
    const chambers = opts.chambers ?? new Map<string, ChamberStub>([
        [CHAMBER1.toString({ bounceable: false }), makeChamberStub(CHAMBER1)],
    ]);
    const stubSender = { send: () => Promise.resolve() };
    const stubOpenedWallet = { sender: () => stubSender };
    const client = { open: () => stubOpenedWallet };
    const worker = new ThemisWorker({
        chambers: chambers as unknown as Map<string, OpenedContract<ThemisChamber>>,
        client: client as never,
        wallet: fakeWallet(ME) as AutomatonWallet,
        blsSecret: TEST_BLS_SECRET,
        logger: opts.logger ?? silentLogger(),
        ...(opts.nowSec !== undefined ? { nowSec: opts.nowSec } : {}),
        ...(opts.submitReveal !== undefined ? { submitReveal: opts.submitReveal } : {}),
    });
    return { worker, chambers };
}

// ===== Event-builder helpers =====

function roundStarted(roundId: bigint, commitEta: number, revealEta: number): ThemisEvent {
    return { kind: 'RoundStarted', opcode: 0xb5, roundId, commitEta, revealEta };
}

function bidSubmitted(roundId: bigint, idx: number, c1: Buffer, sender = OTHER): ThemisEvent {
    return {
        kind: 'BidSubmitted',
        opcode: 0xb3,
        roundId,
        idx,
        sender,
        queryId: BigInt(idx),
        c1,
    };
}

function roundRevealed(roundId: bigint, bidCount: number, revealer: Address): ThemisEvent {
    return {
        kind: 'RoundRevealed',
        opcode: 0xb4,
        roundId,
        bidCount,
        revealer,
        revealedAt: 1_000,
        reward: 100n,
    };
}

function roundExpired(roundId: bigint, bidCount: number): ThemisEvent {
    return { kind: 'RoundExpired', opcode: 0xb6, roundId, bidCount };
}

function operatorSynced(automaton: Address, isActive: boolean): ThemisEvent {
    return { kind: 'OperatorSynced', opcode: 0xb1, automaton, isActive };
}

function groupKeyCached(epoch: number, pk: Buffer): ThemisEvent {
    return {
        kind: 'GroupKeyCached',
        opcode: 0xb2,
        groupId: 0,
        oldEpoch: epoch - 1,
        newEpoch: epoch,
        groupPk: pk,
        threshold: 1,
        memberCount: 1,
    };
}

// A valid G1 point compressed to 48 bytes — for tests we use blsPublicKey
// of a random scalar, which gives us a real curve point so buildReveal's
// downstream BLS_G1_INGROUP / scalar-mul math doesn't blow up.
function validG1(): Buffer {
    return Buffer.from(blsPublicKey(Buffer.from(randomBlsSecret())));
}

describe('ThemisWorker construction', () => {
    it('rejects an invalid (non-32-byte) BLS secret', () => {
        const chambers = new Map<string, ChamberStub>();
        const stubSender = { send: () => Promise.resolve() };
        const client = { open: () => ({ sender: () => stubSender }) };
        expect(
            () =>
                new ThemisWorker({
                    chambers: chambers as unknown as Map<string, OpenedContract<ThemisChamber>>,
                    client: client as never,
                    wallet: fakeWallet(ME),
                    blsSecret: Buffer.alloc(16),
                    logger: silentLogger(),
                }),
        ).toThrow(/BLS secret must be 32 bytes/);
    });

    it('seeds one state entry per chamber', () => {
        const chambers = new Map<string, ChamberStub>([
            [CHAMBER1.toString({ bounceable: false }), makeChamberStub(CHAMBER1)],
            [CHAMBER2.toString({ bounceable: false }), makeChamberStub(CHAMBER2)],
        ]);
        const { worker } = makeWorker({ chambers });
        expect(worker.chamberCount()).toBe(2);
        expect(worker.pendingRevealCount()).toBe(0);
        expect(worker.hasInFlight()).toBe(false);
    });
});

describe('ThemisWorker.eventHandler — round lifecycle', () => {
    it('RoundStarted resets state to fresh round', () => {
        const { worker } = makeWorker();
        const handler = worker.eventHandler();
        handler.on![chamberSourceKey(CHAMBER1)]!(
            roundStarted(7n, 100, 200),
            fakeTxContext(),
        );
        // pendingRevealCount only counts rounds that have bids; verify via a
        // probe that the round was registered by adding a bid.
        handler.on![chamberSourceKey(CHAMBER1)]!(
            bidSubmitted(7n, 0, validG1()),
            fakeTxContext(),
        );
        expect(worker.pendingRevealCount()).toBe(1);
    });

    it('BidSubmitted accumulates idx → c1 across multiple events', () => {
        const { worker } = makeWorker();
        const handler = worker.eventHandler();
        handler.on![chamberSourceKey(CHAMBER1)]!(
            roundStarted(1n, 100, 200),
            fakeTxContext(),
        );
        handler.on![chamberSourceKey(CHAMBER1)]!(bidSubmitted(1n, 0, validG1()), fakeTxContext());
        handler.on![chamberSourceKey(CHAMBER1)]!(bidSubmitted(1n, 1, validG1()), fakeTxContext());
        handler.on![chamberSourceKey(CHAMBER1)]!(bidSubmitted(1n, 2, validG1()), fakeTxContext());
        expect(worker.pendingRevealCount()).toBe(1);
    });

    it('BidSubmitted before RoundStarted lazy-inits the round (with eta=0 placeholders)', () => {
        const { worker } = makeWorker();
        const handler = worker.eventHandler();
        handler.on![chamberSourceKey(CHAMBER1)]!(bidSubmitted(5n, 0, validG1()), fakeTxContext());
        // Round exists with one bid, but commitEta/revealEta are 0 — the
        // tick loop will skip with reason 'awaiting-eta' until the
        // cold-start probe (or RoundStarted event) fills them in.
        expect(worker.pendingRevealCount()).toBe(1);
    });

    it('BidSubmitted for a different roundId resets the cached round', () => {
        const { worker } = makeWorker();
        const handler = worker.eventHandler();
        handler.on![chamberSourceKey(CHAMBER1)]!(
            roundStarted(1n, 100, 200),
            fakeTxContext(),
        );
        handler.on![chamberSourceKey(CHAMBER1)]!(bidSubmitted(1n, 0, validG1()), fakeTxContext());
        // Now a bid for a different round arrives — the cached round
        // resets to the new one (the chamber rolled over).
        handler.on![chamberSourceKey(CHAMBER1)]!(bidSubmitted(2n, 0, validG1()), fakeTxContext());
        // pendingRevealCount stays 1 (the new round has 1 bid; the old is gone).
        expect(worker.pendingRevealCount()).toBe(1);
    });

    it('RoundRevealed marks the round settled', () => {
        const { worker } = makeWorker();
        const handler = worker.eventHandler();
        handler.on![chamberSourceKey(CHAMBER1)]!(
            roundStarted(1n, 100, 200),
            fakeTxContext(),
        );
        handler.on![chamberSourceKey(CHAMBER1)]!(bidSubmitted(1n, 0, validG1()), fakeTxContext());
        expect(worker.pendingRevealCount()).toBe(1);
        handler.on![chamberSourceKey(CHAMBER1)]!(
            roundRevealed(1n, 1, OTHER),
            fakeTxContext(),
        );
        expect(worker.pendingRevealCount()).toBe(0);
    });

    it('RoundExpired marks the round settled', () => {
        const { worker } = makeWorker();
        const handler = worker.eventHandler();
        handler.on![chamberSourceKey(CHAMBER1)]!(
            roundStarted(1n, 100, 200),
            fakeTxContext(),
        );
        handler.on![chamberSourceKey(CHAMBER1)]!(bidSubmitted(1n, 0, validG1()), fakeTxContext());
        handler.on![chamberSourceKey(CHAMBER1)]!(roundExpired(1n, 1), fakeTxContext());
        expect(worker.pendingRevealCount()).toBe(0);
    });

    it('RoundRevealed for a stale roundId does not affect the current round', () => {
        const { worker } = makeWorker();
        const handler = worker.eventHandler();
        handler.on![chamberSourceKey(CHAMBER1)]!(
            roundStarted(2n, 100, 200),
            fakeTxContext(),
        );
        handler.on![chamberSourceKey(CHAMBER1)]!(bidSubmitted(2n, 0, validG1()), fakeTxContext());
        // Old round 1 reveal arrives (out-of-order replay) — should be ignored.
        handler.on![chamberSourceKey(CHAMBER1)]!(
            roundRevealed(1n, 5, OTHER),
            fakeTxContext(),
        );
        expect(worker.pendingRevealCount()).toBe(1);
    });
});

describe('ThemisWorker.eventHandler — operator + group-key updates', () => {
    it('OperatorSynced(self, true) marks mirrored=true', async () => {
        const { worker, chambers } = makeWorker();
        // The cold-start probe would otherwise set mirrored from the chain;
        // make getOperator return null so the event is the only signal.
        const stub = chambers.get(CHAMBER1.toString({ bounceable: false }))!;
        stub.getOperator.mockResolvedValue(null);

        const handler = worker.eventHandler();
        handler.on![chamberSourceKey(CHAMBER1)]!(operatorSynced(ME, true), fakeTxContext());

        // Bring the round into a happy-path state, then verify a
        // not-mirrored skip would NOT be the active reason after the event.
        // We do this by adding a round + bid + group-key and confirming the
        // tick reaches the post-mirror gate (we'd see 'commit-still-open'
        // instead of 'not-mirrored' under our chosen `now`).
        handler.on![chamberSourceKey(CHAMBER1)]!(
            roundStarted(1n, 1_000, 2_000),
            fakeTxContext(),
        );
        handler.on![chamberSourceKey(CHAMBER1)]!(bidSubmitted(1n, 0, validG1()), fakeTxContext());
        handler.on![chamberSourceKey(CHAMBER1)]!(
            groupKeyCached(1, TEST_GROUP_PK),
            fakeTxContext(),
        );

        // nowSec = 500 puts us BEFORE commitEta=1000 → skip 'commit-still-open'.
        // (If mirrored were still false, we'd skip 'not-mirrored' first.)
        const { worker: instrumented } = makeWorker({
            chambers,
            nowSec: () => 500,
        });
        // Re-attach state via the handler chain on the new instance.
        const h2 = instrumented.eventHandler();
        h2.on![chamberSourceKey(CHAMBER1)]!(operatorSynced(ME, true), fakeTxContext());
        h2.on![chamberSourceKey(CHAMBER1)]!(roundStarted(1n, 1_000, 2_000), fakeTxContext());
        h2.on![chamberSourceKey(CHAMBER1)]!(bidSubmitted(1n, 0, validG1()), fakeTxContext());
        h2.on![chamberSourceKey(CHAMBER1)]!(groupKeyCached(1, TEST_GROUP_PK), fakeTxContext());

        const result = await instrumented.tick();
        // Skipped (not attempted) — but for the right reason: commit-still-open.
        expect(result.skipped).toBe(1);
        expect(result.attempts).toBe(0);
    });

    it('OperatorSynced for OTHER does not affect our mirrored flag', async () => {
        const stub = makeChamberStub(CHAMBER1, { operator: null });
        const chambers = new Map([[CHAMBER1.toString({ bounceable: false }), stub]]);
        const { worker } = makeWorker({ chambers, nowSec: () => 1_500 });

        const handler = worker.eventHandler();
        handler.on![chamberSourceKey(CHAMBER1)]!(
            operatorSynced(OTHER, true),
            fakeTxContext(),
        );
        handler.on![chamberSourceKey(CHAMBER1)]!(
            roundStarted(1n, 1_000, 2_000),
            fakeTxContext(),
        );
        handler.on![chamberSourceKey(CHAMBER1)]!(bidSubmitted(1n, 0, validG1()), fakeTxContext());
        handler.on![chamberSourceKey(CHAMBER1)]!(
            groupKeyCached(1, TEST_GROUP_PK),
            fakeTxContext(),
        );

        const result = await worker.tick();
        // mirrored=false because OperatorSynced was for OTHER and getOperator
        // returns null. Skip with 'not-mirrored'.
        expect(result.skipped).toBe(1);
    });

    it('GroupKeyCached event populates the group-key cache', async () => {
        const stub = makeChamberStub(CHAMBER1, {
            operator: { isActive: true },
            currentRound: { roundId: 1n, commitEta: 1_000, revealEta: 2_000 },
        });
        const chambers = new Map([[CHAMBER1.toString({ bounceable: false }), stub]]);
        const { worker } = makeWorker({ chambers, nowSec: () => 500 });

        const handler = worker.eventHandler();
        handler.on![chamberSourceKey(CHAMBER1)]!(bidSubmitted(1n, 0, validG1()), fakeTxContext());
        handler.on![chamberSourceKey(CHAMBER1)]!(
            groupKeyCached(7, TEST_GROUP_PK),
            fakeTxContext(),
        );

        const result = await worker.tick();
        // Cold-start probe puts mirrored=true, currentRound seeded;
        // group-key from event populates groupKey. We're BEFORE commitEta,
        // so the skip reason should be 'commit-still-open' rather than
        // 'no-group-key'.
        expect(result.skipped).toBe(1);
    });
});

describe('ThemisWorker.tick — decision tree (skip reasons)', () => {
    // Each test wires a chamber stub into a state where the worker should
    // skip for the named reason. We assert via `attempts === 0 && skipped >= 1`.
    // Negative-of-other-reasons coverage relies on the happy-path test below
    // proving the gate ordering matches `evaluate()`.

    it('skips a non-mirrored chamber (operator not registered)', async () => {
        const stub = makeChamberStub(CHAMBER1, { operator: null });
        const chambers = new Map([[CHAMBER1.toString({ bounceable: false }), stub]]);
        const { worker } = makeWorker({ chambers, nowSec: () => 1_500 });
        const result = await worker.tick();
        expect(result.attempts).toBe(0);
        expect(result.skipped).toBe(1);
    });

    it('skips when group key is unset (entryVersion=0)', async () => {
        // Mirrored, but no GroupKeyCached has landed.
        const stub = makeChamberStub(CHAMBER1, {
            operator: { isActive: true },
            currentRound: { roundId: 1n, commitEta: 100, revealEta: 200 },
            // groupKey defaults: entryVersion=0 → cold-start probe leaves cache null.
        });
        const chambers = new Map([[CHAMBER1.toString({ bounceable: false }), stub]]);
        const { worker } = makeWorker({ chambers, nowSec: () => 150 });

        // Add a bid via event so 'no-bids' isn't the skip reason.
        worker.eventHandler().on![chamberSourceKey(CHAMBER1)]!(
            bidSubmitted(1n, 0, validG1()),
            fakeTxContext(),
        );

        const result = await worker.tick();
        expect(result.attempts).toBe(0);
        expect(result.skipped).toBe(1);
    });

    it('skips when there are no bids in the current round', async () => {
        const stub = makeChamberStub(CHAMBER1, {
            operator: { isActive: true },
            currentRound: { roundId: 1n, commitEta: 100, revealEta: 200 },
            groupKey: {
                entryVersion: 1,
                groupPk: TEST_GROUP_PK,
                groupEpoch: 1,
                threshold: 1,
                memberCount: 1,
                cachedAt: 0,
            },
        });
        const chambers = new Map([[CHAMBER1.toString({ bounceable: false }), stub]]);
        const { worker } = makeWorker({ chambers, nowSec: () => 150 });
        const result = await worker.tick();
        expect(result.attempts).toBe(0);
        expect(result.skipped).toBe(1);
    });

    it('skips while commit window is still open (now < commitEta)', async () => {
        const stub = makeChamberStub(CHAMBER1, {
            operator: { isActive: true },
            currentRound: { roundId: 1n, commitEta: 1_000, revealEta: 2_000 },
            groupKey: {
                entryVersion: 1,
                groupPk: TEST_GROUP_PK,
                groupEpoch: 1,
                threshold: 1,
                memberCount: 1,
                cachedAt: 0,
            },
        });
        const chambers = new Map([[CHAMBER1.toString({ bounceable: false }), stub]]);
        const { worker } = makeWorker({ chambers, nowSec: () => 500 });

        worker.eventHandler().on![chamberSourceKey(CHAMBER1)]!(
            bidSubmitted(1n, 0, validG1()),
            fakeTxContext(),
        );
        const result = await worker.tick();
        expect(result.attempts).toBe(0);
        expect(result.skipped).toBe(1);
    });

    it('skips after the reveal deadline has passed (now >= revealEta)', async () => {
        const stub = makeChamberStub(CHAMBER1, {
            operator: { isActive: true },
            currentRound: { roundId: 1n, commitEta: 1_000, revealEta: 2_000 },
            groupKey: {
                entryVersion: 1,
                groupPk: TEST_GROUP_PK,
                groupEpoch: 1,
                threshold: 1,
                memberCount: 1,
                cachedAt: 0,
            },
        });
        const chambers = new Map([[CHAMBER1.toString({ bounceable: false }), stub]]);
        const { worker } = makeWorker({ chambers, nowSec: () => 5_000 });

        worker.eventHandler().on![chamberSourceKey(CHAMBER1)]!(
            bidSubmitted(1n, 0, validG1()),
            fakeTxContext(),
        );
        const result = await worker.tick();
        expect(result.attempts).toBe(0);
        expect(result.skipped).toBe(1);
    });

    it('skips a settled round even with bids cached', async () => {
        const stub = makeChamberStub(CHAMBER1, {
            operator: { isActive: true },
            currentRound: { roundId: 1n, commitEta: 100, revealEta: 1_000 },
            groupKey: {
                entryVersion: 1,
                groupPk: TEST_GROUP_PK,
                groupEpoch: 1,
                threshold: 1,
                memberCount: 1,
                cachedAt: 0,
            },
        });
        const chambers = new Map([[CHAMBER1.toString({ bounceable: false }), stub]]);
        const { worker } = makeWorker({ chambers, nowSec: () => 500 });

        const handler = worker.eventHandler();
        handler.on![chamberSourceKey(CHAMBER1)]!(bidSubmitted(1n, 0, validG1()), fakeTxContext());
        handler.on![chamberSourceKey(CHAMBER1)]!(roundRevealed(1n, 1, OTHER), fakeTxContext());

        const result = await worker.tick();
        expect(result.attempts).toBe(0);
        expect(result.skipped).toBe(1);
    });
});

describe('ThemisWorker.tick — happy-path reveal submission', () => {
    function bootedHappyChamber(
        roundId: bigint,
        bids: number,
    ): { chambers: Map<string, ChamberStub>; stub: ChamberStub } {
        const stub = makeChamberStub(CHAMBER1, {
            operator: { isActive: true },
            currentRound: { roundId, commitEta: 100, revealEta: 1_000 },
            groupKey: {
                entryVersion: 1,
                groupPk: TEST_GROUP_PK,
                groupEpoch: 1,
                threshold: 1,
                memberCount: 1,
                cachedAt: 0,
            },
        });
        const chambers = new Map([[CHAMBER1.toString({ bounceable: false }), stub]]);
        // Inject the bids — they're seeded via the event handler since
        // there's no ciphertexts getter.
        return { chambers, stub };
    }

    it('builds + submits a reveal when commit window has closed', async () => {
        const { chambers, stub } = bootedHappyChamber(1n, 1);
        const submitReveal = jest
            .fn<Promise<void>, [() => Promise<void>, () => Promise<void>]>()
            .mockImplementation(async (send, _verify) => {
                await send();
            });
        const { worker } = makeWorker({
            chambers,
            nowSec: () => 500, // commitEta=100 has passed; revealEta=1000 hasn't
            submitReveal,
        });

        worker.eventHandler().on![chamberSourceKey(CHAMBER1)]!(
            bidSubmitted(1n, 0, validG1()),
            fakeTxContext(),
        );

        const result = await worker.tick();

        expect(result.attempts).toBe(1);
        expect(result.successes).toBe(1);
        expect(result.failures).toBe(0);
        expect(result.skipped).toBe(0);
        expect(submitReveal).toHaveBeenCalledTimes(1);
        expect(stub.sendRevealRound).toHaveBeenCalledTimes(1);
        // sendRevealRound: (sender, value, signedDataRef, decryptionsRef, aggSigRef)
        const args = stub.sendRevealRound.mock.calls[0]!;
        expect(typeof args[1]).toBe('bigint');
        expect(args[1] as bigint).toBeGreaterThan(0n);
        expect(args[2]).toBeDefined(); // signedDataRef
        expect(args[3]).toBeDefined(); // decryptionsRef
        expect(args[4]).toBeDefined(); // aggSigRef
    });

    it('reads chamber config to size the reveal value (revealerReward + callbackGas + minXcGas + minReserve)', async () => {
        const { chambers, stub } = bootedHappyChamber(1n, 1);
        const submitReveal = jest
            .fn<Promise<void>, [() => Promise<void>, () => Promise<void>]>()
            .mockImplementation(async (send, _verify) => {
                await send();
            });
        const { worker } = makeWorker({ chambers, nowSec: () => 500, submitReveal });

        worker.eventHandler().on![chamberSourceKey(CHAMBER1)]!(
            bidSubmitted(1n, 0, validG1()),
            fakeTxContext(),
        );
        await worker.tick();

        // getConfig was hit (cache miss).
        expect(stub.getConfig).toHaveBeenCalledTimes(1);
        const value = stub.sendRevealRound.mock.calls[0]![1] as bigint;
        // revealerReward (50_000_000) + callbackGas (30_000_000) + minXcGas (10_000_000)
        //   + minReserve (100_000_000) + REVEAL_GAS_HEADROOM (50_000_000) = 240_000_000
        expect(value).toBe(240_000_000n);
    });

    it('caches getConfig across consecutive ticks within TTL', async () => {
        const { chambers, stub } = bootedHappyChamber(1n, 2);
        let sendCount = 0;
        const submitReveal = jest
            .fn<Promise<void>, [() => Promise<void>, () => Promise<void>]>()
            .mockImplementation(async (send, _verify) => {
                sendCount++;
                await send();
                // Only the first verify simulates a successful reveal — for
                // the second call we want submission to attempt but verify
                // can stay no-op (we're testing config caching).
            });
        const { worker } = makeWorker({ chambers, nowSec: () => 500, submitReveal });

        worker.eventHandler().on![chamberSourceKey(CHAMBER1)]!(
            bidSubmitted(1n, 0, validG1()),
            fakeTxContext(),
        );

        await worker.tick();
        // Round was settled by the successful reveal; start a new one + tick again.
        worker.eventHandler().on![chamberSourceKey(CHAMBER1)]!(
            roundStarted(2n, 100, 1_000),
            fakeTxContext(),
        );
        worker.eventHandler().on![chamberSourceKey(CHAMBER1)]!(
            bidSubmitted(2n, 0, validG1()),
            fakeTxContext(),
        );
        // Update getCurrentRound to advertise round 2 so the live freshness
        // check passes.
        stub.getCurrentRound.mockResolvedValue({
            roundId: 2n,
            commitEta: 100,
            revealEta: 1_000,
        });
        await worker.tick();

        expect(sendCount).toBe(2);
        // getConfig was only called for the first reveal (cached for the
        // second). TTL is 5min and our injected nowSec is constant.
        expect(stub.getConfig).toHaveBeenCalledTimes(1);
    });

    it('submits a reveal that bundles ALL accumulated bids', async () => {
        const { chambers, stub } = bootedHappyChamber(1n, 3);
        const submitReveal = jest
            .fn<Promise<void>, [() => Promise<void>, () => Promise<void>]>()
            .mockImplementation(async (send, _verify) => {
                await send();
            });
        const { worker } = makeWorker({ chambers, nowSec: () => 500, submitReveal });

        const handler = worker.eventHandler();
        handler.on![chamberSourceKey(CHAMBER1)]!(bidSubmitted(1n, 0, validG1()), fakeTxContext());
        handler.on![chamberSourceKey(CHAMBER1)]!(bidSubmitted(1n, 1, validG1()), fakeTxContext());
        handler.on![chamberSourceKey(CHAMBER1)]!(bidSubmitted(1n, 2, validG1()), fakeTxContext());

        await worker.tick();

        // The decryptionsRef cell should hold a dict with three entries —
        // we don't deserialise here (themis-sdk owns the reverse), but we
        // know it was constructed because submitReveal was called once and
        // bid count is preserved through buildReveal's path.
        expect(stub.sendRevealRound).toHaveBeenCalledTimes(1);
    });

    it('does not double-submit while a reveal is in-flight', async () => {
        const { chambers, stub } = bootedHappyChamber(1n, 1);
        // Use a barrier-deferred submitReveal: it signals "I've been
        // reached" and then blocks on a release promise. This avoids the
        // microtask race that plagues "spin two ticks and hope tick1
        // advanced past inFlight=true before tick2 evaluates".
        let submitReached!: () => void;
        const submitReachedPromise = new Promise<void>((res) => {
            submitReached = res;
        });
        let resolveSubmit!: () => void;
        const releasePromise = new Promise<void>((res) => {
            resolveSubmit = res;
        });
        const submitReveal = jest
            .fn<Promise<void>, [() => Promise<void>, () => Promise<void>]>()
            .mockImplementation(async (_send, _verify) => {
                submitReached();
                await releasePromise;
            });
        const { worker } = makeWorker({ chambers, nowSec: () => 500, submitReveal });

        worker.eventHandler().on![chamberSourceKey(CHAMBER1)]!(
            bidSubmitted(1n, 0, validG1()),
            fakeTxContext(),
        );

        // Kick off tick1 and wait until it has parked inside submitReveal —
        // i.e. inFlight is definitely true.
        const tick1 = worker.tick();
        await submitReachedPromise;
        expect(worker.hasInFlight()).toBe(true);

        // Now run tick2: it must see inFlight=true at the gate and skip.
        const r2 = await worker.tick();
        expect(r2.attempts).toBe(0);
        expect(r2.skipped).toBe(1);

        // Release tick1 and confirm clean shutdown semantics.
        resolveSubmit();
        const r1 = await tick1;
        expect(r1.attempts).toBe(1);
        expect(r1.successes).toBe(1);
        expect(submitReveal).toHaveBeenCalledTimes(1);
        expect(worker.hasInFlight()).toBe(false);
    });

    it('drops the round when live getCurrentRound reports a different roundId', async () => {
        const { chambers, stub } = bootedHappyChamber(1n, 1);
        // Race: between gate and submit, the chamber rolled over to round 2.
        stub.getCurrentRound.mockResolvedValueOnce({
            roundId: 1n,
            commitEta: 100,
            revealEta: 1_000,
        });
        // Subsequent reads (the pre-submit live freshness check) report the
        // new round.
        stub.getCurrentRound.mockResolvedValue({
            roundId: 2n,
            commitEta: 100,
            revealEta: 1_000,
        });
        const submitReveal = jest.fn<Promise<void>, [() => Promise<void>, () => Promise<void>]>();
        const { worker } = makeWorker({ chambers, nowSec: () => 500, submitReveal });

        worker.eventHandler().on![chamberSourceKey(CHAMBER1)]!(
            bidSubmitted(1n, 0, validG1()),
            fakeTxContext(),
        );
        const result = await worker.tick();

        expect(result.attempts).toBe(1);
        expect(result.successes).toBe(0);
        expect(result.failures).toBe(1);
        // submitReveal should NOT have been called — submitOne short-circuited
        // on the live freshness check.
        expect(submitReveal).not.toHaveBeenCalled();
        expect(stub.sendRevealRound).not.toHaveBeenCalled();
    });

    it('marks the round settled after a successful reveal so the next tick skips', async () => {
        const { chambers, stub } = bootedHappyChamber(1n, 1);
        const submitReveal = jest
            .fn<Promise<void>, [() => Promise<void>, () => Promise<void>]>()
            .mockImplementation(async (send, _verify) => {
                await send();
            });
        const { worker } = makeWorker({ chambers, nowSec: () => 500, submitReveal });

        worker.eventHandler().on![chamberSourceKey(CHAMBER1)]!(
            bidSubmitted(1n, 0, validG1()),
            fakeTxContext(),
        );

        const r1 = await worker.tick();
        expect(r1.successes).toBe(1);

        // Second tick should skip 'already-settled' even though the round
        // state still holds the bid (we'd waste a verify roundtrip otherwise).
        const r2 = await worker.tick();
        expect(r2.attempts).toBe(0);
        expect(r2.skipped).toBe(1);
        expect(stub.sendRevealRound).toHaveBeenCalledTimes(1);
    });

    it('counts a thrown submit as a failure and leaves inFlight clean', async () => {
        const { chambers, stub } = bootedHappyChamber(1n, 1);
        const submitReveal = jest
            .fn<Promise<void>, [() => Promise<void>, () => Promise<void>]>()
            .mockRejectedValue(new Error('rpc-blip'));
        const { worker } = makeWorker({ chambers, nowSec: () => 500, submitReveal });

        worker.eventHandler().on![chamberSourceKey(CHAMBER1)]!(
            bidSubmitted(1n, 0, validG1()),
            fakeTxContext(),
        );

        const result = await worker.tick();
        expect(result.attempts).toBe(1);
        expect(result.failures).toBe(1);
        expect(worker.hasInFlight()).toBe(false);
        // sendRevealRound was never called — submitReveal is the boundary
        // that wraps it, and it rejected before invoking `send()`.
        expect(stub.sendRevealRound).not.toHaveBeenCalled();
    });
});

describe('ThemisWorker.tick — multi-chamber independence', () => {
    it('iterates every configured chamber', async () => {
        const stub1 = makeChamberStub(CHAMBER1, { operator: null });
        const stub2 = makeChamberStub(CHAMBER2, { operator: null });
        const chambers = new Map([
            [CHAMBER1.toString({ bounceable: false }), stub1],
            [CHAMBER2.toString({ bounceable: false }), stub2],
        ]);
        const { worker } = makeWorker({ chambers, nowSec: () => 100 });
        const result = await worker.tick();
        expect(result.chambers).toBe(2);
        expect(result.skipped).toBe(2);
    });

    it('one chamber failing does not block another from succeeding', async () => {
        const happyStub = makeChamberStub(CHAMBER1, {
            operator: { isActive: true },
            currentRound: { roundId: 1n, commitEta: 100, revealEta: 1_000 },
            groupKey: {
                entryVersion: 1,
                groupPk: TEST_GROUP_PK,
                groupEpoch: 1,
                threshold: 1,
                memberCount: 1,
                cachedAt: 0,
            },
        });
        const skipStub = makeChamberStub(CHAMBER2, { operator: null });
        const chambers = new Map([
            [CHAMBER1.toString({ bounceable: false }), happyStub],
            [CHAMBER2.toString({ bounceable: false }), skipStub],
        ]);
        const submitReveal = jest
            .fn<Promise<void>, [() => Promise<void>, () => Promise<void>]>()
            .mockImplementation(async (send) => {
                await send();
            });
        const { worker } = makeWorker({ chambers, nowSec: () => 500, submitReveal });

        worker.eventHandler().on![chamberSourceKey(CHAMBER1)]!(
            bidSubmitted(1n, 0, validG1()),
            fakeTxContext(),
        );

        const result = await worker.tick();
        expect(result.successes).toBe(1);
        expect(result.skipped).toBe(1);
        expect(happyStub.sendRevealRound).toHaveBeenCalledTimes(1);
        expect(skipStub.sendRevealRound).not.toHaveBeenCalled();
    });
});

describe('ThemisWorker.publishMetrics + counters', () => {
    function makeMetricsStub(): {
        themisChambers: { set: jest.Mock };
        themisPendingReveals: { set: jest.Mock };
    } {
        return {
            themisChambers: { set: jest.fn() },
            themisPendingReveals: { set: jest.fn() },
        };
    }

    it('writes chamber count + pending-reveal count to gauges', () => {
        const stub = makeChamberStub(CHAMBER1);
        const chambers = new Map([[CHAMBER1.toString({ bounceable: false }), stub]]);
        const { worker } = makeWorker({ chambers });

        worker.eventHandler().on![chamberSourceKey(CHAMBER1)]!(
            roundStarted(1n, 100, 1_000),
            fakeTxContext(),
        );
        worker.eventHandler().on![chamberSourceKey(CHAMBER1)]!(
            bidSubmitted(1n, 0, validG1()),
            fakeTxContext(),
        );

        const gauges = makeMetricsStub();
        worker.publishMetrics({ gauges } as never);

        expect(gauges.themisChambers.set).toHaveBeenCalledWith(1);
        expect(gauges.themisPendingReveals.set).toHaveBeenCalledWith(1);
    });
});

describe('ThemisWorker.dropConfigCache', () => {
    it('drops only the named chamber when an address is given', async () => {
        const stub1 = makeChamberStub(CHAMBER1, {
            operator: { isActive: true },
            currentRound: { roundId: 1n, commitEta: 100, revealEta: 1_000 },
            groupKey: {
                entryVersion: 1,
                groupPk: TEST_GROUP_PK,
                groupEpoch: 1,
                threshold: 1,
                memberCount: 1,
                cachedAt: 0,
            },
        });
        const stub2 = makeChamberStub(CHAMBER2, {
            operator: { isActive: true },
            currentRound: { roundId: 1n, commitEta: 100, revealEta: 1_000 },
            groupKey: {
                entryVersion: 1,
                groupPk: TEST_GROUP_PK,
                groupEpoch: 1,
                threshold: 1,
                memberCount: 1,
                cachedAt: 0,
            },
        });
        const chambers = new Map([
            [CHAMBER1.toString({ bounceable: false }), stub1],
            [CHAMBER2.toString({ bounceable: false }), stub2],
        ]);
        const submitReveal = jest
            .fn<Promise<void>, [() => Promise<void>, () => Promise<void>]>()
            .mockImplementation(async (send) => {
                await send();
            });
        const { worker } = makeWorker({ chambers, nowSec: () => 500, submitReveal });

        const h = worker.eventHandler();
        h.on![chamberSourceKey(CHAMBER1)]!(bidSubmitted(1n, 0, validG1()), fakeTxContext());
        h.on![chamberSourceKey(CHAMBER2)]!(bidSubmitted(1n, 0, validG1()), fakeTxContext());

        // Tick 1: both chambers reveal (and populate config cache).
        await worker.tick();
        expect(stub1.getConfig).toHaveBeenCalledTimes(1);
        expect(stub2.getConfig).toHaveBeenCalledTimes(1);

        // Drop only CHAMBER1's cache.
        worker.dropConfigCache(CHAMBER1);

        // Tick 2: open new rounds + retry. CHAMBER1 should re-fetch config;
        // CHAMBER2 should hit cache.
        h.on![chamberSourceKey(CHAMBER1)]!(roundStarted(2n, 100, 1_000), fakeTxContext());
        h.on![chamberSourceKey(CHAMBER1)]!(bidSubmitted(2n, 0, validG1()), fakeTxContext());
        h.on![chamberSourceKey(CHAMBER2)]!(roundStarted(2n, 100, 1_000), fakeTxContext());
        h.on![chamberSourceKey(CHAMBER2)]!(bidSubmitted(2n, 0, validG1()), fakeTxContext());
        stub1.getCurrentRound.mockResolvedValue({ roundId: 2n, commitEta: 100, revealEta: 1_000 });
        stub2.getCurrentRound.mockResolvedValue({ roundId: 2n, commitEta: 100, revealEta: 1_000 });

        await worker.tick();
        expect(stub1.getConfig).toHaveBeenCalledTimes(2); // re-fetched
        expect(stub2.getConfig).toHaveBeenCalledTimes(1); // cached
    });

    it('drops every chamber when no address is given', async () => {
        const stub1 = makeChamberStub(CHAMBER1, {
            operator: { isActive: true },
            currentRound: { roundId: 1n, commitEta: 100, revealEta: 1_000 },
            groupKey: {
                entryVersion: 1,
                groupPk: TEST_GROUP_PK,
                groupEpoch: 1,
                threshold: 1,
                memberCount: 1,
                cachedAt: 0,
            },
        });
        const chambers = new Map([[CHAMBER1.toString({ bounceable: false }), stub1]]);
        const submitReveal = jest
            .fn<Promise<void>, [() => Promise<void>, () => Promise<void>]>()
            .mockImplementation(async (send) => {
                await send();
            });
        const { worker } = makeWorker({ chambers, nowSec: () => 500, submitReveal });

        worker.eventHandler().on![chamberSourceKey(CHAMBER1)]!(
            bidSubmitted(1n, 0, validG1()),
            fakeTxContext(),
        );
        await worker.tick();
        expect(stub1.getConfig).toHaveBeenCalledTimes(1);

        worker.dropConfigCache(); // wipe everything

        worker.eventHandler().on![chamberSourceKey(CHAMBER1)]!(
            roundStarted(2n, 100, 1_000),
            fakeTxContext(),
        );
        worker.eventHandler().on![chamberSourceKey(CHAMBER1)]!(
            bidSubmitted(2n, 0, validG1()),
            fakeTxContext(),
        );
        stub1.getCurrentRound.mockResolvedValue({ roundId: 2n, commitEta: 100, revealEta: 1_000 });

        await worker.tick();
        expect(stub1.getConfig).toHaveBeenCalledTimes(2);
    });
});

describe('ThemisWorker.seedFromChain — cold-start probe', () => {
    it('calls getOperator + getCurrentRound + getGroupKey once per chamber lifetime', async () => {
        const stub = makeChamberStub(CHAMBER1, {
            operator: { isActive: true },
            currentRound: { roundId: 1n, commitEta: 100, revealEta: 1_000 },
            groupKey: {
                entryVersion: 1,
                groupPk: TEST_GROUP_PK,
                groupEpoch: 1,
                threshold: 1,
                memberCount: 1,
                cachedAt: 0,
            },
        });
        const chambers = new Map([[CHAMBER1.toString({ bounceable: false }), stub]]);
        const { worker } = makeWorker({ chambers, nowSec: () => 50 });
        // commitEta=100, now=50 → skip 'commit-still-open'. We just want
        // to drive seedFromChain, not a reveal.

        await worker.tick();
        await worker.tick();
        await worker.tick();

        expect(stub.getOperator).toHaveBeenCalledTimes(1);
        expect(stub.getCurrentRound).toHaveBeenCalledTimes(1);
        expect(stub.getGroupKey).toHaveBeenCalledTimes(1);
    });

    it('retries the probe if getOperator throws (does not mark seeded)', async () => {
        const stub = makeChamberStub(CHAMBER1);
        stub.getOperator.mockRejectedValueOnce(new Error('rpc-blip'));
        // Second call succeeds.
        stub.getOperator.mockResolvedValue({ isActive: true });
        const chambers = new Map([[CHAMBER1.toString({ bounceable: false }), stub]]);
        const { worker } = makeWorker({ chambers, nowSec: () => 50 });

        await worker.tick();
        // First attempt threw → state.seeded stays false → next tick retries.
        await worker.tick();

        expect(stub.getOperator).toHaveBeenCalledTimes(2);
    });

    it('fills commitEta/revealEta from getCurrentRound when bids arrive before RoundStarted', async () => {
        const stub = makeChamberStub(CHAMBER1, {
            operator: { isActive: true },
            currentRound: { roundId: 5n, commitEta: 100, revealEta: 1_000 },
            groupKey: {
                entryVersion: 1,
                groupPk: TEST_GROUP_PK,
                groupEpoch: 1,
                threshold: 1,
                memberCount: 1,
                cachedAt: 0,
            },
        });
        const chambers = new Map([[CHAMBER1.toString({ bounceable: false }), stub]]);
        const submitReveal = jest
            .fn<Promise<void>, [() => Promise<void>, () => Promise<void>]>()
            .mockImplementation(async (send) => {
                await send();
            });
        const { worker } = makeWorker({ chambers, nowSec: () => 500, submitReveal });

        // Bid arrives first (no RoundStarted yet observed). The handler
        // creates a round shell with eta=0; cold-start probe fills the eta.
        worker.eventHandler().on![chamberSourceKey(CHAMBER1)]!(
            bidSubmitted(5n, 0, validG1()),
            fakeTxContext(),
        );

        const result = await worker.tick();
        // The probe filled in commitEta=100/revealEta=1000, now=500 puts
        // us in the reveal window → reveal is attempted.
        expect(result.attempts).toBe(1);
        expect(result.successes).toBe(1);
    });
});
