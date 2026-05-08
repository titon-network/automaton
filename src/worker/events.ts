// Event subscriber — pulls recent transactions for every registered
// `EventSource`, decodes each tx's external-out bodies into typed events,
// and dispatches each to every registered `EventHandler`.
//
// Flow (per source):
//   1. Fetch the latest page of transactions (`getTransactions`).
//   2. Walk backwards from newest, collecting txs whose `lt` is newer
//      than our stored checkpoint.
//   3. Page backwards via `oldest.prevTransactionLt` until we either
//      catch up to the checkpoint OR hit `maxPages` (bounded to keep
//      a long-dormant daemon from trying to process weeks of history).
//   4. Reverse the collected list so handlers see events oldest-first.
//   5. Dispatch each extracted event via `handler.on[source]`.
//   6. Update the checkpoint to the newest processed tx — only when
//      every handler succeeded; a throw blocks forward progress so the
//      next tick replays the batch (handlers are claimed idempotent).
//
// Sources are passed in as data:
//   - Baseline: 'pool' (ForgeTON) — always present.
//   - Products: contributed by ProductModule.eventStreams (kronos's
//     'registry', fortuna's 'fortuna', future phoebe / argus / …).
//
// Adding a new event source = drop a new `ProductModule.eventStreams()`
// entry; this file does not change.
//
// Idempotence: the checkpoint is the single authority. A re-run that
// starts from the saved checkpoint will NOT reprocess events — the
// checkpoint's tx is explicitly skipped (the handler saw it last time).

import type { Address, Cell, Transaction } from '@ton/core';
import type { ChainRuntime } from '../chain';
import { CheckpointStateError } from './checkpoint';
import { SILENT_LOGGER, type WorkerLogger } from './loop';
import {
    getCheckpoint,
    withCheckpoint,
    type CheckpointEntry,
    type CheckpointState,
} from './checkpoint';

export interface TxContext {
    txHash: string;
    lt: bigint;
    /** Block timestamp (`tx.now`), seconds since epoch. */
    now: number;
}

/**
 * Per-source dispatch interface. Handlers register a callback per
 * `EventSource.source` string; drainEvents looks up `handler.on[source]`
 * for each decoded event.
 *
 * Baseline source keys: `'pool'` (ForgeTON).
 * Product source keys: contributed by ProductModule.eventStreams (e.g.
 * `'registry'` from src/products/kronos.ts, `'fortuna'` from
 * src/products/fortuna.ts).
 *
 * Type discipline: each callback receives the raw decoded event from
 * its source's decoder; branch on `event.kind` for type narrowing.
 * TypeScript can't know which products are registered at compile time,
 * so the parameter is loosely typed (`any`). The discriminant guards
 * runtime safety.
 */
export interface EventHandler {
    /** Per-source callback map. Missing sources are silently skipped — handlers
     *  that don't care about a stream just don't register for it. */
    on?: { [source: string]: (event: any, ctx: TxContext) => Promise<void> | void };
    /**
     * Called once after every event in the drain has been dispatched.
     * Handlers with debouncable side-effects (mirror refresh, batch metrics)
     * accumulate across the per-event callbacks and flush here.
     */
    onCycleEnd?(): Promise<void> | void;
}

/**
 * Descriptor for one stream of external-out events. The baseline pool
 * stream comes from `baselineEventSources(runtime)`; product streams
 * (kronos's registry, fortuna's fortuna, future phoebe / argus / …)
 * come from each enabled `ProductModule.eventStreams()`.
 */
export interface EventSource {
    /** Stable identifier — used as the metric label, EventHandler.on key,
     *  and checkpoint state key. */
    readonly source: string;
    readonly address: Address;
    /** Decode the body cells of one tx's external-out messages into typed events. */
    decode(bodies: Cell[]): readonly { kind: string; opcode: number }[];
}

export interface DrainEventsDeps {
    runtime: ChainRuntime;
    state: CheckpointState;
    /** Streams to drain this tick. Baseline + per-enabled-product. */
    sources: readonly EventSource[];
    handlers: readonly EventHandler[];
    /** Page size per `getTransactions` call. Default 50. */
    pageSize?: number;
    /** Safety cap on backward walks — a week-old checkpoint shouldn't spin forever. */
    maxPages?: number;
    logger?: WorkerLogger;
}

export interface DrainEventsResult {
    state: CheckpointState;
    /** Count of events dispatched per source — useful as a gauge. Indexed by source name. */
    dispatched: Record<string, number>;
    /** Per-source flag: `true` if the backward walk caught its checkpoint cleanly (not capped by maxPages). */
    fullyCaughtUp: Record<string, boolean>;
}

// 50 is toncenter's practical per-call ceiling; 10 pages = 500-tx drain
// which covers realistic recovery windows (minutes-to-hours of downtime
// on a moderately-active registry). Operators with unusual requirements
// can override via drainEvents deps.
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 10;

/**
 * Run one drain pass against every registered source. Returns the updated
 * checkpoint state — persist it via `saveCheckpointState` before the next
 * daemon tick.
 */
export async function drainEvents(deps: DrainEventsDeps): Promise<DrainEventsResult> {
    const logger = deps.logger ?? SILENT_LOGGER;
    const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
    const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;

    let state = deps.state;
    const dispatched: Record<string, number> = {};
    const fullyCaughtUp: Record<string, boolean> = {};

    for (const source of deps.sources) {
        dispatched[source.source] = 0;
        fullyCaughtUp[source.source] = true;

        const key = source.address.toString();
        const checkpoint = getCheckpoint(state, key);

        const { txs, capped } = await collectNewTxs(
            deps.runtime,
            source.address,
            checkpoint,
            pageSize,
            maxPages,
            logger,
        );
        if (capped) fullyCaughtUp[source.source] = false;

        // Track whether any handler threw during this source's dispatch.
        // If so, we REFUSE to advance the checkpoint past this batch —
        // replaying the same events next tick is safe (handlers are
        // claimed idempotent; the drain's checkpoint + handler contract
        // is "at-least-once"), and the alternative is silently losing
        // events that a transient handler failure swallowed.
        let handlerThrew = false;
        for (const tx of txs) {
            const ctx: TxContext = {
                txHash: tx.hash().toString('hex'),
                lt: tx.lt,
                now: tx.now,
            };
            const bodies = extractExternalOutBodies(tx);
            if (bodies.length === 0) continue;

            const events = source.decode(bodies);
            for (const event of events) {
                // Per-handler isolation: a buggy user handler shouldn't
                // abort the whole drain. Errors are logged and the loop
                // continues (so other handlers get the event), but we
                // set `handlerThrew` to gate the checkpoint advance.
                for (const h of deps.handlers) {
                    const cb = h.on?.[source.source];
                    if (cb === undefined) continue;
                    try {
                        await cb(event, ctx);
                    } catch (err) {
                        handlerThrew = true;
                        const msg = err instanceof Error ? err.message : String(err);
                        logger.error(`event handler threw (continuing; checkpoint NOT advancing)`, {
                            source: source.source,
                            kind: event.kind,
                            txHash: ctx.txHash,
                            error: msg,
                        });
                    }
                }
                dispatched[source.source]!++;
            }
        }

        // Advance checkpoint only when every handler succeeded. On
        // handler throw we replay the batch next tick — handlers are
        // contract-idempotent (mirror.refresh, selfSlash webhook dedupes
        // on txHash, consumerWatch is pure log) so replay is the safe
        // failure mode. The alternative — advancing past events a
        // handler swallowed — silently loses alerts; the orchestrator's
        // self-slash webhook is the most sensitive caller here.
        //
        // Known limitation on `capped`: events older than
        // `oldest(txs).prevTransactionLt` were not fetched. Events
        // beyond the pageSize*maxPages cap (default 500) are orphaned
        // unless the operator widens the window. Tracked as `drainCapped`
        // counter for alerting; full tail-pointer fix is future work.
        if (txs.length > 0 && !handlerThrew) {
            const newest = txs[txs.length - 1]!;
            state = withCheckpoint(state, key, {
                lt: newest.lt.toString(),
                hash: newest.hash().toString('hex'),
            });
        }
    }

    // Flush onCycleEnd — debounced side-effects (e.g. mirror refresh)
    // fire exactly once per drain, regardless of how many events in the
    // batch asked for one.
    for (const h of deps.handlers) {
        if (h.onCycleEnd) {
            try {
                await h.onCycleEnd();
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.error('onCycleEnd handler threw', { error: msg });
            }
        }
    }

    return { state, dispatched, fullyCaughtUp };
}

interface CollectResult {
    /** Oldest-first order, ready for in-order handler dispatch. */
    txs: Transaction[];
    /** True if we stopped due to maxPages (incomplete drain). */
    capped: boolean;
}

async function collectNewTxs(
    runtime: ChainRuntime,
    address: Address,
    checkpoint: CheckpointEntry | null,
    pageSize: number,
    maxPages: number,
    logger: WorkerLogger,
): Promise<CollectResult> {
    const collected: Transaction[] = [];
    let lt: string | undefined;
    let hashBase64: string | undefined;
    let pages = 0;
    let capped = false;

    while (pages < maxPages) {
        const page = await runtime.client.call(async (c) => {
            if (lt !== undefined && hashBase64 !== undefined) {
                return c.getTransactions(address, { limit: pageSize, lt, hash: hashBase64 });
            }
            return c.getTransactions(address, { limit: pageSize });
        });

        if (page.length === 0) break;

        let reachedCheckpoint = false;
        for (const tx of page) {
            if (checkpoint !== null && tx.lt.toString() === checkpoint.lt) {
                // Verify the hash matches what we stored. Mismatch means
                // the state.json was copied from another deployment, the
                // contract was redeployed (address reused with fresh
                // history), or someone hand-edited the file. We refuse to
                // continue rather than silently diverge from the chain.
                const actualHash = tx.hash().toString('hex');
                if (checkpoint.hash !== actualHash) {
                    throw new CheckpointStateError(address.toString(), [
                        `stored checkpoint hash ${checkpoint.hash} does not match tx at ` +
                            `lt=${checkpoint.lt} (actual hash ${actualHash}). ` +
                            `The state file likely belongs to a different deployment. ` +
                            `Remove it and restart: rm ~/.titon/automaton/state.json`,
                    ]);
                }
                reachedCheckpoint = true;
                break;
            }
            collected.push(tx);
        }
        if (reachedCheckpoint) break;

        const oldest = page[page.length - 1]!;
        if (oldest.prevTransactionLt === 0n) break; // beginning of account's history

        lt = oldest.prevTransactionLt.toString();
        hashBase64 = bigintHashToBase64(oldest.prevTransactionHash);
        pages++;

        if (pages === maxPages) {
            capped = true;
            logger.error(
                `event drain: hit maxPages=${maxPages} for ${address.toString()}. ` +
                    `Backlog exceeds pageSize*maxPages=${pageSize * maxPages} txs and ` +
                    `events older than the oldest collected are ORPHANED. Scale ` +
                    `drainEvents pageSize/maxPages deps, or shorten daemon downtime.`,
            );
        }
    }

    // Reverse to oldest-first for in-order dispatch.
    collected.reverse();
    return { txs: collected, capped };
}

/** Pure helper — the external-out `body` cells from a single tx's outbound messages. */
export function extractExternalOutBodies(tx: Transaction): Cell[] {
    const bodies: Cell[] = [];
    for (const msg of tx.outMessages.values()) {
        if (msg.info.type === 'external-out') bodies.push(msg.body);
    }
    return bodies;
}

/**
 * TON hashes are 256-bit bigints; toncenter's `getTransactions` API
 * expects them base64-encoded. 32-byte big-endian buffer → base64.
 */
export function bigintHashToBase64(h: bigint): string {
    const buf = Buffer.alloc(32);
    let v = h;
    for (let i = 31; i >= 0; i--) {
        buf[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return buf.toString('base64');
}
