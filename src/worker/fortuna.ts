// Fortuna VRF worker — Phase-E parallel to Kronos's worker/loop.ts.
//
// Responsibility: observe Fortuna's request lifecycle events, sign each
// new request with the operator's BLS share, and submit FulfillRandomness
// before the deadline elapses.
//
// Two operating modes:
//
//   - Solo-mode (peers list empty): Atlas's group has memberCount=1,
//     pkShare == groupPk. The single operator's partial IS the aggregate.
//     Worker: sign locally + submit. Same path the testnet canary runs.
//
//   - Multi-op (peers list non-empty): Atlas's group has memberCount=n>1
//     with additive sharing — groupPk = Σ pkShare_i. Worker: on first
//     sight of a request, sign locally and broadcast our partial via
//     `broadcastShare` to every peer's `/fortuna/v1/share` endpoint;
//     receive peer partials via the share-exchange HTTP server (writes
//     to the same `shareCache`); when `n` partials are cached and we're
//     the leader (lowest UQ-form address), aggregate via
//     `aggregateFortunaPartials` and submit. Non-leaders wait
//     `leaderGraceSec` before falling back to submission, so the steady
//     state is one tx per request. Full protocol spec:
//     ../../docs/multi-op-fortuna.md
//
// Pending-request model:
//   On `RequestCreated`  → enqueue the request (reqKey → request).
//   On `RequestFulfilled`/`RequestReclaimed` → dequeue.
//   Each tick: try to fulfill every still-pending request, skipping those
//   we already have in-flight. getRequest is re-checked live (the event
//   drain might lag, so a fulfilled request could briefly stay in the
//   queue — the live check is the authority).
//
// Cross-restart discipline:
//   The pending-request queue is in-memory only. On daemon restart, the
//   event drain replays from the checkpoint and re-enqueues any request
//   created after that checkpoint. Requests CREATED before the checkpoint
//   but not yet fulfilled are NOT re-enqueued — future work is an on-
//   startup "scan recent Fortuna txs + seed the queue" pass.

import { Address, type OpenedContract, type Sender } from '@ton/core';
import {
    Fortuna,
    computeAlpha,
    signAlpha,
    type FortunaConfigReply,
    type FortunaEvent,
} from '@titon-network/fortuna-sdk';
import type { EventHandler, TxContext } from './events';
import type { WorkerLogger } from './loop';
import type { AutomatonWallet } from '../wallet';
import type { FailoverTonClient } from '../chain/ton-client';
import type { DaemonMetrics } from '../daemon/metrics';
import { sendAndConfirm, senderFor } from '../chain';
import { aggregateFortunaPartials, blsPublicKey } from '../bls';
import {
    ShareCache,
    broadcastShare as defaultBroadcastShare,
    type PeerEndpoint,
    type SharePayload,
} from '../daemon/share-exchange';

/**
 * A pending request the operator has seen but not yet fulfilled.
 * Captured from the RequestCreated event; used to compute alpha, sign,
 * and submit FulfillRandomness.
 */
export interface PendingFortunaRequest {
    reqKey: bigint;
    consumer: Address;
    queryId: bigint;
    seed: bigint;
    groupEpoch: number;
    /** Per-tx logical time at request creation; bound into alpha. */
    creationLt: bigint;
    /** Unix-seconds after which reclaim/prune is legal (i.e. stop trying). */
    deadline: number;
    /** Seen-at block timestamp — diagnostics only. */
    seenAt: number;
}

export interface FortunaWorkerCounters {
    incrementFulfillAttempt(): void;
    incrementFulfillSuccess(): void;
    incrementFulfillFailure(reason: string): void;
    incrementFulfillSkip(reason: string): void;
}

export const NOOP_FORTUNA_COUNTERS: FortunaWorkerCounters = {
    incrementFulfillAttempt: () => undefined,
    incrementFulfillSuccess: () => undefined,
    incrementFulfillFailure: () => undefined,
    incrementFulfillSkip: () => undefined,
};

export interface FortunaWorkerDeps {
    /** Open Fortuna contract — supplied by the fortuna ProductModule.bootstrapWorker
     *  (typically `client.open(Fortuna.createFromAddress(addresses.fortuna))`). */
    fortuna: OpenedContract<Fortuna>;
    /** Failover client — used by sendAndConfirm for seqno polling + balance reads. */
    client: FailoverTonClient;
    wallet: AutomatonWallet;
    /** 32-byte BLS12-381 secret key (big-endian). */
    blsSecret: Buffer;
    logger: WorkerLogger;
    counters?: FortunaWorkerCounters;
    /**
     * Injected clock — defaults to `Date.now()/1000`. Sandbox tests override
     * with `() => blockchain.now` so deadline arithmetic matches simulated time.
     */
    nowSec?: () => number;
    /**
     * Injected `Sender` — production builds one via `senderFor(client, wallet)`
     * which goes through V5R1 signing + seqno polling. Sandbox callers (the
     * playground, the integration tests) inject a treasury sender to bypass
     * wallet plumbing. Mirrors `KronosWorker`'s `submitExecute?` injection
     * point.
     */
    sender?: Sender;
    /**
     * Replace the production `sendAndConfirm` wrapper around the
     * `sendFulfillRandomness` call. Sandbox callers pass this so the
     * worker doesn't try to seqno-poll a fake-wallet treasury through
     * `client.open(wallet.walletContract)`. Both `send` and `verify` must
     * still be invoked — `send` produces the on-chain tx, `verify` is the
     * post-state check that the request was actually deleted. Mirrors
     * `KronosWorker`'s `submitExecute?` injection point.
     */
    submitFulfill?: (send: () => Promise<void>, verify: () => Promise<void>) => Promise<void>;

    /**
     * Multi-op peer list. Empty / missing = solo-mode fast-path (a
     * single operator's partial IS the aggregate). When non-empty, the
     * worker runs the threshold-additive flow:
     *   1. Sign locally on RequestCreated
     *   2. POST our partial to every peer
     *   3. Receive peer partials via the share-exchange server (writes
     *      to the same `shareCache`)
     *   4. When `peers.length + 1` partials are cached, aggregate and
     *      submit (with leader-election grace).
     */
    peers?: readonly PeerEndpoint[];
    /**
     * Shared share-cache. The share-exchange HTTP server writes peer
     * partials here; this worker reads them out. Defaults to a fresh
     * private cache when not injected (solo-mode never uses it).
     */
    shareCache?: ShareCache;
    /**
     * Outbound broadcaster. Defaults to the real one over fetch().
     * Sandbox tests inject a synchronous in-memory peer to avoid HTTP
     * in unit tests.
     */
    broadcastShare?: typeof defaultBroadcastShare;
    /**
     * Non-leader grace period in seconds before falling back to
     * submitting the aggregate ourselves (in case the leader is
     * offline / partitioned). Defaults to 30 s.
     */
    leaderGraceSec?: number;
    /**
     * Handle to the share-exchange HTTP server (when multi-op). The
     * worker's `dispose()` closes it on shutdown so the orchestrator's
     * shutdown finally-block doesn't need to know about share-exchange.
     */
    serverHandle?: { close(): Promise<void> };
}

const DEFAULT_CLOCK = (): number => Math.floor(Date.now() / 1000);

// How often to re-fetch Fortuna's live config for value-calculation. The
// tunables (`submitterReward`, `minForwardReserve`, etc.) only change via
// owner UpdateConfig → pool-timelocked, so we don't need them fresh on
// every tick. 5 min is short enough to pick up a reconfigure the same day
// without hammering toncenter.
const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;

// Forward-fee headroom on top of the config-derived floor. The pool-side
// floor covers storage reserve + minimum compute; the small extra buffer
// covers fwd-fee variation across workchain/routing without being wasteful
// (leftover value is returned to the consumer as part of the callback gas).
const FULFILL_FWD_BUFFER = 20_000_000n; // 0.02 TON

export class FortunaWorker {
    private readonly deps: FortunaWorkerDeps;
    private readonly fortuna: OpenedContract<Fortuna>;
    private readonly counters: FortunaWorkerCounters;
    private readonly nowSec: () => number;
    private readonly sender: Sender;

    // (reqKey as hex) → request. Hex-keyed because bigint keys don't
    // survive Map identity cleanly across decoder calls.
    private readonly pending = new Map<string, PendingFortunaRequest>();
    // reqKey hex of requests currently being submitted. Prevents
    // double-submission when a tick is still in-flight at the next tick.
    private readonly inFlight = new Set<string>();

    // Cached Fortuna config — read on first fulfillment + refreshed after
    // CONFIG_CACHE_TTL_MS. Prevents a hardcoded value from silently breaking
    // if the owner retunes `minForwardReserve`/`submitterReward`.
    private configCache: { config: FortunaConfigReply; fetchedAt: number } | null = null;

    // Multi-op state. Empty `peers` = solo-mode fast-path; non-empty =
    // threshold-additive flow with peer share-exchange.
    private readonly peers: readonly PeerEndpoint[];
    private readonly shareCache: ShareCache;
    private readonly broadcastShareFn: typeof defaultBroadcastShare;
    private readonly leaderGraceSec: number;
    private readonly ownAddressKey: string;
    private readonly ownPkShareHex: string;
    // reqKey-hex set of requests we've already signed + broadcast our
    // partial for. Idempotency guard so a slow tick doesn't double-broadcast.
    private readonly broadcasted = new Set<string>();

    constructor(deps: FortunaWorkerDeps) {
        if (deps.blsSecret.length !== 32) {
            throw new Error(`BLS secret must be 32 bytes, got ${deps.blsSecret.length}`);
        }
        this.deps = deps;
        this.fortuna = deps.fortuna;
        this.counters = deps.counters ?? NOOP_FORTUNA_COUNTERS;
        this.nowSec = deps.nowSec ?? DEFAULT_CLOCK;
        this.sender = deps.sender ?? senderFor(deps.client, deps.wallet);
        this.peers = deps.peers ?? [];
        this.shareCache = deps.shareCache ?? new ShareCache();
        this.broadcastShareFn = deps.broadcastShare ?? defaultBroadcastShare;
        this.leaderGraceSec = deps.leaderGraceSec ?? 30;
        // UQ-form is base64url (case-sensitive) — keep the deterministic
        // Address.toString output as-is. Two daemons producing the same
        // Address get identical strings, so this works as a stable key.
        this.ownAddressKey = deps.wallet.address.toString({ bounceable: false });
        this.ownPkShareHex = Buffer.from(blsPublicKey(deps.blsSecret)).toString('hex');
    }

    /** True iff the worker is configured for multi-op (peers list non-empty). */
    private isMultiOp(): boolean {
        return this.peers.length > 0;
    }

    /** Total operators in the group = peers + self. */
    private memberCount(): number {
        return this.peers.length + 1;
    }

    /** Deterministic leader for a given group: lowest UQ-form address
     *  among self+peers wins. Used to avoid duplicate submissions in
     *  the steady state. */
    private isLeader(): boolean {
        let lowest = this.ownAddressKey;
        for (const peer of this.peers) {
            if (peer.address < lowest) lowest = peer.address;
        }
        return lowest === this.ownAddressKey;
    }

    /** Event handler that keeps the pending queue in sync with Fortuna events. */
    eventHandler(): EventHandler {
        const me = this.deps.wallet.address;
        const logger = this.deps.logger;
        return {
            on: {
                fortuna: (event: FortunaEvent, ctx: TxContext) => {
                switch (event.kind) {
                    case 'RequestCreated': {
                        const key = event.reqKey.toString(16);
                        if (!this.pending.has(key)) {
                            this.pending.set(key, {
                                reqKey: event.reqKey,
                                consumer: event.consumer,
                                queryId: event.queryId,
                                seed: event.seed,
                                groupEpoch: event.groupEpoch,
                                creationLt: event.creationLt,
                                deadline: event.deadline,
                                seenAt: ctx.now,
                            });
                            logger.info('fortuna: request enqueued', {
                                reqKey: key,
                                consumer: event.consumer.toString(),
                                queryId: event.queryId.toString(),
                                groupEpoch: event.groupEpoch,
                                creationLt: event.creationLt.toString(),
                                deadline: event.deadline,
                            });
                        }
                        break;
                    }
                    case 'RequestFulfilled': {
                        const key = event.reqKey.toString(16);
                        if (this.pending.delete(key)) {
                            // Clean up multi-op state too — leaving stale
                            // entries in `broadcasted` / `shareCache` for
                            // peer-fulfilled requests would slowly leak.
                            this.broadcasted.delete(key);
                            this.shareCache.clear(key);
                            // Log whether WE won the race; informational.
                            const submitter = event.submitter.toString();
                            const weWon = event.submitter.equals(me);
                            logger.info('fortuna: request fulfilled', {
                                reqKey: key,
                                submitter,
                                weWon,
                            });
                        }
                        break;
                    }
                    case 'RequestReclaimed': {
                        const key = event.reqKey.toString(16);
                        if (this.pending.delete(key)) {
                            this.broadcasted.delete(key);
                            this.shareCache.clear(key);
                            logger.info('fortuna: request reclaimed (not fulfilled in time)', {
                                reqKey: key,
                            });
                        }
                        break;
                    }
                    case 'GroupKeyCached': {
                        logger.info('fortuna: group key cached (atlas rotation propagated)', {
                            oldEpoch: event.oldEpoch,
                            newEpoch: event.newEpoch,
                            threshold: event.threshold,
                            memberCount: event.memberCount,
                        });
                        break;
                    }
                    default:
                        // Other events (Paused/Unpaused/ConfigUpdated/upgrade
                        // lifecycle) — no operator action by this worker; the
                        // fortuna ProductModule wires separate handlers for them
                        // (config-cache invalidator, group-key rotation warning).
                        break;
                }
                },
            },
        };
    }

    /** Number of requests currently in the pending queue. */
    pendingCount(): number {
        return this.pending.size;
    }

    /** True iff there are in-flight submissions. */
    hasInFlight(): boolean {
        return this.inFlight.size > 0;
    }

    /** Push the operator's pending-queue size to the shared metrics
     *  registry. Called by the orchestrator after every tick so /metrics
     *  reads the live count instead of carry-over from the prior drain. */
    publishMetrics(metrics: DaemonMetrics): void {
        metrics.gauges.fortunaPendingRequests.set(this.pending.size);
    }

    /**
     * Release owned resources. Currently: closes the share-exchange
     * HTTP server when multi-op is active (the server holds a listening
     * socket + idle keep-alives; closing prevents the daemon from
     * hanging on shutdown). No-op for solo-mode (no server was started).
     */
    async dispose(): Promise<void> {
        if (this.deps.serverHandle !== undefined) {
            await this.deps.serverHandle.close();
            this.deps.logger.info('fortuna: share-exchange server closed');
        }
    }

    /**
     * Drop any cached Fortuna config so the next `submitOne` re-fetches
     * `submitterReward` + `minForwardReserve` from chain. Wired to the
     * Fortuna `ConfigUpdated` event so an owner-side retune (e.g. bumping
     * `minForwardReserve` during a busy consumer migration) takes effect
     * immediately instead of waiting out the 5-minute TTL.
     */
    dropConfigCache(): void {
        this.configCache = null;
    }

    /**
     * Run one fulfillment cycle: iterate every pending request, try to
     * submit FulfillRandomness for each. Safe to call every tick.
     */
    async tick(): Promise<{ attempts: number; successes: number; failures: number; skipped: number }> {
        const now = this.nowSec();
        let attempts = 0;
        let successes = 0;
        let failures = 0;
        let skipped = 0;

        // Snapshot the keys so delete-during-iteration doesn't trip us up.
        const keys = Array.from(this.pending.keys());
        for (const key of keys) {
            const req = this.pending.get(key);
            if (req === undefined) continue;

            // In-flight guard — skip anything already being submitted.
            if (this.inFlight.has(key)) {
                this.counters.incrementFulfillSkip('in-flight');
                skipped++;
                continue;
            }

            // Deadline elapsed — it's now reclaim-territory, not fulfill.
            // Dequeue + cleanup so we don't keep retrying every tick AND
            // don't leak multi-op state (broadcasted, shareCache) for a
            // request that will never resolve.
            if (now >= req.deadline) {
                this.deps.logger.warn('fortuna: request past deadline — dropping from queue', {
                    reqKey: key,
                    deadline: req.deadline,
                    now,
                });
                this.pending.delete(key);
                this.broadcasted.delete(key);
                this.shareCache.clear(key);
                this.counters.incrementFulfillSkip('past-deadline');
                skipped++;
                continue;
            }

            // Multi-op: sign locally + broadcast our partial on first sight,
            // then wait until we have N partials cached (own + peers).
            if (this.isMultiOp() && !this.broadcasted.has(key)) {
                try {
                    await this.signAndBroadcast(req);
                    this.broadcasted.add(key);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.deps.logger.warn('fortuna: signAndBroadcast threw — will retry next tick', {
                        reqKey: key,
                        error: msg,
                    });
                    skipped++;
                    continue;
                }
            }

            // Multi-op: gate aggregation on having enough partials.
            if (this.isMultiOp()) {
                const haveCount = this.shareCache.countFor(key);
                const needCount = this.memberCount();
                if (haveCount < needCount) {
                    this.counters.incrementFulfillSkip('awaiting-shares');
                    skipped++;
                    continue;
                }
                // Leader-grace: non-leaders wait T sec to let the leader
                // submit first. After grace, fall back to submitting ourselves.
                if (!this.isLeader()) {
                    const ageSec = now - req.seenAt;
                    if (ageSec < this.leaderGraceSec) {
                        this.counters.incrementFulfillSkip('non-leader-grace');
                        skipped++;
                        continue;
                    }
                }
            }

            // Submit.
            // Outcome semantics:
            //   true   = fulfillment landed; verify confirmed deletion → dequeue.
            //   false  = race-lost OR stale-epoch — per-request PERMANENT
            //            (no amount of retrying will succeed for this reqKey).
            //            submitOne already incremented the appropriate skip
            //            counter; dequeue here so we don't keep pinging it.
            //   throws = transient (RPC blip, wallet timeout, schema-side
            //            issue) — keep in pending, the next tick retries.
            //            The `past-deadline` cleanup at the top of this loop
            //            is the upper bound on retry duration.
            attempts++;
            this.counters.incrementFulfillAttempt();
            this.inFlight.add(key);
            try {
                const ok = await this.submitOne(req);
                this.pending.delete(key);
                this.broadcasted.delete(key);
                if (this.isMultiOp()) this.shareCache.clear(key);
                if (ok) {
                    successes++;
                    this.counters.incrementFulfillSuccess();
                } else {
                    // submitOne already logged + incremented skip counter
                    // with a specific reason ('already-gone' / 'stale-epoch').
                    failures++;
                }
            } catch (err) {
                failures++;
                const msg = err instanceof Error ? err.message : String(err);
                this.counters.incrementFulfillFailure('exception');
                this.deps.logger.error('fortuna: FulfillRandomness threw — will retry next tick', {
                    reqKey: key,
                    error: msg,
                });
            } finally {
                this.inFlight.delete(key);
            }
        }

        return { attempts, successes, failures, skipped };
    }

    /**
     * Sign + submit a single pending request. Returns true if the pool
     * observed the fulfillment, false if verification reported the
     * request was already gone (race loss / stale epoch). Throws on a
     * genuine failure (wallet issue, schema mismatch, etc).
     */
    private async submitOne(req: PendingFortunaRequest): Promise<boolean> {
        const logger = this.deps.logger;
        const key = req.reqKey.toString(16);

        // Live freshness check: the event drain may have lagged, so the
        // request could already be fulfilled/reclaimed. One RPC here is
        // cheaper than an on-chain revert.
        const live = await this.fortuna.getRequest(req.consumer, req.queryId);
        if (live === null) {
            logger.info('fortuna: request no longer live (fulfilled or reclaimed by peer)', {
                reqKey: key,
            });
            this.counters.incrementFulfillSkip('already-gone');
            return false;
        }
        if (live.groupEpoch !== req.groupEpoch) {
            // Atlas rotated mid-flight — our signature against the old
            // epoch's pkShare will NOT verify. Consumer should reclaim;
            // we drop from the queue.
            logger.warn('fortuna: request references a stale groupEpoch — giving up', {
                reqKey: key,
                requestEpoch: req.groupEpoch,
                liveEpoch: live.groupEpoch,
            });
            this.counters.incrementFulfillSkip('stale-epoch');
            return false;
        }

        // Compute alpha byte-identically to Fortuna's on-chain derivation.
        // The pre-image binds (consumer, queryId, seed, creationLt) so a
        // replayed request at a new logical time produces a fresh alpha —
        // computeAlpha in fortuna-sdk owns the canonical encoding.
        const alpha = computeAlpha(req.consumer, req.queryId, req.seed, req.creationLt);

        let aggSig: Buffer;
        if (this.isMultiOp()) {
            // Multi-op: cache holds our own partial + peers' partials (the
            // server has already BLS-verified peer partials on the way in).
            // Aggregate via additive sum, then submit. Caller (tick) has
            // already gated on cache.countFor(key) >= memberCount; reaching
            // submitOne with a smaller cache means a concurrent reset
            // (tick race, prune, daemon restart between gate and submit)
            // — fail loudly so the next tick re-broadcasts our share
            // rather than emitting a doomed-to-bounce solo signature.
            const cached = this.shareCache.getAll(key).map((c) => c.partial);
            if (cached.length < this.memberCount()) {
                throw new Error(
                    `multi-op cache lost partials between gate and submit ` +
                        `(have=${cached.length}, need=${this.memberCount()}) — ` +
                        `next tick will re-sign + rebroadcast`,
                );
            }
            aggSig = aggregateFortunaPartials(cached);
        } else {
            // Solo-operator path: the partial IS the aggregate.
            aggSig = signAlpha(this.deps.blsSecret, alpha);
        }

        // Value: the fulfillment must cover (a) the submitter reward
        // reserved for this operator and (b) Fortuna's minForwardReserve
        // for the VrfCallback hop to the consumer, plus a small fwd-fee
        // buffer. Read live from Fortuna's config so an owner-side tunable
        // change (e.g. bumping minForwardReserve during a busy consumer
        // migration) doesn't silently break us — a hardcoded value would
        // bounce post-change and the failure would only surface via
        // monitoring. Cached for CONFIG_CACHE_TTL_MS.
        const cfg = await this.getConfigCached();
        const value = cfg.submitterReward + cfg.minForwardReserve + FULFILL_FWD_BUFFER;

        logger.info('fortuna: submitting FulfillRandomness', {
            reqKey: key,
            consumer: req.consumer.toString(),
            queryId: req.queryId.toString(),
            groupEpoch: req.groupEpoch,
        });

        const send = async (): Promise<void> => {
            await this.fortuna.sendFulfillRandomness(this.sender, {
                value,
                consumer: req.consumer,
                queryId: req.queryId,
                aggSig,
            });
        };
        const verify = async (): Promise<void> => {
            // A successful fulfillment DELETES the request. If getRequest
            // still returns non-null, the submission didn't land — likely
            // race-lost (E_REQUEST_NOT_FOUND already, or the chain is
            // still propagating).
            const post = await this.fortuna.getRequest(req.consumer, req.queryId);
            if (post !== null) {
                throw new Error(
                    `fulfillment did not delete request (still present post-send). ` +
                        `Likely race-lost to a peer operator or stale seed.`,
                );
            }
        };

        if (this.deps.submitFulfill !== undefined) {
            await this.deps.submitFulfill(send, verify);
            logger.info('fortuna: fulfillment verified', { reqKey: key });
        } else {
            const result = await sendAndConfirm(this.deps.client, this.deps.wallet, send, {
                verify,
                origin: 'fortuna',
            });
            logger.info('fortuna: fulfillment verified', {
                reqKey: key,
                seqno: `${result.seqnoBefore}→${result.seqnoAfter}`,
                tx: result.txHash,
            });
        }
        return true;
    }

    /**
     * Multi-op: sign alpha locally, write our partial into the cache,
     * and broadcast to every peer's share-exchange endpoint. Idempotent
     * via `this.broadcasted` (caller checks before invoking). One POST
     * per peer, fan-out parallel via `broadcastShare`'s allSettled.
     */
    private async signAndBroadcast(req: PendingFortunaRequest): Promise<void> {
        const key = req.reqKey.toString(16);
        const alpha = computeAlpha(req.consumer, req.queryId, req.seed, req.creationLt);
        const partial = signAlpha(this.deps.blsSecret, alpha);

        // Cache our own partial — submitOne aggregates the whole cache.
        this.shareCache.set(key, this.ownAddressKey, partial);

        const payload: SharePayload = {
            groupEpoch: req.groupEpoch,
            reqKey: key,
            consumer: req.consumer.toString({ bounceable: false }),
            queryId: req.queryId.toString(),
            seed: '0x' + req.seed.toString(16),
            creationLt: req.creationLt.toString(),
            fromAddress: this.deps.wallet.address.toString({ bounceable: false }),
            fromPkShareHex: this.ownPkShareHex,
            partial: partial.toString('hex'),
        };

        const results = await this.broadcastShareFn(this.peers, payload);
        for (const r of results) {
            if (!r.ok) {
                this.deps.logger.warn('fortuna: share broadcast to peer failed (will retry next tick if needed)', {
                    reqKey: key,
                    peer: r.peer,
                    status: r.status,
                    error: r.error,
                });
            }
        }
        this.deps.logger.info('fortuna: signed + broadcast our partial', {
            reqKey: key,
            peers: this.peers.length,
            ok: results.filter((r) => r.ok).length,
        });
    }

    private async getConfigCached(): Promise<FortunaConfigReply> {
        // Use the injected clock (`nowSec`) so sandbox tests can advance
        // `blockchain.now` to expire the cache deterministically. Storing
        // `fetchedAt` in ms keeps the TTL constant in its natural units
        // (`CONFIG_CACHE_TTL_MS`) without any divide-by-1000 gymnastics.
        const now = this.nowSec() * 1000;
        if (this.configCache !== null && now - this.configCache.fetchedAt < CONFIG_CACHE_TTL_MS) {
            return this.configCache.config;
        }
        const config = await this.fortuna.getConfig();
        this.configCache = { config, fetchedAt: now };
        return config;
    }
}
