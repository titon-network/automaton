// Multi-op Phoebe share-exchange server + outbound peer client.
//
// Parallel to `share-exchange.ts` (fortuna) — same architecture, same
// authentication model, different message domain. Phoebe operators
// threshold-sign `(phoebeAddress, timestamp, root)` heartbeats; this
// module ferries partials between peers so the leader can aggregate
// before submitting `PushSnapshot`.
//
// Three concerns separated for testability:
//
//   1. PhoebeShareCache         — in-memory cache of (snapshotKey →
//                                  { peerAddress → partial }). Cleared
//                                  per-snapshot after push lands or the
//                                  next push cycle starts.
//   2. startPhoebeShareExchangeServer — HTTP POST /phoebe/v1/share.
//                                  Validates sender is a known peer,
//                                  re-derives the sig input from
//                                  (phoebeAddress, timestamp, root),
//                                  verifies the partial against
//                                  sender's pkShare, writes the cache.
//   3. broadcastPhoebeShare     — outbound: fan out our partial to every
//                                  peer's endpoint, Promise.allSettled
//                                  so a slow peer doesn't block the rest.
//
// Authentication model is identical to fortuna's: BLS signatures are
// self-authenticating. A peer cannot forge another peer's partial
// without their secret. Network-path adversary can block / delay /
// censor but not forge. So we don't need TLS pinning or shared
// secrets; we cryptographically verify every inbound partial and
// reject anything from an unknown sender.
//
// Port: defaults to 9092 to avoid colliding with fortuna's 9091 when
// both products run on the same host.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { Address } from '@ton/core';
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { BLS_DST_G2_POP, computeSnapshotHash } from '@titon-network/phoebe-sdk';
import type { WorkerLogger } from '../worker/loop';

/**
 * Wire format for a phoebe share-exchange POST. JSON over HTTP.
 *
 * The receiver re-derives `sigInput = computeSnapshotHash(phoebeAddress,
 * timestamp, root)` and verifies the sender's partial against their
 * on-chain pkShare. Paranoia against a malicious peer signing over a
 * different snapshot: we don't trust the sender's framing.
 */
export interface PhoebeSharePayload {
    /** Atlas group epoch this signature is valid under. Stale-epoch
     *  rejection by the receiver. */
    groupEpoch: number;
    /** Bounceable Phoebe address — bound into sigInput for
     *  cross-deployment replay defense. */
    phoebeAddress: string;
    /** Unix seconds — when leader proposed the snapshot. Must be inside
     *  the configured drift bound (caller-supplied to validateAndStore). */
    timestamp: number;
    /** Hex of bigint Merkle root over all 256 feed leaves. */
    rootHex: string;
    /** Sender's wallet (= sender's operator address, UQ-form). Must be
     *  in the receiver's peer list. */
    fromAddress: string;
    /** Sender's pkShare (96-hex). Must match what Atlas reports for
     *  fromAddress under the current groupEpoch. */
    fromPkShareHex: string;
    /** 96-byte G2 partial signature (192 hex chars). */
    partial: string;
}

/** Cache key for a snapshot proposal — uniquely identifies the
 *  (timestamp, root) pair operators are signing over. Stable string so
 *  the cache's `Map` lookups are byte-equal. */
export function snapshotKey(timestamp: number, rootHex: string): string {
    return `${timestamp}:${rootHex.toLowerCase().replace(/^0x/, '')}`;
}

/** In-memory share cache. Map<snapshotKey, Map<peer-address, 96-byte G2 sig>>.
 *  Worker clears entries via `clear(key)` after push lands OR when starting
 *  the next push cycle (whichever comes first). No periodic pruning — the
 *  push cycle is the bound. */
export class PhoebeShareCache {
    private readonly entries = new Map<string, Map<string, Buffer>>();

    /** Record a partial. Idempotent — repeats from the same peer overwrite. */
    set(key: string, peerAddress: string, partial: Buffer): void {
        let inner = this.entries.get(key);
        if (inner === undefined) {
            inner = new Map();
            this.entries.set(key, inner);
        }
        inner.set(peerAddress, partial);
    }

    /** Get all partials for a given snapshot key. Empty array if none. */
    getAll(key: string): { peerAddress: string; partial: Buffer }[] {
        const inner = this.entries.get(key);
        if (inner === undefined) return [];
        return Array.from(inner.entries()).map(([peerAddress, partial]) => ({
            peerAddress,
            partial,
        }));
    }

    /** Number of distinct peers that contributed a partial for this snapshot. */
    countFor(key: string): number {
        return this.entries.get(key)?.size ?? 0;
    }

    /** Drop all partials for a snapshot key. */
    clear(key: string): void {
        this.entries.delete(key);
    }

    /** Drop EVERYTHING. Worker calls on a fresh push cycle so stale partials
     *  from older proposals don't accumulate. */
    clearAll(): void {
        this.entries.clear();
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

/**
 * Last snapshot this operator successfully published (verified on-chain
 * via `getLastSubmitter` check). Exposed via the public read endpoint
 * `GET /phoebe/v1/snapshot` so external dapps can fetch leaves + build
 * merkle proofs without running their own operator. Self-verifying:
 * consumers reconstruct the merkle root from the leaves and compare
 * against the on-chain `phoebe.lastSnapshot.root` — a lying operator
 * gets caught by the hash mismatch, no trust required.
 */
export interface PublishedSnapshot {
    /** Snapshot window-rounded timestamp (seconds since epoch). */
    timestamp: number;
    /** Hex-encoded merkle root (no 0x prefix). */
    rootHex: string;
    /** Operator wallet that published this snapshot (UQ-form). */
    operatorAddress: string;
    /** Phoebe contract this snapshot targets (UQ-form). */
    phoebeAddress: string;
    /** Group epoch the operator signed under. */
    groupEpoch: number;
    /** Leaves committed by `rootHex`, dense by feedId. Mantissa is a
     *  decimal string (JSON can't carry bigints natively). */
    leaves: Array<{
        feedId: number;
        mantissa: string;
        expo: number;
        confBps: number;
        pubTime: number;
    }>;
}

/** Mutable holder so the worker can publish + the server can read
 *  without a tighter coupling. Both sides see the same reference. */
export interface PhoebeSnapshotRef {
    current: PublishedSnapshot | null;
}

export interface PhoebeShareExchangeServerOptions {
    port: number;
    host?: string;
    logger: WorkerLogger;
    /** The set of operator addresses we accept partials from. Strings
     *  must be exact `Address.toString({ bounceable: false })` UQ-form. */
    knownPeers: Set<string>;
    /** Look up a peer's on-chain pkShare for verifying their partial. */
    lookupPkShare: PkShareLookup;
    /** Where validated partials land. */
    cache: PhoebeShareCache;
    /** Public read surface — updated by the worker after every verified
     *  push. Optional: when undefined the GET endpoint returns 503. */
    snapshotRef?: PhoebeSnapshotRef;
    /** Max allowed |proposalTimestamp - now| in seconds. Should be
     *  >= contract's maxPushDrift so a peer's slightly-skewed clock
     *  doesn't reject our leader. Default 60s. */
    maxDriftSec?: number;
    /** Override `Date.now()` for tests. */
    nowSec?: () => number;
}

export interface PhoebeShareExchangeServer {
    port: number;
    host: string;
    close: () => Promise<void>;
}

/**
 * Start the inbound share-exchange server. Resolves once bound. The
 * caller is responsible for `close()` on shutdown.
 */
export function startPhoebeShareExchangeServer(
    options: PhoebeShareExchangeServerOptions,
): Promise<PhoebeShareExchangeServer> {
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
            options.logger.info('phoebe share-exchange server listening', { host, port: boundPort });
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
    options: PhoebeShareExchangeServerOptions,
): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];

    // Public read endpoint — no auth, CORS-open, returns the last
    // successfully-published snapshot. DApps fetch this, reconstruct
    // the merkle root from the leaves, and compare against
    // `phoebe.lastSnapshot.root` on-chain — a lying operator gets
    // caught by the hash mismatch.
    if (req.method === 'GET' && path === '/phoebe/v1/snapshot') {
        const snap = options.snapshotRef?.current ?? null;
        if (snap === null) {
            res.writeHead(503, {
                'content-type': 'application/json',
                'access-control-allow-origin': '*',
            });
            res.end('{"error":"no snapshot published yet"}\n');
            return;
        }
        res.writeHead(200, {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
            'cache-control': 'no-store',
        });
        res.end(JSON.stringify(snap) + '\n');
        return;
    }
    // CORS preflight for the public endpoint.
    if (req.method === 'OPTIONS' && path === '/phoebe/v1/snapshot') {
        res.writeHead(204, {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, OPTIONS',
            'access-control-max-age': '86400',
        });
        res.end();
        return;
    }

    if (req.method !== 'POST' || path !== '/phoebe/v1/share') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not found"}\n');
        return;
    }

    let body: PhoebeSharePayload;
    try {
        body = await readJsonBody<PhoebeSharePayload>(req);
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
        options.logger.warn('phoebe share-exchange: rejected partial', {
            from: body.fromAddress,
            timestamp: body.timestamp,
            reason: msg,
        });
        respondError(res, 400, msg);
    }
}

async function validateAndStore(
    payload: PhoebeSharePayload,
    options: PhoebeShareExchangeServerOptions,
): Promise<void> {
    // 1. Sender must be in our known-peers list.
    if (!options.knownPeers.has(payload.fromAddress)) {
        throw new Error(`unknown sender: ${payload.fromAddress}`);
    }

    // 2. Timestamp must be inside the drift bound. Catches peers proposing
    //    stale snapshots (which the contract would also reject; rejecting
    //    here saves the verify work).
    const now = (options.nowSec ?? defaultNowSec)();
    const drift = Math.abs(now - payload.timestamp);
    const maxDrift = options.maxDriftSec ?? 60;
    if (drift > maxDrift) {
        throw new Error(
            `proposal timestamp drift ${drift}s exceeds bound ${maxDrift}s ` +
                `(proposed=${payload.timestamp}, now=${now})`,
        );
    }

    // 3. Look up sender's on-chain pkShare for the claimed groupEpoch.
    //    Reject epoch mismatch (sender lied) AND missing registration
    //    (sender isn't in the group).
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

    // 4. Re-derive sigInput from (phoebeAddress, timestamp, root). The
    //    sender's claimed payload is implied by these fields; we don't
    //    trust the sender's framing of what was signed.
    const phoebeAddress = Address.parse(payload.phoebeAddress);
    const rootHex = payload.rootHex.toLowerCase().replace(/^0x/, '');
    const root = BigInt('0x' + rootHex);
    const sigInput = computeSnapshotHash(phoebeAddress, payload.timestamp, root);

    // 5. BLS-verify the partial against (sender's pkShare, sigInput).
    //    Main load-bearing check — self-authenticating share.
    const partialBytes = Buffer.from(payload.partial.replace(/^0x/, ''), 'hex');
    if (partialBytes.length !== 96) {
        throw new Error(`partial signature must be 96 bytes (got ${partialBytes.length})`);
    }
    const pkShareBytes = Buffer.from(onChainNorm, 'hex');
    const ok = bls.longSignatures.verify(
        partialBytes,
        bls.longSignatures.hash(sigInput, BLS_DST_G2_POP),
        pkShareBytes,
    );
    if (!ok) {
        throw new Error('partial signature failed BLS verify');
    }

    // 6. Store. Idempotent — duplicate POSTs from the same peer overwrite.
    options.cache.set(snapshotKey(payload.timestamp, rootHex), payload.fromAddress, partialBytes);
}

function defaultNowSec(): number {
    return Math.floor(Date.now() / 1000);
}

// Share payloads are tiny (~400 bytes JSON) — 16 KiB is generous and
// catches accidentally-spammed bodies without rejecting anything legitimate.
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

export interface PhoebePeerEndpoint {
    /** Peer's wallet address (UQ-form). */
    address: string;
    /** http(s) URL the peer's daemon serves /phoebe/v1/share at. */
    endpoint: string;
}

const PEER_POST_TIMEOUT_MS = 5_000;

/**
 * Fan out one share to every peer. Each call is independent
 * (Promise.allSettled) so a slow / down peer doesn't block the rest.
 */
export async function broadcastPhoebeShare(
    peers: readonly PhoebePeerEndpoint[],
    payload: PhoebeSharePayload,
): Promise<{ peer: string; ok: boolean; status?: number; error?: string }[]> {
    const results = await Promise.allSettled(
        peers.map(async (peer) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), PEER_POST_TIMEOUT_MS);
            try {
                const url = peer.endpoint.replace(/\/$/, '') + '/phoebe/v1/share';
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
