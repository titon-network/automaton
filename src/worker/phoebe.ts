// Phoebe price-oracle worker — parallel to worker/loop.ts (kronos),
// worker/fortuna.ts, and worker/themis.ts.
//
// Responsibility: heartbeat-push a BLS-attested Merkle snapshot of the
// configured static price feeds. Each tick checks whether the push
// cadence has elapsed; if so, builds the snapshot, signs (solo or via
// peer share-exchange aggregation), and submits `PushSnapshot`.
//
// Two operating modes (mirrors fortuna):
//
//   - Solo-mode (peers list empty): single operator's partial IS the
//     aggregate. Worker builds + signs + submits in one tick. Same
//     code path the testnet canary runs.
//
//   - Multi-op (peers list non-empty): operators threshold-sign the
//     same `(phoebeAddress, timestamp, root)` triple. To make this
//     deterministic — so all operators sign the EXACT same bytes
//     without an out-of-band consensus round — both inputs are
//     pinned:
//       (1) timestamp = floor(now / pushIntervalSec) * pushIntervalSec
//           Every operator independently rounds to the same window
//           boundary using its own clock. Assuming clocks within
//           `maxDriftSec` (server-side rejection bound), the rounded
//           timestamp lands identically across the group.
//       (2) root = Merkle root over `config.phoebe.feeds[]`. Operators
//           MUST coordinate this list off-chain (shared git repo, etc.)
//           so they construct byte-identical leaves.
//           Static feeds give byte-identical roots by construction
//           (operators read the same hand-set values). Dynamic feeds
//           (v2 — pulled from CEX/DEX aggregators) are best-effort
//           in multi-op: per-operator tick sets differ slightly,
//           medians can drift, partials may fail to aggregate. When
//           that happens the leader-grace fallback still lands a
//           push (one operator submits its own root unilaterally) —
//           the threshold-attestation guarantee is lost for that
//           window but liveness is preserved. v2.1 will add a
//           propose/ratify round to make dynamic + multi-op
//           deterministic.
//     Each operator signs the rounded snapshot, broadcasts the partial
//     to peers, caches inbound peer partials, then the leader (lowest
//     UQ-form address) aggregates and submits. Non-leaders fall back
//     to submission after `leaderGraceSec` if the leader appears to
//     have dropped the push.
//
// Why this is a separate file from products/phoebe.ts:
//   Same separation as fortuna/themis — the worker file owns
//   per-cycle behavior; the product file owns static wiring
//   (resolveAddresses, eventStreams, buildHandlers, etc).

import { Address, type OpenedContract, type Sender } from '@ton/core';
import {
    Phoebe,
    PhoebeMerkleTree,
    aggregateSignatures,
    blsPublicKey,
    computeSnapshotHash,
    estimatePushValue,
    signMessage,
    type PhoebeEvent,
    type PriceLeaf,
} from '@titon-network/phoebe-sdk';
import type { EventHandler, TxContext } from './events';
import type { WorkerLogger } from './loop';
import type { AutomatonWallet } from '../wallet';
import type { FailoverTonClient } from '../chain/ton-client';
import type { DaemonMetrics } from '../daemon/metrics';
import { sendAndConfirm, senderFor } from '../chain';
import {
    PhoebeShareCache,
    broadcastPhoebeShare as defaultBroadcastShare,
    snapshotKey,
    type PhoebePeerEndpoint,
    type PhoebeSharePayload,
    type PhoebeSnapshotRef,
} from '../daemon/share-exchange-phoebe';
import type { FeedConfig, PriceFeedManager } from '../products/phoebe-sources';

/** A single static price-feed entry from `config.phoebe.feeds[]`,
 *  pre-parsed into a runtime-friendly shape (mantissa as bigint).
 *  Legacy v1 path — operator hand-sets values + bumps via config edit.
 *  Coexists with `DynamicFeedEntry` (v2) in the same `feeds[]` array. */
export interface StaticFeedEntry {
    kind?: 'static';
    feedId: number;
    mantissa: bigint;
    expo: number;
    confBps: number;
}

/** v2 dynamic feed — aggregated each push window from the configured
 *  CEX/DEX sources via `PriceFeedManager.aggregate(feedCfg)`. */
export interface DynamicFeedEntry {
    kind: 'dynamic';
    feedId: number;
    cfg: FeedConfig;
}

export type PhoebeFeedEntry = StaticFeedEntry | DynamicFeedEntry;

export interface PhoebeWorkerCounters {
    incrementPushAttempt(): void;
    incrementPushSuccess(): void;
    incrementPushFailure(reason: string): void;
    incrementPushSkip(reason: string): void;
}

export const NOOP_PHOEBE_COUNTERS: PhoebeWorkerCounters = {
    incrementPushAttempt: () => undefined,
    incrementPushSuccess: () => undefined,
    incrementPushFailure: () => undefined,
    incrementPushSkip: () => undefined,
};

export interface PhoebeWorkerDeps {
    /** Open Phoebe contract — supplied by phoebe ProductModule.bootstrapWorker. */
    phoebe: OpenedContract<Phoebe>;
    /** Failover client — used by sendAndConfirm for seqno polling + balance reads. */
    client: FailoverTonClient;
    wallet: AutomatonWallet;
    /** 32-byte BLS12-381 secret key (big-endian). */
    blsSecret: Buffer;
    logger: WorkerLogger;
    counters?: PhoebeWorkerCounters;
    /** Price feeds — mix of static (v1) and dynamic (v2) entries.
     *  Empty / undefined = worker is a no-op (push skipped; logs at
     *  debug level once per tick). Accepts `StaticFeedEntry[]` as
     *  shorthand so existing callers don't break. */
    feeds?: readonly PhoebeFeedEntry[];
    /** v2 price aggregator. Required only if any feed has
     *  `kind === 'dynamic'` — static-only worker callers leave it
     *  undefined. */
    priceManager?: PriceFeedManager;
    /** Push cadence in seconds. Defaults to 30. */
    pushIntervalSec?: number;
    /** Injected clock — defaults to `Date.now()/1000`. Sandbox tests override
     *  with `() => blockchain.now` so cadence arithmetic matches simulated time. */
    nowSec?: () => number;
    /** Injected `Sender` — production builds one via `senderFor`. Sandbox callers
     *  inject a treasury sender to bypass wallet plumbing. */
    sender?: Sender;
    /** Replace the production `sendAndConfirm` wrapper around the
     *  `sendPushSnapshot` call. Sandbox callers pass this so the worker
     *  doesn't try to seqno-poll a fake-wallet treasury. */
    submitPush?: (send: () => Promise<void>, verify: () => Promise<void>) => Promise<void>;

    /** Multi-op peer list. Empty / missing = solo-mode fast-path. */
    peers?: readonly PhoebePeerEndpoint[];
    /** Shared share-cache. The share-exchange HTTP server writes peer
     *  partials here; this worker reads them out. Defaults to a fresh
     *  private cache when not injected (solo-mode never uses it). */
    shareCache?: PhoebeShareCache;
    /** Outbound broadcaster. Defaults to the real one over fetch().
     *  Sandbox tests inject an in-memory peer to avoid HTTP. */
    broadcastShare?: typeof defaultBroadcastShare;
    /** Non-leader grace period in seconds before falling back to submitting
     *  the aggregate ourselves (in case the leader is offline / partitioned).
     *  Defaults to 30 s. */
    leaderGraceSec?: number;
    /** Handle to the share-exchange HTTP server (when multi-op). */
    serverHandle?: { close(): Promise<void> };
    /** Public-read snapshot ref. The worker writes the leaves of every
     *  verified push here so the share-exchange server's
     *  `GET /phoebe/v1/snapshot` route can serve them to external
     *  consumers without that traffic touching the multi-op share path. */
    snapshotRef?: PhoebeSnapshotRef;
    /** Live Atlas-group epoch for partial-signing payloads. Updated by
     *  the worker's own eventHandler on GroupKeyCached events. The
     *  caller should seed this from a fresh getGroupKey() read at
     *  startup so the first push under multi-op has the right epoch. */
    initialGroupEpoch?: number;
}

const DEFAULT_CLOCK = (): number => Math.floor(Date.now() / 1000);
const DEFAULT_PUSH_INTERVAL_SEC = 30;
const DEFAULT_LEADER_GRACE_SEC = 30;

// Post-send: how long to wait for `phoebe.lastSnapshotTime` to advance
// to (>=) our pushed timestamp before declaring the tx ghosted. Tuned
// against typical cross-shard delivery (3-10s) + a healthy headroom
// for RPC lag.
const PUSH_LANDING_TIMEOUT_MS = 30_000;
const PUSH_LANDING_POLL_MS = 2_000;

export class PhoebeWorker {
    private readonly deps: PhoebeWorkerDeps;
    private readonly phoebe: OpenedContract<Phoebe>;
    private readonly counters: PhoebeWorkerCounters;
    private readonly nowSec: () => number;
    private readonly sender: Sender;
    private readonly pushIntervalSec: number;
    private readonly feeds: readonly PhoebeFeedEntry[];
    private readonly priceManager?: PriceFeedManager;

    // Multi-op state.
    private readonly peers: readonly PhoebePeerEndpoint[];
    private readonly shareCache: PhoebeShareCache;
    private readonly broadcastShareFn: typeof defaultBroadcastShare;
    private readonly leaderGraceSec: number;
    private readonly ownAddressKey: string;
    private readonly ownPkShareHex: string;
    /** Snapshot we proposed + broadcast this window. Cleared when push
     *  lands OR when we roll to the next window. We store `root` as a
     *  bigint (not hex) so the aggregator path doesn't re-parse via
     *  `BigInt('0x' + ...)` — which throws SyntaxError on the empty
     *  string and is a needless round-trip. */
    private currentProposal: {
        windowStart: number;
        timestamp: number;
        root: bigint;
        rootHex: string; // kept for share-payload + cache key only
        cacheKey: string;
        broadcastedAt: number;
        leaves: Map<number, PriceLeaf>; // captured at build time for the public snapshot endpoint
    } | null = null;
    /** Live group epoch for multi-op partial-signing payloads. Tracked
     *  via GroupKeyCached events; missing until first cache (rejected by
     *  the share-exchange server's epoch check, which is correct — we'd
     *  produce invalid partials anyway). */
    private groupEpoch: number;

    // Lifecycle.
    private lastPushSec = 0;
    private inFlight = false;
    private paused = false;

    constructor(deps: PhoebeWorkerDeps) {
        if (deps.blsSecret.length !== 32) {
            throw new Error(`BLS secret must be 32 bytes, got ${deps.blsSecret.length}`);
        }
        this.deps = deps;
        this.phoebe = deps.phoebe;
        this.counters = deps.counters ?? NOOP_PHOEBE_COUNTERS;
        this.nowSec = deps.nowSec ?? DEFAULT_CLOCK;
        this.sender = deps.sender ?? senderFor(deps.client, deps.wallet);
        this.pushIntervalSec = deps.pushIntervalSec ?? DEFAULT_PUSH_INTERVAL_SEC;
        this.feeds = deps.feeds ?? [];
        this.priceManager = deps.priceManager;
        // Guard: dynamic feeds need a priceManager. Failing loud at
        // construction beats silently dropping every feed at tick time.
        const needsManager = this.feeds.some((f) => f.kind === 'dynamic');
        if (needsManager && this.priceManager === undefined) {
            throw new Error(
                'PhoebeWorker: feeds include dynamic entries but no priceManager supplied',
            );
        }
        this.peers = deps.peers ?? [];
        this.shareCache = deps.shareCache ?? new PhoebeShareCache();
        this.broadcastShareFn = deps.broadcastShare ?? defaultBroadcastShare;
        this.leaderGraceSec = deps.leaderGraceSec ?? DEFAULT_LEADER_GRACE_SEC;
        this.ownAddressKey = deps.wallet.address.toString({ bounceable: false });
        this.ownPkShareHex = Buffer.from(blsPublicKey(deps.blsSecret)).toString('hex');
        this.groupEpoch = deps.initialGroupEpoch ?? 0;
    }

    private isMultiOp(): boolean {
        return this.peers.length > 0;
    }

    /** Total operators in the group = peers + self. */
    private memberCount(): number {
        return this.peers.length + 1;
    }

    /** Deterministic leader: lowest UQ-form address among self + peers. */
    private isLeader(): boolean {
        let lowest = this.ownAddressKey;
        for (const peer of this.peers) {
            if (peer.address < lowest) lowest = peer.address;
        }
        return lowest === this.ownAddressKey;
    }

    /** Round `now` down to the current push-window boundary. All
     *  operators using the same `pushIntervalSec` and a synchronised
     *  clock will land on identical timestamps. */
    private windowStartFor(nowSec: number): number {
        return Math.floor(nowSec / this.pushIntervalSec) * this.pushIntervalSec;
    }

    eventHandler(): EventHandler {
        const logger = this.deps.logger;
        return {
            on: {
                phoebe: (event: PhoebeEvent, _ctx: TxContext) => {
                    switch (event.kind) {
                        case 'Paused':
                            this.paused = true;
                            logger.warn('phoebe: PAUSED — push attempts will be skipped');
                            return;
                        case 'Unpaused':
                            this.paused = false;
                            logger.info('phoebe: resumed — push attempts will resume');
                            return;
                        case 'GroupKeyCached':
                            // Track the epoch for multi-op share payloads. Even
                            // in solo-mode the bump is informational — our
                            // single-op partial doesn't carry an epoch tag.
                            this.groupEpoch = event.newEpoch;
                            logger.info('phoebe: group key cached', {
                                oldEpoch: event.oldEpoch,
                                newEpoch: event.newEpoch,
                                threshold: event.threshold,
                                memberCount: event.memberCount,
                            });
                            // Any in-flight multi-op proposal under the prior
                            // epoch is now stale (peers will reject our
                            // partial under the new epoch). Drop the cache.
                            if (this.isMultiOp() && this.currentProposal !== null) {
                                this.shareCache.clear(this.currentProposal.cacheKey);
                                this.currentProposal = null;
                            }
                            return;
                        default:
                            return;
                    }
                },
            },
        };
    }

    hasInFlight(): boolean {
        return this.inFlight;
    }

    publishMetrics(metrics: DaemonMetrics): void {
        metrics.gauges.phoebeLastPushSec.set(this.lastPushSec);
    }

    async dispose(): Promise<void> {
        if (this.deps.serverHandle !== undefined) {
            await this.deps.serverHandle.close();
            this.deps.logger.info('phoebe: share-exchange server closed');
        }
    }

    /** Run one cycle. Safe to call every tick — work-skip logic gates
     *  the actual push to the configured cadence. */
    async tick(): Promise<{ pushed: boolean; reason: string }> {
        if (this.inFlight) {
            this.counters.incrementPushSkip('in-flight');
            return { pushed: false, reason: 'in-flight' };
        }
        if (this.paused) {
            this.counters.incrementPushSkip('paused');
            return { pushed: false, reason: 'paused' };
        }
        if (this.feeds.length === 0) {
            this.counters.incrementPushSkip('no-feeds');
            this.deps.logger.debug('phoebe: no feeds configured, push skipped');
            return { pushed: false, reason: 'no-feeds' };
        }

        const now = this.nowSec();
        const windowStart = this.windowStartFor(now);

        // Solo-mode: gate on cadence + push immediately.
        if (!this.isMultiOp()) {
            if (windowStart <= this.lastPushSec) {
                this.counters.incrementPushSkip('cadence');
                return { pushed: false, reason: 'cadence' };
            }
            return this.runSoloPush(windowStart);
        }

        // Multi-op: state machine.
        //
        //   1. If no current proposal OR our proposal is for an older
        //      window, sign + broadcast for the current window.
        //   2. If we already broadcast for this window, check whether
        //      cache has all N partials. If yes AND we're leader, push.
        //      If yes AND we're non-leader, push only after leader grace.
        //   3. If cache is incomplete, wait for the next tick.
        if (this.currentProposal === null || this.currentProposal.windowStart < windowStart) {
            // Window rolled forward — drop stale proposal cache + sign anew.
            if (this.currentProposal !== null) {
                this.shareCache.clear(this.currentProposal.cacheKey);
            }
            return this.runMultiOpSignAndBroadcast(windowStart);
        }
        return this.runMultiOpMaybeAggregateAndPush(now);
    }

    private async runSoloPush(windowStart: number): Promise<{ pushed: boolean; reason: string }> {
        const { tree, leaves } = this.buildTree();
        const root = tree.rootAsBigint();
        const sigInput = computeSnapshotHash(this.phoebe.address, windowStart, root);
        const sig = signMessage(this.deps.blsSecret, sigInput);
        return this.submitPushSnapshot({
            timestamp: windowStart,
            root,
            aggSig: sig,
            leaves,
            label: 'solo',
        });
    }

    private async runMultiOpSignAndBroadcast(
        windowStart: number,
    ): Promise<{ pushed: boolean; reason: string }> {
        if (this.groupEpoch === 0) {
            // Without a known epoch, peer partials we send will be
            // rejected by their share-exchange servers. Skip and wait
            // for the first GroupKeyCached event.
            this.counters.incrementPushSkip('awaiting-group-epoch');
            this.deps.logger.debug('phoebe: skipping push — waiting for first GroupKeyCached');
            return { pushed: false, reason: 'awaiting-group-epoch' };
        }

        const { tree, leaves } = this.buildTree();
        const root = tree.rootAsBigint();
        const rootHex = root.toString(16);
        const sigInput = computeSnapshotHash(this.phoebe.address, windowStart, root);
        const partial = signMessage(this.deps.blsSecret, sigInput);

        const cacheKey = snapshotKey(windowStart, rootHex);
        this.shareCache.set(cacheKey, this.ownAddressKey, partial);

        const payload: PhoebeSharePayload = {
            groupEpoch: this.groupEpoch,
            phoebeAddress: this.phoebe.address.toString({ bounceable: true }),
            timestamp: windowStart,
            rootHex,
            fromAddress: this.ownAddressKey,
            fromPkShareHex: this.ownPkShareHex,
            partial: partial.toString('hex'),
        };

        const broadcastedAt = this.nowSec();
        const results = await this.broadcastShareFn(this.peers, payload);
        const okCount = results.filter((r) => r.ok).length;
        for (const r of results) {
            if (!r.ok) {
                this.deps.logger.warn('phoebe: share broadcast to peer failed', {
                    timestamp: windowStart,
                    peer: r.peer,
                    status: r.status,
                    error: r.error,
                });
            }
        }
        this.deps.logger.info('phoebe: signed + broadcast our partial', {
            timestamp: windowStart,
            peers: this.peers.length,
            ok: okCount,
        });

        this.currentProposal = {
            windowStart,
            timestamp: windowStart,
            root,
            rootHex,
            cacheKey,
            broadcastedAt,
            leaves,
        };
        this.counters.incrementPushSkip('awaiting-shares');
        return { pushed: false, reason: 'awaiting-shares' };
    }

    private async runMultiOpMaybeAggregateAndPush(
        nowSec: number,
    ): Promise<{ pushed: boolean; reason: string }> {
        const proposal = this.currentProposal!;
        const haveCount = this.shareCache.countFor(proposal.cacheKey);
        const needCount = this.memberCount();
        if (haveCount < needCount) {
            this.counters.incrementPushSkip('awaiting-shares');
            return { pushed: false, reason: 'awaiting-shares' };
        }
        if (!this.isLeader()) {
            const ageSec = nowSec - proposal.broadcastedAt;
            if (ageSec < this.leaderGraceSec) {
                this.counters.incrementPushSkip('non-leader-grace');
                return { pushed: false, reason: 'non-leader-grace' };
            }
        }

        const partials = this.shareCache.getAll(proposal.cacheKey).map((c) => c.partial);
        if (partials.length === 0) {
            throw new Error(
                'multi-op cache lost partials between gate and submit — next tick will re-broadcast',
            );
        }
        const aggSig = aggregateSignatures(partials);

        const outcome = await this.submitPushSnapshot({
            timestamp: proposal.timestamp,
            root: proposal.root,
            aggSig,
            leaves: proposal.leaves,
            label: this.isLeader() ? 'multi-op-leader' : 'multi-op-fallback',
        });
        // Drop the cache so next window starts fresh regardless of outcome.
        this.shareCache.clear(proposal.cacheKey);
        this.currentProposal = null;
        return outcome;
    }

    /** Build the price tree for the current tick by delegating to the
     *  pure `buildPhoebeLeaves` helper. Dynamic feeds the aggregator
     *  can't satisfy (insufficient fresh sources) are silently dropped
     *  from the tree — a snapshot with fewer feeds is strictly better
     *  than one signed over stale data. Returns the count of dropped
     *  dynamic feeds for telemetry. */
    private buildTree(): {
        tree: PhoebeMerkleTree;
        leaves: Map<number, PriceLeaf>;
        droppedDynamic: number;
    } {
        const { leaves, droppedDynamic } = buildPhoebeLeaves(
            this.feeds,
            this.priceManager,
            this.nowSec(),
            this.deps.logger,
        );
        return { tree: PhoebeMerkleTree.fromSparseLeaves(leaves), leaves, droppedDynamic };
    }

    private async submitPushSnapshot(opts: {
        timestamp: number;
        root: bigint;
        aggSig: Buffer;
        leaves: Map<number, PriceLeaf>;
        label: string;
    }): Promise<{ pushed: boolean; reason: string }> {
        this.inFlight = true;
        this.counters.incrementPushAttempt();
        const logger = this.deps.logger;
        try {
            const value = estimatePushValue();
            logger.info('phoebe: submitting PushSnapshot', {
                timestamp: opts.timestamp,
                mode: opts.label,
                feeds: this.feeds.length,
            });
            const send = async (): Promise<void> => {
                await this.phoebe.sendPushSnapshot(this.sender, {
                    value,
                    timestamp: opts.timestamp,
                    root: opts.root,
                    aggSig: opts.aggSig,
                });
            };
            // Post-send verify: poll `phoebe.lastSnapshotTime` until
            // it advances to (>=) our push's timestamp. Three landing
            // outcomes the poll discriminates:
            //
            //   1. `lastSnapshotTime === opts.timestamp` + submitter
            //      is us → our push landed. ✓
            //   2. `lastSnapshotTime > opts.timestamp` → a peer's push
            //      raced us and landed first OR our push landed and a
            //      later one already overtook it. ✓ (treat as success;
            //      our work is replaced by fresher data which is fine)
            //   3. `lastSnapshotTime < opts.timestamp` after the timeout
            //      → tx never landed. Most often a V5R1 ghost-tx
            //      (wallet balance < send value + reserve → action
            //      phase silently drops, seqno still advances). Throw
            //      so sendAndConfirm's wrapper surfaces a real error
            //      instead of logging a false-positive "push verified".
            //
            // Replaces the earlier "check lastSubmitter == us" gate
            // which false-positived when the wallet ghosted: seqno
            // advanced + lastSubmitter held over from a *prior* push
            // by us, so the check passed even though THIS push never
            // reached phoebe.
            const verify = async (): Promise<void> => {
                const deadline = Date.now() + PUSH_LANDING_TIMEOUT_MS;
                let landed = false;
                let landedTs = opts.timestamp;
                while (Date.now() < deadline) {
                    const { lastSnapshotTime } = await this.phoebe.getSnapshot();
                    if (lastSnapshotTime >= opts.timestamp) {
                        landed = true;
                        landedTs = lastSnapshotTime;
                        break;
                    }
                    await new Promise((r) => setTimeout(r, PUSH_LANDING_POLL_MS));
                }
                if (!landed) {
                    throw new Error(
                        `phoebe push did not land within ${PUSH_LANDING_TIMEOUT_MS}ms ` +
                            `(opts.timestamp=${opts.timestamp}, lastSnapshotTime still < opts.timestamp). ` +
                            `Most likely cause: wallet balance too low for the send value + ` +
                            `storage reserve (V5R1 ghost-tx — DEPLOY_CORE §5.3). ` +
                            `Top up ${this.deps.wallet.address.toString({ bounceable: false })}.`,
                    );
                }
                if (landedTs > opts.timestamp) {
                    // Three sub-cases collapse to the same outcome
                    // (state is fresher than what we proposed → push
                    // is effectively complete from the worker's POV):
                    //   - our push landed; a later push overtook it
                    //   - a peer raced + pushed a higher-timestamp
                    //     snapshot first, our tx then reverted
                    //   - we ghosted AND a peer's higher-timestamp
                    //     push landed
                    logger.info('phoebe: on-chain state is fresher than our push', {
                        ourTimestamp: opts.timestamp,
                        landedTimestamp: landedTs,
                    });
                    return;
                }
                // landedTs === opts.timestamp here (the only remaining
                // case after the `>` branch returned and the `!landed`
                // branch threw). Sanity-check submitter — a peer at
                // our exact timestamp would mean phoebe accepted a
                // tie, which phoebe explicitly rejects via
                // strict-monotonic (E_FRESH_NOT_FRESHER). If we see
                // it anyway it's a contract-side anomaly worth a warn.
                const submitter = await this.phoebe.getLastSubmitter();
                if (submitter !== null && !submitter.equals(this.deps.wallet.address)) {
                    logger.warn(
                        'phoebe: post-push getLastSubmitter is a peer at our exact timestamp',
                        { submitter: submitter.toString() },
                    );
                }
            };

            if (this.deps.submitPush !== undefined) {
                await this.deps.submitPush(send, verify);
                logger.info('phoebe: push verified', { timestamp: opts.timestamp });
            } else {
                const result = await sendAndConfirm(this.deps.client, this.deps.wallet, send, {
                    verify,
                    origin: 'phoebe',
                });
                logger.info('phoebe: push verified', {
                    timestamp: opts.timestamp,
                    seqno: `${result.seqnoBefore}→${result.seqnoAfter}`,
                    tx: result.txHash,
                });
            }
            this.lastPushSec = opts.timestamp;
            this.counters.incrementPushSuccess();
            // Publish the just-confirmed snapshot for the public
            // GET /phoebe/v1/snapshot endpoint. Self-verifying: a
            // querying dapp hashes the leaves and compares against
            // `phoebe.lastSnapshot.root` on-chain.
            if (this.deps.snapshotRef !== undefined) {
                const rootHex = opts.root.toString(16).padStart(64, '0');
                this.deps.snapshotRef.current = {
                    timestamp: opts.timestamp,
                    rootHex,
                    operatorAddress: this.ownAddressKey,
                    phoebeAddress: this.phoebe.address.toString({ bounceable: false }),
                    groupEpoch: this.groupEpoch,
                    leaves: [...opts.leaves.values()].map((l) => ({
                        feedId: l.feedId,
                        mantissa: l.mantissa.toString(),
                        expo: l.expo,
                        confBps: l.confBps,
                        pubTime: l.pubTime,
                    })),
                };
            }
            return { pushed: true, reason: opts.label };
        } catch (err) {
            // Catch + count + return failure — DO NOT rethrow. A
            // rethrow propagates to `tickOnce` → unhandled rejection
            // → daemon shutdown. Mirrors fortuna's pattern; the next
            // window will try again.
            const msg = err instanceof Error ? err.message : String(err);
            this.counters.incrementPushFailure('exception');
            logger.error('phoebe: PushSnapshot threw — will retry next window', { error: msg });
            return { pushed: false, reason: 'exception' };
        } finally {
            this.inFlight = false;
        }
    }
}

/** Pure (testable) helper — produces the leaf Map and the dropped-feed
 *  count from the worker's feed list, the optional aggregator, and a
 *  wall-clock seconds. Extracted from `PhoebeWorker.buildTree()` so
 *  unit tests can exercise the discriminator + drop semantics without
 *  spinning up the full worker (which needs TON wallet + sandbox). */
export function buildPhoebeLeaves(
    feeds: readonly PhoebeFeedEntry[],
    priceManager: PriceFeedManager | undefined,
    nowSec: number,
    logger?: WorkerLogger,
): { leaves: Map<number, PriceLeaf>; droppedDynamic: number } {
    const leaves = new Map<number, PriceLeaf>();
    const nowMs = nowSec * 1000;
    let droppedDynamic = 0;
    for (const f of feeds) {
        if (f.kind === 'dynamic') {
            if (priceManager === undefined) {
                // Defense in depth — caller's constructor should have
                // already rejected this combo. Skip the leaf so the
                // tree builds rather than crashing the tick.
                droppedDynamic += 1;
                continue;
            }
            const agg = priceManager.aggregate(f.cfg, nowMs);
            if (agg === null) {
                droppedDynamic += 1;
                logger?.warn('phoebe: dropping dynamic feed (no quorum)', {
                    feedId: f.feedId,
                });
                continue;
            }
            leaves.set(f.feedId, {
                feedId: f.feedId,
                mantissa: agg.mantissa,
                expo: agg.expo,
                confBps: agg.confBps,
                pubTime: Math.floor(agg.pubTimeMs / 1000),
            });
            continue;
        }
        leaves.set(f.feedId, {
            feedId: f.feedId,
            mantissa: f.mantissa,
            expo: f.expo,
            confBps: f.confBps,
            // Static feeds carry no aggregator pubTime — use the
            // worker's view of "now" so consumers see a fresh-enough
            // pubTime when verifying staleness.
            pubTime: nowSec,
        });
    }
    return { leaves, droppedDynamic };
}
