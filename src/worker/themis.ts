// Themis sealed-bid threshold-decryption worker — Phase-3 parallel to
// Kronos's worker/loop.ts and Fortuna's worker/fortuna.ts.
//
// Responsibility: per configured chamber, observe round + bid lifecycle
// events, threshold-decrypt the cached bids when the commit window
// closes, BLS-sign the reveal payload, and submit `RevealRound` before
// the reveal deadline elapses.
//
// Operating model (v1 — solo-mode only):
//
//   Atlas's group is t=1, n=1: the operator's BLS secret IS the group
//   secret. `D_j = sk · c1_j` is computed locally; the BLS signature
//   over the signed-reveal slice is the aggregate. Multi-op
//   (threshold-additive `t = n` with peer share-exchange) is the v1.1
//   extension and mirrors the FortunaWorker's multi-op path. Until then
//   we keep the wire shape identical so the contract code is one branch.
//
// Per-chamber state model:
//
//   The factory deploys multiple chambers (one per consumer protocol).
//   Each chamber has its own round lifecycle. The operator opts into
//   specific chambers via `config.themis.chambers` — auto-discovery
//   from the factory's `ChamberDeployed` events is a v1.1 follow-up.
//   For each tracked chamber, the worker maintains (`ChamberState`):
//
//     - round       : per-round bag (roundId / commitEta / revealEta /
//                     bids / inFlight / settled), null until known
//     - groupKey    : { pk, epoch } — refreshed from chamber's
//                     getGroupKey getter or GroupKeyCached events
//     - mirrored    : true once we've seen our own OperatorSynced or
//                     confirmed via getOperator getter
//     - seeded      : cold-start probe done (avoid re-querying every tick)
//
// Cross-restart discipline:
//
//   Round + bid state is in-memory only. On daemon restart, the event
//   drain replays from the checkpoint and reconstructs (the drain
//   default of 500 txs back is enough for typical chamber activity
//   levels). Bids submitted BEFORE the checkpoint that we haven't
//   yet seen are silently lost — we'd skip the reveal for the round
//   they belong to and the chamber's `AdvanceRound` permissionless
//   refund path would kick in. The cure is to widen the drain window
//   on restart (future work).
//
// Why this is a separate file from products/themis.ts:
//
//   Same separation as `worker/fortuna.ts` ↔ `products/fortuna.ts` and
//   `worker/loop.ts` ↔ `products/kronos.ts`. The worker file owns the
//   per-cycle behaviour; the product file owns the static wiring
//   (resolveAddresses, eventStreams, buildHandlers, etc).

import { Address, type OpenedContract, type Sender } from '@ton/core';
import {
    ThemisChamber,
    buildReveal,
    groupDecrypt,
    type ThemisEvent,
} from '@titon-network/themis-sdk';
import type { EventHandler, TxContext } from './events';
import type { WorkerLogger } from './loop';
import type { AutomatonWallet } from '../wallet';
import type { FailoverTonClient } from '../chain/ton-client';
import type { DaemonMetrics } from '../daemon/metrics';
import { sendAndConfirm, senderFor } from '../chain';

/** Source-key prefix for chamber event streams. The full source key is
 *  `themis-chamber:<address>` so multi-chamber operators get one entry
 *  per chamber in `drainDispatched` / checkpoint state. */
export const THEMIS_CHAMBER_SOURCE_PREFIX = 'themis-chamber' as const;

/** Source key for the factory's external-out event stream. */
export const THEMIS_FACTORY_SOURCE = 'themis-factory' as const;

/** Address-bag key prefix used by the themis ProductModule when surfacing
 *  per-chamber addresses + opened contracts. Distinct from the source-key
 *  prefix so each lives in a single namespace (the address bag is product-
 *  scoped; source keys are global across products). */
export const THEMIS_CHAMBER_ADDR_KEY_PREFIX = 'chamber:' as const;

/** Build the per-chamber source key from the chamber address. */
export function chamberSourceKey(addr: Address): string {
    return `${THEMIS_CHAMBER_SOURCE_PREFIX}:${addr.toString({ bounceable: false })}`;
}

/** Build the per-chamber address-bag / contracts-bag key from the chamber
 *  address. Used by the themis ProductModule's resolveAddresses /
 *  openContracts / schemaChecks / bootstrapWorker iteration. */
export function themisChamberAddrKey(addr: Address): string {
    return `${THEMIS_CHAMBER_ADDR_KEY_PREFIX}${addr.toString({ bounceable: false })}`;
}

/** True if the address-bag key belongs to a chamber (vs atlas/factory/forgeton). */
export function isThemisChamberKey(key: string): boolean {
    return key.startsWith(THEMIS_CHAMBER_ADDR_KEY_PREFIX);
}

/**
 * One operator-tracked round of one chamber. Mutated as events land;
 * cleared on RoundRevealed / RoundExpired.
 */
interface ChamberRoundState {
    roundId: bigint;
    commitEta: number;
    revealEta: number;
    /** Bids accumulated from BidSubmitted events: idx → c1 (48 bytes G1). */
    bids: Map<number, Buffer>;
    /** True between `submitOne` start and finish — gates double-submission. */
    inFlight: boolean;
    /** True after we observed RoundRevealed or RoundExpired for this round. */
    settled: boolean;
}

/** Per-chamber tracked state. Lazy-initialised on the first relevant event
 *  or on the first tick that touches the chamber. */
interface ChamberState {
    address: Address;
    /** Currently-open round, if known. Null until a RoundStarted event lands
     *  or a successful getCurrentRound seeds it. */
    round: ChamberRoundState | null;
    /** Cached group-key entry (epoch + 48-byte G1 pk). Null until known. */
    groupKey: { epoch: number; pk: Buffer; pkG2: Buffer } | null;
    /** True once we've confirmed this operator is mirrored and active.
     *  Refreshed on OperatorSynced events naming us; cold-start fallback
     *  reads `getOperator(self)` lazily. */
    mirrored: boolean;
    /** Cold-start probe done: avoid re-querying getOperator/getCurrentRound
     *  every tick. */
    seeded: boolean;
}

/** Constructor for a fresh round-state bag. Centralised so every code path
 *  (event handler lazy-init, RoundStarted reset, cold-start probe) emits
 *  the same shape. */
function freshRound(
    roundId: bigint,
    commitEta: number,
    revealEta: number,
): ChamberRoundState {
    return {
        roundId,
        commitEta,
        revealEta,
        bids: new Map(),
        inFlight: false,
        settled: false,
    };
}

export interface ThemisWorkerCounters {
    incrementRevealAttempt(): void;
    incrementRevealSuccess(): void;
    incrementRevealFailure(reason: string): void;
    incrementRevealSkip(reason: string): void;
}

export const NOOP_THEMIS_COUNTERS: ThemisWorkerCounters = {
    incrementRevealAttempt: () => undefined,
    incrementRevealSuccess: () => undefined,
    incrementRevealFailure: () => undefined,
    incrementRevealSkip: () => undefined,
};

export interface ThemisWorkerDeps {
    /** Open chambers — keyed by address `toString({ bounceable: false })`.
     *  Constructed by the themis ProductModule from `config.themis.chambers`.
     *  Empty when no chambers configured (worker becomes a no-op). */
    chambers: Map<string, OpenedContract<ThemisChamber>>;
    client: FailoverTonClient;
    wallet: AutomatonWallet;
    /** 32-byte BLS12-381 secret key (big-endian). In solo-mode this IS
     *  the group secret. Same key as the Fortuna worker uses. */
    blsSecret: Buffer;
    logger: WorkerLogger;
    counters?: ThemisWorkerCounters;
    /** Injected clock — sandbox tests override with `() => blockchain.now`. */
    nowSec?: () => number;
    /** Injected `Sender` — production builds one via `senderFor(client, wallet)`. */
    sender?: Sender;
    /** Injected sendAndConfirm wrapper — sandbox callers override to bypass
     *  the wallet seqno-poll path. Mirrors KronosWorker.submitExecute and
     *  FortunaWorker.submitFulfill. */
    submitReveal?: (send: () => Promise<void>, verify: () => Promise<void>) => Promise<void>;
}

const DEFAULT_CLOCK = (): number => Math.floor(Date.now() / 1000);

// Reveal-tx value: covers the chamber's revealerReward payout to us
// PLUS the consumer-callback gas + outbound fwd. We size from the
// chamber's getConfig at first reveal and cache for the same TTL as
// the FortunaWorker uses (5 min). Per-chamber to handle different
// tunables at different chambers.
const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;
const REVEAL_GAS_HEADROOM = 50_000_000n; // 0.05 TON over the chamber-derived floor

interface ChamberConfigCache {
    revealerReward: bigint;
    callbackGas: bigint;
    minXcGas: bigint;
    minReserve: bigint;
    fetchedAt: number;
}

export class ThemisWorker {
    private readonly deps: ThemisWorkerDeps;
    private readonly counters: ThemisWorkerCounters;
    private readonly nowSec: () => number;
    private readonly sender: Sender;

    /** chamberKey → in-memory state. Keyed by UQ-form address string for
     *  stable identity across decoder/event boundaries. */
    private readonly states = new Map<string, ChamberState>();
    /** Per-chamber config cache (TTL'd). */
    private readonly configCache = new Map<string, ChamberConfigCache>();

    constructor(deps: ThemisWorkerDeps) {
        if (deps.blsSecret.length !== 32) {
            throw new Error(`BLS secret must be 32 bytes, got ${deps.blsSecret.length}`);
        }
        this.deps = deps;
        this.counters = deps.counters ?? NOOP_THEMIS_COUNTERS;
        this.nowSec = deps.nowSec ?? DEFAULT_CLOCK;
        this.sender = deps.sender ?? senderFor(deps.client, deps.wallet);

        // Pre-seed state placeholders so the tick loop has a stable iteration
        // set even before any events have landed for a given chamber.
        for (const [key, contract] of deps.chambers) {
            this.states.set(key, {
                address: contract.address,
                round: null,
                groupKey: null,
                mirrored: false,
                seeded: false,
            });
        }
    }

    /** Number of chambers being tracked. */
    chamberCount(): number {
        return this.states.size;
    }

    /** Number of rounds with bids actively waiting to be revealed. Useful
     *  as a gauge to surface "operator has work pending". */
    pendingRevealCount(): number {
        let n = 0;
        for (const s of this.states.values()) {
            if (s.round !== null && !s.round.settled && s.round.bids.size > 0) n++;
        }
        return n;
    }

    /** True iff there are reveal submissions in-flight. Orchestrator's
     *  shutdown drain waits on this so SIGTERM doesn't abandon a half-sent
     *  RevealRound message. */
    hasInFlight(): boolean {
        for (const s of this.states.values()) {
            if (s.round?.inFlight) return true;
        }
        return false;
    }

    /** Push current state to gauges — called by the orchestrator after
     *  each tick. */
    publishMetrics(metrics: DaemonMetrics): void {
        if (metrics.gauges.themisChambers !== undefined) {
            metrics.gauges.themisChambers.set(this.states.size);
        }
        if (metrics.gauges.themisPendingReveals !== undefined) {
            metrics.gauges.themisPendingReveals.set(this.pendingRevealCount());
        }
    }

    /** Event handler that keeps per-chamber round/bid state in sync. The
     *  source key for each chamber is `chamberSourceKey(addr)` so the
     *  drain dispatches per-chamber events to this handler's per-chamber
     *  callbacks. */
    eventHandler(): EventHandler {
        const me = this.deps.wallet.address;
        const logger = this.deps.logger;
        const on: EventHandler['on'] = {};
        for (const [key, contract] of this.deps.chambers) {
            const chamberKey = key;
            const chamberAddr = contract.address;
            on[chamberSourceKey(chamberAddr)] = (event: ThemisEvent, ctx: TxContext) => {
                const state = this.states.get(chamberKey);
                if (state === undefined) return;
                this.dispatchChamberEvent(state, event, ctx, me, logger);
            };
        }
        return { on };
    }

    /**
     * Apply one chamber-emitted event to in-memory state. Pure dispatch:
     * no I/O, no submits — that happens in `tick()`.
     */
    private dispatchChamberEvent(
        state: ChamberState,
        event: ThemisEvent,
        ctx: TxContext,
        me: Address,
        logger: WorkerLogger,
    ): void {
        switch (event.kind) {
            case 'RoundStarted': {
                // Reset any stale round we were carrying (idempotent if the
                // checkpoint replays this).
                state.round = freshRound(event.roundId, event.commitEta, event.revealEta);
                logger.info('themis: round started', {
                    chamber: state.address.toString(),
                    roundId: event.roundId.toString(),
                    commitEta: event.commitEta,
                    revealEta: event.revealEta,
                });
                break;
            }
            case 'BidSubmitted': {
                // Bids may arrive before RoundStarted (chain emits RoundStarted
                // first, but on cold start the drain window may not reach back
                // far enough to include it). We also handle the chamber rolling
                // over to a new roundId — wipe the cache and start fresh.
                // commitEta/revealEta = 0 here means "unknown"; the cold-start
                // probe will fill them in via getCurrentRound on the next tick.
                if (state.round === null || state.round.roundId !== event.roundId) {
                    state.round = freshRound(event.roundId, 0, 0);
                }
                state.round.bids.set(event.idx, event.c1);
                logger.debug('themis: bid observed', {
                    chamber: state.address.toString(),
                    roundId: event.roundId.toString(),
                    idx: event.idx,
                    sender: event.sender.toString(),
                });
                break;
            }
            case 'RoundRevealed': {
                if (state.round !== null && state.round.roundId === event.roundId) {
                    state.round.settled = true;
                }
                const weWon = event.revealer.equals(me);
                logger.info('themis: round revealed', {
                    chamber: state.address.toString(),
                    roundId: event.roundId.toString(),
                    bidCount: event.bidCount,
                    revealer: event.revealer.toString(),
                    reward: event.reward.toString(),
                    weWon,
                    txHash: ctx.txHash,
                });
                break;
            }
            case 'RoundExpired': {
                if (state.round !== null && state.round.roundId === event.roundId) {
                    state.round.settled = true;
                }
                logger.warn('themis: round expired without reveal — bidders refunded', {
                    chamber: state.address.toString(),
                    roundId: event.roundId.toString(),
                    bidCount: event.bidCount,
                    txHash: ctx.txHash,
                });
                break;
            }
            case 'OperatorSynced': {
                if (event.automaton.equals(me)) {
                    state.mirrored = event.isActive;
                    logger.info('themis: operator-mirror updated for self', {
                        chamber: state.address.toString(),
                        isActive: event.isActive,
                        txHash: ctx.txHash,
                    });
                }
                break;
            }
            case 'GroupKeyCached': {
                state.groupKey = {
                    epoch: event.newEpoch,
                    pk: event.groupPk,
                    pkG2: event.groupPkG2,
                };
                logger.info('themis: chamber cached new group key', {
                    chamber: state.address.toString(),
                    oldEpoch: event.oldEpoch,
                    newEpoch: event.newEpoch,
                    threshold: event.threshold,
                    memberCount: event.memberCount,
                    txHash: ctx.txHash,
                });
                break;
            }
            default:
                // Other events (Paused/Unpaused/CodeUpdated/etc) are
                // surfaced by the protocol-health handler in the
                // ProductModule — no operator action by this worker.
                return;
        }
    }

    /**
     * One-shot cold-start probe per chamber: read getOperator + getCurrentRound
     * + getGroupKey so we can act on the very first tick instead of waiting
     * for the next RoundStarted to fire. Cheap (3 read-only calls per
     * chamber, once per process lifetime).
     */
    private async seedFromChain(state: ChamberState): Promise<void> {
        if (state.seeded) return;
        const contract = this.deps.chambers.get(state.address.toString({ bounceable: false }));
        if (contract === undefined) return;

        try {
            const op = await contract.getOperator(this.deps.wallet.address);
            state.mirrored = op?.isActive === true;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.deps.logger.warn('themis: getOperator probe failed (will retry next tick)', {
                chamber: state.address.toString(),
                error: msg,
            });
            return; // leave seeded=false to retry
        }
        try {
            const r = await contract.getCurrentRound();
            // Only seed the round shell if we don't already have one (events
            // are authoritative when present). Bids must come from events;
            // there's no getter for the per-round ciphertexts list.
            if (state.round === null) {
                state.round = freshRound(r.roundId, r.commitEta, r.revealEta);
            } else if (state.round.commitEta === 0 || state.round.revealEta === 0) {
                // We received bids before RoundStarted — fill in eta from chain.
                state.round.commitEta = r.commitEta;
                state.round.revealEta = r.revealEta;
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.deps.logger.warn('themis: getCurrentRound probe failed (will retry next tick)', {
                chamber: state.address.toString(),
                error: msg,
            });
            return;
        }
        try {
            const gk = await contract.getGroupKey();
            if (gk.entryVersion > 0 && gk.groupEpoch > 0) {
                state.groupKey = {
                    epoch: gk.groupEpoch,
                    pk: gk.groupPk,
                    pkG2: gk.groupPkG2,
                };
            }
        } catch (err) {
            // Acceptable: chamber may not have a cached group key yet.
            const msg = err instanceof Error ? err.message : String(err);
            this.deps.logger.debug('themis: getGroupKey probe yielded no key', {
                chamber: state.address.toString(),
                error: msg,
            });
        }
        state.seeded = true;
    }

    /**
     * Run one cycle: for each tracked chamber, decide whether to attempt
     * a reveal and if so submit it. Safe to call every tick.
     */
    async tick(): Promise<{
        chambers: number;
        attempts: number;
        successes: number;
        failures: number;
        skipped: number;
    }> {
        const now = this.nowSec();
        let attempts = 0;
        let successes = 0;
        let failures = 0;
        let skipped = 0;

        // Iterate a snapshot of keys so any in-handler mutation can't
        // perturb the loop.
        const keys = Array.from(this.states.keys());
        for (const key of keys) {
            const state = this.states.get(key);
            if (state === undefined) continue;

            await this.seedFromChain(state);

            const decision = this.evaluate(state, now);
            if (decision.action === 'skip') {
                skipped++;
                this.counters.incrementRevealSkip(decision.reason);
                this.deps.logger.debug('themis: skip reveal', {
                    chamber: state.address.toString(),
                    reason: decision.reason,
                });
                continue;
            }

            // action === 'reveal'
            attempts++;
            this.counters.incrementRevealAttempt();
            state.round!.inFlight = true;
            try {
                const ok = await this.submitOne(state);
                if (ok) {
                    successes++;
                    this.counters.incrementRevealSuccess();
                    state.round!.settled = true;
                } else {
                    failures++;
                    // submitOne already logged the specific reason via
                    // a skip counter — the round wasn't ours to reveal.
                }
            } catch (err) {
                failures++;
                const msg = err instanceof Error ? err.message : String(err);
                this.counters.incrementRevealFailure('exception');
                this.deps.logger.error('themis: RevealRound threw — will retry next tick', {
                    chamber: state.address.toString(),
                    roundId: state.round!.roundId.toString(),
                    error: msg,
                });
            } finally {
                if (state.round !== null) {
                    state.round.inFlight = false;
                }
            }
        }

        return { chambers: this.states.size, attempts, successes, failures, skipped };
    }

    /**
     * Pure decision: should we attempt a reveal for this chamber right now?
     * Returns either `{ action: 'reveal' }` or `{ action: 'skip', reason }`.
     * No I/O, no chain reads — caller has already seeded.
     */
    private evaluate(
        state: ChamberState,
        now: number,
    ): { action: 'reveal' } | { action: 'skip'; reason: string } {
        if (!state.mirrored)            return { action: 'skip', reason: 'not-mirrored' };
        if (state.groupKey === null)    return { action: 'skip', reason: 'no-group-key' };
        if (state.round === null)       return { action: 'skip', reason: 'no-round' };
        if (state.round.settled)        return { action: 'skip', reason: 'already-settled' };
        if (state.round.inFlight)       return { action: 'skip', reason: 'in-flight' };
        if (state.round.bids.size === 0) return { action: 'skip', reason: 'no-bids' };
        if (state.round.commitEta === 0) return { action: 'skip', reason: 'awaiting-eta' };
        if (now < state.round.commitEta) return { action: 'skip', reason: 'commit-still-open' };
        if (now >= state.round.revealEta) return { action: 'skip', reason: 'reveal-deadline-passed' };
        return { action: 'reveal' };
    }

    /**
     * Build + submit the RevealRound message for this chamber's current
     * round. Returns true on confirmed reveal; false if the round was
     * settled by someone else between gate and verify; throws on
     * transient failure.
     */
    private async submitOne(state: ChamberState): Promise<boolean> {
        const logger = this.deps.logger;
        const contract = this.deps.chambers.get(state.address.toString({ bounceable: false }));
        if (contract === undefined) {
            throw new Error(
                `themis worker: no contract handle for ${state.address.toString()} ` +
                    `(should be impossible — states is seeded from chambers)`,
            );
        }
        const round = state.round!;
        const groupKey = state.groupKey!;
        const chamberStr = state.address.toString();
        const roundIdStr = round.roundId.toString();

        // Live freshness check — the event drain may have lagged.
        let live;
        try {
            live = await contract.getCurrentRound();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`themis: getCurrentRound failed pre-submit: ${msg}`);
        }
        if (live.roundId !== round.roundId) {
            // Chamber moved on — either revealed or rolled over via
            // AdvanceRound. Drop our cached round; the next event will
            // bring us back in sync.
            logger.info('themis: round no longer current (settled by someone else)', {
                chamber: chamberStr,
                cachedRoundId: roundIdStr,
                liveRoundId: live.roundId.toString(),
            });
            this.counters.incrementRevealSkip('round-rolled-over');
            return false;
        }

        // Build the per-bid (idx, c1, D) entries — solo-mode: D = sk · c1.
        const entries = Array.from(round.bids.entries())
            .map(([idx, c1]) => ({
                idx,
                c1,
                D: groupDecrypt(c1, this.deps.blsSecret),
            }));

        // buildReveal handles the full crypto pipeline:
        //   - chamberBindingHashTs(chamber) → 32-byte binding
        //   - buildDecryptionsCell(entries) → Cell, with cell.hash() = decryptionsRoot
        //   - signedBytes = chamberBinding || roundIdBE || groupEpochBE || decryptionsRoot
        //   - sig = BLS sign signedBytes with sk (96-byte G2)
        //   - Returns (signedDataRef, decryptionsRef, aggSigRef)
        const built = buildReveal({
            chamber: state.address,
            roundId: round.roundId,
            groupEpoch: groupKey.epoch,
            entries,
            groupKey: { sk: this.deps.blsSecret, pk: groupKey.pk, pkG2: groupKey.pkG2 },
        });

        const cfg = await this.getConfigCached(state);

        // Reveal value floor:
        //   - revealer reward to us (chamber pays back from rewardPool)
        //   - one outbound xc gas (RevealCallback to consumer)
        //   - reserve invariant
        //   - small headroom for fwd-fee variability
        // The chamber's reserve invariant requires originalBalance ≥
        // minReserve + GAS_MARGIN + outbound_sends, so the value we attach
        // must comfortably cover the inbound + the outbound.
        const value =
            cfg.revealerReward + cfg.callbackGas + cfg.minXcGas + cfg.minReserve + REVEAL_GAS_HEADROOM;

        logger.info('themis: submitting RevealRound', {
            chamber: chamberStr,
            roundId: roundIdStr,
            bidCount: entries.length,
            groupEpoch: groupKey.epoch,
        });

        const send = async (): Promise<void> => {
            await contract.sendRevealRound(
                this.sender,
                value,
                built.signedDataRef,
                built.decryptionsRef,
                built.aggSigRef,
            );
        };
        // Chamber-side acceptance check. Naive `roundId-changed` doesn't
        // work: `RevealRound` settles the round IN PLACE — only
        // `AdvanceRound` advances `roundId`, and that's a separate
        // post-revealEta tx (often by someone else). So we instead poll
        // the chamber's most-recent inbound transactions for the one
        // sourced from this operator with op=RevealRound, and read its
        // computePhase exitCode directly.
        const verify = async (): Promise<void> => {
            await this.assertChamberAccepted(contract.address, round.roundId, roundIdStr);
        };

        if (this.deps.submitReveal !== undefined) {
            await this.deps.submitReveal(send, verify);
            logger.info('themis: reveal verified', { chamber: chamberStr, roundId: roundIdStr });
        } else {
            const result = await sendAndConfirm(this.deps.client, this.deps.wallet, send, {
                verify,
                origin: 'themis',
            });
            logger.info('themis: reveal verified', {
                chamber: chamberStr,
                roundId: roundIdStr,
                seqno: `${result.seqnoBefore}→${result.seqnoAfter}`,
                tx: result.txHash,
            });
        }
        return true;
    }

    private async getConfigCached(state: ChamberState): Promise<ChamberConfigCache> {
        const key = state.address.toString({ bounceable: false });
        const now = this.nowSec() * 1000;
        const cached = this.configCache.get(key);
        if (cached !== undefined && now - cached.fetchedAt < CONFIG_CACHE_TTL_MS) {
            return cached;
        }
        const contract = this.deps.chambers.get(key)!;
        const cfg = await contract.getConfig();
        const entry: ChamberConfigCache = {
            revealerReward: cfg.revealerReward,
            callbackGas: cfg.callbackGas,
            minXcGas: cfg.minXcGas,
            minReserve: cfg.minReserve,
            fetchedAt: now,
        };
        this.configCache.set(key, entry);
        return entry;
    }

    /**
     * Confirm the chamber accepted our just-sent `RevealRound` by reading
     * the computePhase `exitCode` of the matching inbound tx in the
     * chamber's recent history. Polls up to ~30 s — toncenter takes a
     * couple of seconds to surface freshly-landed txs through the
     * paged-tx history endpoint, so the first poll often shows nothing.
     *
     * Throws on:
     *   - chamber rejected the inbound (exitCode != 0) — message wraps
     *     the actual exit code so `explainExitCode('themis', code)`
     *     resolves it via the unified explainer.
     *   - tx not found within the poll window — most likely the wallet
     *     tx was attributed but propagation lag is still in flight; we
     *     err on the side of "throw + retry next tick" rather than
     *     silently report success.
     *
     * Why `roundId`-comparison doesn't work as a verifier:
     * `RevealRound` settles the round IN PLACE (`phase = REVEALED` on
     * `RoundBlob`); `getCurrentRound()` returns the same `roundId`
     * until someone permissionlessly calls `AdvanceRound` (often a
     * separate operator after `revealEta`). The historical bug here
     * (≤ 0.9.0) treated the unchanged `roundId` as proof the reveal
     * failed — false-negative on every successful reveal, leading to
     * spurious retries that reverted with `E_ROUND_ALREADY_REVEALED`
     * (156). Pinned by tests/themis-worker.spec.ts.
     */
    private async assertChamberAccepted(
        chamberAddr: Address,
        roundId: bigint,
        roundIdStr: string,
    ): Promise<void> {
        const me = this.deps.wallet.address;
        const deadlineMs = Date.now() + 30_000;
        // OP_REVEAL_ROUND (0x92) — duplicated here rather than imported
        // from themis-sdk to keep the verify hot-path free of cross-package
        // re-resolution; the constant has been frozen since v1.
        const OP_REVEAL_ROUND = 0x92;

        let lastErr: unknown;
        while (Date.now() < deadlineMs) {
            try {
                const txs = await this.deps.client.call((c) =>
                    c.getTransactions(chamberAddr, { limit: 10 }),
                );
                for (const tx of txs) {
                    const inMsg = tx.inMessage;
                    if (inMsg === undefined || inMsg === null) continue;
                    if (inMsg.info.type !== 'internal') continue;
                    if (!inMsg.info.src.equals(me)) continue;
                    const slice = inMsg.body.beginParse();
                    if (slice.remainingBits < 32) continue;
                    if (slice.preloadUint(32) !== OP_REVEAL_ROUND) continue;

                    const desc = tx.description;
                    if (desc.type !== 'generic' || desc.computePhase.type !== 'vm') {
                        // skipped phase (rare for our-sent inbound) — keep
                        // looking for another candidate.
                        continue;
                    }
                    const exitCode = desc.computePhase.exitCode;
                    if (exitCode === 0) return;
                    throw new Error(
                        `chamber rejected RevealRound for roundId=${roundIdStr}: exit ${exitCode}. ` +
                            `Run \`automaton explain-exit-code ${exitCode}\` (origin=themis) for details.`,
                    );
                }
                lastErr = new Error('no matching RevealRound tx in chamber history yet');
            } catch (err) {
                lastErr = err;
            }
            await new Promise((r) => setTimeout(r, 2000));
        }
        const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
        throw new Error(
            `assertChamberAccepted timed out after 30s waiting for RevealRound ` +
                `tx (roundId=${roundIdStr}) to surface in chamber history: ${reason}`,
        );
    }

    /** Drop cached chamber configs — wired to chamber `ConfigUpdated` events
     *  by the ProductModule so an owner-side retune takes effect immediately
     *  instead of waiting out the 5-minute TTL. */
    dropConfigCache(chamber?: Address): void {
        if (chamber === undefined) {
            this.configCache.clear();
        } else {
            this.configCache.delete(chamber.toString({ bounceable: false }));
        }
    }
}
