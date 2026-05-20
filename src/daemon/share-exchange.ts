// Phase-2 multi-op Fortuna share-exchange server + outbound peer client.
//
// Three concerns separated for testability:
//
//   1. ShareCache         — in-memory cache of (reqKey → { peerAddress → partial }).
//                            Pure data structure; thread-safe in Node's single-threaded
//                            event loop. Cleared per-request after fulfillment.
//   2. startShareExchangeServer — HTTP POST /fortuna/v1/share endpoint.
//                            Validates sender is a known peer, re-derives alpha,
//                            verifies the partial signature against sender's
//                            pkShare, then writes to the cache.
//   3. broadcastShare     — outbound: fan out our partial to every peer's
//                            endpoint, Promise.allSettled so a slow peer doesn't
//                            block the rest. Used by FortunaWorker on each
//                            request we sign locally.
//
// Authentication model: BLS signatures are self-authenticating. A peer
// cannot forge another peer's partial without their secret. Worst an
// adversary on the network path can do is block / delay / censor — the
// exchange protocol is liveness-only sensitive to that, not safety-
// sensitive. So we don't need TLS-cert pinning or shared secrets; we
// just verify the inbound partial cryptographically and reject anything
// from an unknown sender.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { Address } from '@ton/core';
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import type { WorkerLogger } from '../worker/loop';
import { BLS_DST_G2_POP, computeAlpha } from '@titon-network/fortuna-sdk';

/**
 * Wire format for a share-exchange POST. JSON over HTTP.
 *
 * The receiver re-derives alpha from `(consumer, queryId, seed, creationLt)`
 * and rejects mismatches — paranoia against a malicious peer trying to
 * pass a partial signed over a different alpha.
 */
export interface SharePayload {
    /** Atlas group epoch this signature is valid under. Stale-epoch
     *  rejection by the receiver. */
    groupEpoch: number;
    /** Hex of the bigint reqKey from RequestCreated. */
    reqKey: string;
    /** Bounceable consumer address — bound into alpha. */
    consumer: string;
    /** String-bigint queryId. */
    queryId: string;
    /** Hex of bigint seed. */
    seed: string;
    /** String-bigint creationLt. */
    creationLt: string;
    /** Sender's wallet (= sender's operator address, UQ-form). Must be
     *  in the receiver's peer list. */
    fromAddress: string;
    /** Sender's pkShare (96-hex). Must match what Atlas reports for
     *  fromAddress under the current groupEpoch. */
    fromPkShareHex: string;
    /** 96-byte G2 partial signature (192 hex chars). */
    partial: string;
}

/** In-memory share cache. Map<reqKey-hex, Map<peer-address, 96-byte G2 sig>>.
 *  Worker clears entries via `clear(reqKey)` after fulfillment lands or
 *  the request leaves the pending queue (past deadline / fulfilled by
 *  peer / reclaimed). No periodic pruning — the per-request lifecycle
 *  is the bound. */
export class ShareCache {
    private readonly entries = new Map<string, Map<string, Buffer>>();

    /** Record a partial. Idempotent — repeats from the same peer overwrite. */
    set(reqKey: string, peerAddress: string, partial: Buffer): void {
        let inner = this.entries.get(reqKey);
        if (inner === undefined) {
            inner = new Map();
            this.entries.set(reqKey, inner);
        }
        inner.set(peerAddress, partial);
    }

    /** Get all partials for a given reqKey. Empty array if none. */
    getAll(reqKey: string): { peerAddress: string; partial: Buffer }[] {
        const inner = this.entries.get(reqKey);
        if (inner === undefined) return [];
        return Array.from(inner.entries()).map(([peerAddress, partial]) => ({
            peerAddress,
            partial,
        }));
    }

    /** Number of distinct peers that contributed a partial for this reqKey. */
    countFor(reqKey: string): number {
        return this.entries.get(reqKey)?.size ?? 0;
    }

    /** Drop all partials for a reqKey. Worker calls this after the
     *  request leaves the pending queue (success / past-deadline /
     *  fulfilled-by-peer). */
    clear(reqKey: string): void {
        this.entries.delete(reqKey);
    }

    /** Test-only inspector. */
    size(): number {
        return this.entries.size;
    }
}

/** Lookup fn — given a peer address + groupEpoch, return their on-chain
 *  registered pkShare hex. Returns null if the peer isn't registered for
 *  that epoch. Implementation is up to the caller (Atlas getter, cached). */
export type PkShareLookup = (
    peerAddress: Address,
    groupEpoch: number,
) => Promise<string | null>;

export interface ShareExchangeServerOptions {
    port: number;
    host?: string;
    logger: WorkerLogger;
    /** The set of operator addresses we accept partials from. Strings
     *  must be exact `Address.toString({ bounceable: false })` UQ-form
     *  output — base64url is case-sensitive, so don't normalize. */
    knownPeers: Set<string>;
    /** Look up a peer's on-chain pkShare for verifying their partial. */
    lookupPkShare: PkShareLookup;
    /** Where validated partials land. */
    cache: ShareCache;
}

export interface ShareExchangeServer {
    port: number;
    host: string;
    close: () => Promise<void>;
}

/**
 * Start the inbound share-exchange server. Resolves once bound. The
 * caller is responsible for `close()` on shutdown.
 */
export function startShareExchangeServer(
    options: ShareExchangeServerOptions,
): Promise<ShareExchangeServer> {
    const host = options.host ?? '127.0.0.1';
    const server = createServer((req, res) => handleRequest(req, res, options));
    server.keepAliveTimeout = 5_000;
    server.headersTimeout = 5_000;
    server.requestTimeout = 10_000;

    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(options.port, host, () => {
            server.removeAllListeners('error');
            const addr = server.address();
            const boundPort = addr !== null && typeof addr === 'object' ? addr.port : options.port;
            options.logger.info('share-exchange server listening', { host, port: boundPort });
            resolve({
                port: boundPort,
                host,
                close: () =>
                    new Promise((res2, rej2) => {
                        server.close((err) => (err ? rej2(err) : res2()));
                        server.closeIdleConnections?.();
                    }),
            });
        });
    });
}

async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    options: ShareExchangeServerOptions,
): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'POST' || path !== '/fortuna/v1/share') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not found"}\n');
        return;
    }

    let body: SharePayload;
    try {
        body = await readJsonBody<SharePayload>(req);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        respondError(res, 400, `bad-request: ${msg}`);
        return;
    }

    try {
        await validateAndStore(body, options);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":"ok"}\n');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        options.logger.warn('share-exchange: rejected partial', {
            from: body.fromAddress,
            reqKey: body.reqKey,
            reason: msg,
        });
        respondError(res, 400, msg);
    }
}

async function validateAndStore(
    payload: SharePayload,
    options: ShareExchangeServerOptions,
): Promise<void> {
    // 1. Sender must be in our known-peers list. UQ-form is base64url
    //    (case-sensitive); compare bytes-equal, no normalization.
    if (!options.knownPeers.has(payload.fromAddress)) {
        throw new Error(`unknown sender: ${payload.fromAddress}`);
    }

    // 2. Look up sender's on-chain pkShare for the claimed groupEpoch.
    //    Reject epoch mismatch (sender lied about the epoch) AND missing
    //    registration (sender isn't actually in the group).
    const fromAddress = Address.parse(payload.fromAddress);
    const onChainPkShare = await options.lookupPkShare(fromAddress, payload.groupEpoch);
    if (onChainPkShare === null) {
        throw new Error(
            `sender ${payload.fromAddress} not registered for groupEpoch=${payload.groupEpoch}`,
        );
    }
    const claimedPkShare = payload.fromPkShareHex.toLowerCase().replace(/^0x/, '');
    const onChainNorm = onChainPkShare.toLowerCase().replace(/^0x/, '');
    if (claimedPkShare !== onChainNorm) {
        throw new Error(
            `claimed pkShare does not match Atlas's record for ${payload.fromAddress} ` +
                `(claimed=${claimedPkShare.slice(0, 10)}..., onchain=${onChainNorm.slice(0, 10)}...)`,
        );
    }

    // 3. Re-derive alpha from (consumer, queryId, seed, creationLt). The
    //    sender's claimed alpha is implied by these fields; we don't trust
    //    the sender's framing.
    const consumer = Address.parse(payload.consumer);
    const queryId = BigInt(payload.queryId);
    const seed = BigInt(payload.seed.startsWith('0x') ? payload.seed : '0x' + payload.seed);
    const creationLt = BigInt(payload.creationLt);
    const alpha = computeAlpha(consumer, queryId, seed, creationLt);

    // 4. BLS-verify the partial against the (sender's pkShare, alpha) pair.
    //    This is the main load-bearing check — it's what makes the share
    //    self-authenticating. A peer can't forge another peer's partial.
    const partialBytes = Buffer.from(payload.partial.replace(/^0x/, ''), 'hex');
    if (partialBytes.length !== 96) {
        throw new Error(`partial signature must be 96 bytes (got ${partialBytes.length})`);
    }
    const pkShareBytes = Buffer.from(onChainNorm, 'hex');
    const ok = bls.longSignatures.verify(
        partialBytes,
        bls.longSignatures.hash(alpha, BLS_DST_G2_POP),
        pkShareBytes,
    );
    if (!ok) {
        throw new Error('partial signature failed BLS verify');
    }

    // 5. Store. Idempotent — duplicate POSTs from the same peer overwrite
    //    (a peer retrying after a transient error is benign).
    options.cache.set(payload.reqKey, payload.fromAddress, partialBytes);
}

// Share payloads are tiny (~500 bytes JSON) — 16 KiB is a generous bound
// that catches accidentally-spammed bodies without rejecting anything legitimate.
const SHARE_MAX_BYTES = 16 * 1024;

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        req.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > SHARE_MAX_BYTES) {
                req.destroy();
                reject(new Error('request body too large'));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve(JSON.parse(body) as T);
            } catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

function respondError(res: ServerResponse, status: number, message: string): void {
    if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify({ error: message }) + '\n');
}

// =============================================================================
// Outbound peer client
// =============================================================================

export interface PeerEndpoint {
    /** Peer's wallet address (UQ-form). */
    address: string;
    /** http(s) URL the peer's daemon serves /fortuna/v1/share at. */
    endpoint: string;
}

// Per-peer POST timeout. 5 s is well above typical TON-network HTTP
// roundtrip; longer would let a slow peer hold up the broadcast.
const PEER_POST_TIMEOUT_MS = 5_000;

/**
 * Fan out one share to every peer. Each call is independent (Promise.allSettled)
 * so a slow / down peer doesn't block the rest. Returns the per-peer outcome
 * so callers can log + decide whether to retry individual peers.
 */
export async function broadcastShare(
    peers: readonly PeerEndpoint[],
    payload: SharePayload,
): Promise<{ peer: string; ok: boolean; status?: number; error?: string }[]> {
    const results = await Promise.allSettled(
        peers.map(async (peer) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), PEER_POST_TIMEOUT_MS);
            try {
                const url = peer.endpoint.replace(/\/$/, '') + '/fortuna/v1/share';
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: controller.signal,
                });
                if (!res.ok) {
                    return { peer: peer.address, ok: false, status: res.status };
                }
                return { peer: peer.address, ok: true, status: res.status };
            } finally {
                clearTimeout(timer);
            }
        }),
    );
    return results.map((r, i) => {
        const peerAddress = peers[i]?.address ?? '<unknown>';
        return r.status === 'fulfilled'
            ? r.value
            : { peer: peerAddress, ok: false, error: String(r.reason).slice(0, 200) };
    });
}
