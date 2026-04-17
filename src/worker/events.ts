// Event subscriber — pulls recent transactions for the registry + pool,
// decodes the external-out bodies they emitted as events, and dispatches
// each event to registered handlers.
//
// Flow (per address):
//   1. Fetch the latest page of transactions (`getTransactions`).
//   2. Walk backwards from newest, collecting txs whose `lt` is newer
//      than our stored checkpoint.
//   3. Page backwards via `oldest.prevTransactionLt` until we either
//      catch up to the checkpoint OR hit `maxPages` (bounded to keep
//      a long-dormant daemon from trying to process weeks of history).
//   4. Reverse the collected list so handlers see events oldest-first.
//   5. Dispatch each extracted event to each registered handler.
//   6. Update the checkpoint to the newest processed tx.
//
// Decoder strategy: we try BOTH kronos-sdk's `tryDecodeEvent` and
// forgeton-sdk's. The address the tx was fetched from tells us which
// decoder is authoritative (registry → kronos; pool → forgeton), but
// the `tryDecode` null-on-unknown-opcode behaviour means the wrong
// decoder just silently skips and we never crash on an unknown event.
//
// Idempotence: the checkpoint is the single authority. A re-run that
// starts from the saved checkpoint will NOT reprocess events — the
// checkpoint's tx is explicitly skipped (the handler saw it last time).

import type { Address, Cell, Transaction } from '@ton/core';
import { decodeEvents as decodeKronosEvents, type KronosEvent } from 'kronos-sdk';
import { decodeEvents as decodeForgetonEvents, type ForgetonEvent } from 'forgeton-sdk';
import type { ChainRuntime } from '../chain';
import { CheckpointStateError } from './checkpoint';
import type { WorkerLogger } from './loop';
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

export interface EventHandler {
    onRegistry?(event: KronosEvent, ctx: TxContext): Promise<void> | void;
    onPool?(event: ForgetonEvent, ctx: TxContext): Promise<void> | void;
    /**
     * Called once after every event in the drain has been dispatched.
     * Handlers with debouncable side-effects (mirror refresh, batch metrics)
     * accumulate across the per-event callbacks and flush here.
     */
    onCycleEnd?(): Promise<void> | void;
}

export interface DrainEventsDeps {
    runtime: ChainRuntime;
    state: CheckpointState;
    handlers: readonly EventHandler[];
    /** Page size per `getTransactions` call. Default 20. */
    pageSize?: number;
    /** Safety cap on backward walks — a week-old checkpoint shouldn't spin forever. */
    maxPages?: number;
    logger?: WorkerLogger;
}

export interface DrainEventsResult {
    state: CheckpointState;
    /** Count of events dispatched per source — useful as a gauge. */
    dispatched: { registry: number; pool: number };
    /** True if the backward walk caught its checkpoint cleanly (not capped by maxPages). */
    fullyCaughtUp: { registry: boolean; pool: boolean };
}

// 50 is toncenter's practical per-call ceiling; 10 pages = 500-tx drain
// which covers realistic recovery windows (minutes-to-hours of downtime
// on a moderately-active registry). Operators with unusual requirements
// can override via drainEvents deps.
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 10;

const SILENT_LOGGER: WorkerLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
};

/**
 * Run one drain pass against both contracts. Returns the updated
 * checkpoint state — persist it via `saveCheckpointState` before the
 * next daemon tick.
 */
export async function drainEvents(deps: DrainEventsDeps): Promise<DrainEventsResult> {
    const logger = deps.logger ?? SILENT_LOGGER;
    const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
    const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;

    let state = deps.state;
    const dispatched = { registry: 0, pool: 0 };
    const fullyCaughtUp = { registry: true, pool: true };

    for (const source of ['registry', 'pool'] as const) {
        const address = deps.runtime.deployment[source];
        const key = address.toString();
        const checkpoint = getCheckpoint(state, key);

        const { txs, capped } = await collectNewTxs(
            deps.runtime,
            address,
            checkpoint,
            pageSize,
            maxPages,
            logger,
        );
        if (capped) fullyCaughtUp[source] = false;

        for (const tx of txs) {
            const ctx: TxContext = {
                txHash: tx.hash().toString('hex'),
                lt: tx.lt,
                now: tx.now,
            };
            const bodies = extractExternalOutBodies(tx);
            if (bodies.length === 0) continue;

            const events =
                source === 'registry'
                    ? decodeKronosEvents(bodies)
                    : decodeForgetonEvents(bodies);
            for (const event of events) {
                // Per-handler isolation: a buggy user handler shouldn't
                // abort the whole drain. Errors are logged and the loop
                // continues; the checkpoint still advances so we don't
                // spin on the same bad event every cycle.
                for (const h of deps.handlers) {
                    try {
                        if (source === 'registry') {
                            if (h.onRegistry) {
                                await h.onRegistry(event as KronosEvent, ctx);
                            }
                        } else {
                            if (h.onPool) {
                                await h.onPool(event as ForgetonEvent, ctx);
                            }
                        }
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        logger.error(`event handler threw (continuing)`, {
                            source,
                            kind: event.kind,
                            txHash: ctx.txHash,
                            error: msg,
                        });
                    }
                }
                dispatched[source]++;
            }
        }

        // Update checkpoint to the newest tx we processed.
        //
        // Known limitation on cap: when `capped === true`, events older
        // than `oldest(txs).prevTransactionLt` exist but were not fetched.
        // Advancing the checkpoint past them means those events are
        // orphaned permanently. With DEFAULT_PAGE_SIZE × DEFAULT_MAX_PAGES
        // = 500 txs this is unlikely in practice; when it happens we log
        // at error level so the operator can scale pageSize/maxPages via
        // deps. A robust tail-pointer design lands in a later phase.
        if (txs.length > 0) {
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
