// Phoebe share-exchange unit tests — parallel to share-exchange.spec.ts (fortuna).
//
// Two layers exercised:
//   1. PhoebeShareCache   — pure data structure round-trip + pruning.
//   2. End-to-end loop    — server bound to ephemeral port + broadcastPhoebeShare
//                           posts a share + server validates BLS sig +
//                           cache contains the partial.
//
// BLS verification path is real: we generate a fresh share with randomBlsSecret
// + signMessage and check that valid partials land while tampered ones
// (wrong sender, wrong sig, wrong timestamp drift) are rejected.

import { Address } from '@ton/core';
import { blsPublicKey, computeSnapshotHash, randomBlsSecret, signMessage } from '@titon-network/phoebe-sdk';
import {
    PhoebeShareCache,
    broadcastPhoebeShare,
    snapshotKey,
    startPhoebeShareExchangeServer,
    type PhoebeSharePayload,
} from '../src/daemon/share-exchange-phoebe';

const NOOP_LOGGER = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
} as any;

const PEER_ADDR = Address.parse('UQDddMqJoMMa3wTLq6XjiqutA2g2LETVRQGxEA7hs-iVzAaS');
const PHOEBE_ADDR = Address.parse('UQBzQPo5O0AjApOTt3-RYH__mF9kTSJc7ALYgoQdTWQp987R');

function makePayload(sk: Uint8Array, fromAddress: Address, timestamp: number, root: bigint): PhoebeSharePayload {
    const sigInput = computeSnapshotHash(PHOEBE_ADDR, timestamp, root);
    const partial = signMessage(sk, sigInput);
    return {
        groupEpoch: 1,
        phoebeAddress: PHOEBE_ADDR.toString({ bounceable: true }),
        timestamp,
        rootHex: root.toString(16),
        fromAddress: fromAddress.toString({ bounceable: false }),
        fromPkShareHex: Buffer.from(blsPublicKey(sk)).toString('hex'),
        partial: partial.toString('hex'),
    };
}

describe('PhoebeShareCache', () => {
    it('stores + retrieves partials by snapshotKey', () => {
        const cache = new PhoebeShareCache();
        const key = snapshotKey(123, 'deadbeef');
        const partial = Buffer.alloc(96, 7);
        cache.set(key, 'peer-a', partial);
        expect(cache.countFor(key)).toBe(1);
        expect(cache.getAll(key)).toEqual([{ peerAddress: 'peer-a', partial }]);
    });

    it('overwrites on repeat set for the same peer (idempotent)', () => {
        const cache = new PhoebeShareCache();
        const key = snapshotKey(123, 'beef');
        cache.set(key, 'peer-a', Buffer.alloc(96, 1));
        cache.set(key, 'peer-a', Buffer.alloc(96, 2));
        expect(cache.countFor(key)).toBe(1);
        expect(cache.getAll(key)[0]!.partial[0]).toBe(2);
    });

    it('clear(key) drops only that snapshot', () => {
        const cache = new PhoebeShareCache();
        cache.set(snapshotKey(1, 'a'), 'p', Buffer.alloc(96));
        cache.set(snapshotKey(2, 'b'), 'p', Buffer.alloc(96));
        cache.clear(snapshotKey(1, 'a'));
        expect(cache.size()).toBe(1);
    });

    it('clearAll() drops every entry', () => {
        const cache = new PhoebeShareCache();
        cache.set(snapshotKey(1, 'a'), 'p', Buffer.alloc(96));
        cache.set(snapshotKey(2, 'b'), 'p', Buffer.alloc(96));
        cache.clearAll();
        expect(cache.size()).toBe(0);
    });
});

describe('startPhoebeShareExchangeServer (end-to-end)', () => {
    it('accepts a valid partial and rejects an unknown sender', async () => {
        const peerSk = randomBlsSecret();
        const peerPkHex = Buffer.from(blsPublicKey(peerSk)).toString('hex');
        const cache = new PhoebeShareCache();
        const server = await startPhoebeShareExchangeServer({
            port: 0, // ephemeral
            logger: NOOP_LOGGER,
            knownPeers: new Set([PEER_ADDR.toString({ bounceable: false })]),
            lookupPkShare: async (addr) => {
                if (addr.equals(PEER_ADDR)) return peerPkHex;
                return null;
            },
            cache,
        });
        try {
            const now = Math.floor(Date.now() / 1000);
            const root = 0xdeadbeefn;

            // Valid payload — should land in cache.
            const goodPayload = makePayload(peerSk, PEER_ADDR, now, root);
            const goodResults = await broadcastPhoebeShare(
                [{ address: PEER_ADDR.toString({ bounceable: false }), endpoint: `http://127.0.0.1:${server.port}` }],
                goodPayload,
            );
            expect(goodResults[0]?.ok).toBe(true);
            expect(cache.countFor(snapshotKey(now, root.toString(16)))).toBe(1);

            // Unknown sender — should reject.
            const unknownAddr = Address.parse('UQBzQPo5O0AjApOTt3-RYH__mF9kTSJc7ALYgoQdTWQp987R');
            const badPayload = makePayload(peerSk, unknownAddr, now, root);
            const badResults = await broadcastPhoebeShare(
                [{ address: unknownAddr.toString({ bounceable: false }), endpoint: `http://127.0.0.1:${server.port}` }],
                badPayload,
            );
            expect(badResults[0]?.ok).toBe(false);
        } finally {
            await server.close();
        }
    });

    it('rejects a partial with stale timestamp', async () => {
        const peerSk = randomBlsSecret();
        const peerPkHex = Buffer.from(blsPublicKey(peerSk)).toString('hex');
        const cache = new PhoebeShareCache();
        const server = await startPhoebeShareExchangeServer({
            port: 0,
            logger: NOOP_LOGGER,
            knownPeers: new Set([PEER_ADDR.toString({ bounceable: false })]),
            lookupPkShare: async () => peerPkHex,
            cache,
            maxDriftSec: 30,
            nowSec: () => 1_000_000_000,
        });
        try {
            // Timestamp 5 minutes off → exceeds 30s drift bound.
            const stalePayload = makePayload(peerSk, PEER_ADDR, 1_000_000_000 - 300, 0x42n);
            const results = await broadcastPhoebeShare(
                [{ address: PEER_ADDR.toString({ bounceable: false }), endpoint: `http://127.0.0.1:${server.port}` }],
                stalePayload,
            );
            expect(results[0]?.ok).toBe(false);
            expect(cache.size()).toBe(0);
        } finally {
            await server.close();
        }
    });

    // ===== Audit-driven negative-case parity with share-exchange.spec.ts =====
    //
    // Phoebe's share-exchange started with only "unknown sender" +
    // "stale timestamp"; bringing it to parity with fortuna's covers the
    // BLS-validation surface a malicious peer would probe.

    it('rejects a partial with tampered signature bytes', async () => {
        const peerSk = randomBlsSecret();
        const peerPkHex = Buffer.from(blsPublicKey(peerSk)).toString('hex');
        const cache = new PhoebeShareCache();
        const server = await startPhoebeShareExchangeServer({
            port: 0,
            logger: NOOP_LOGGER,
            knownPeers: new Set([PEER_ADDR.toString({ bounceable: false })]),
            lookupPkShare: async () => peerPkHex,
            cache,
        });
        try {
            const now = Math.floor(Date.now() / 1000);
            const payload = makePayload(peerSk, PEER_ADDR, now, 0xdeadbeefn);
            // Flip a byte deep in the partial.
            const half = Math.floor(payload.partial.length / 2);
            payload.partial =
                payload.partial.slice(0, half) +
                (payload.partial[half] === 'a' ? 'b' : 'a') +
                payload.partial.slice(half + 1);
            const results = await broadcastPhoebeShare(
                [{ address: PEER_ADDR.toString({ bounceable: false }), endpoint: `http://127.0.0.1:${server.port}` }],
                payload,
            );
            expect(results[0]?.ok).toBe(false);
            expect(cache.size()).toBe(0);
        } finally {
            await server.close();
        }
    });

    it('rejects a partial whose claimed pkShare differs from Atlas record', async () => {
        const peerSk = randomBlsSecret();
        const peerPkHex = Buffer.from(blsPublicKey(peerSk)).toString('hex');
        const cache = new PhoebeShareCache();
        const server = await startPhoebeShareExchangeServer({
            port: 0,
            logger: NOOP_LOGGER,
            knownPeers: new Set([PEER_ADDR.toString({ bounceable: false })]),
            // Server says peer's REAL pkShare is peerPkHex; payload will lie.
            lookupPkShare: async () => peerPkHex,
            cache,
        });
        try {
            const now = Math.floor(Date.now() / 1000);
            const payload = makePayload(peerSk, PEER_ADDR, now, 0xfacefeedn);
            // Tamper the claimed pkShare hex — sender lies about which
            // share they're holding.
            payload.fromPkShareHex = 'aa'.repeat(48);
            const results = await broadcastPhoebeShare(
                [{ address: PEER_ADDR.toString({ bounceable: false }), endpoint: `http://127.0.0.1:${server.port}` }],
                payload,
            );
            expect(results[0]?.ok).toBe(false);
            expect(cache.size()).toBe(0);
        } finally {
            await server.close();
        }
    });

    it('rejects when Atlas lookup returns null (peer not registered)', async () => {
        const peerSk = randomBlsSecret();
        const cache = new PhoebeShareCache();
        const server = await startPhoebeShareExchangeServer({
            port: 0,
            logger: NOOP_LOGGER,
            knownPeers: new Set([PEER_ADDR.toString({ bounceable: false })]),
            // Atlas returns null → sender's pkShare unknown → reject.
            lookupPkShare: async () => null,
            cache,
        });
        try {
            const now = Math.floor(Date.now() / 1000);
            const payload = makePayload(peerSk, PEER_ADDR, now, 0xfeedfacen);
            const results = await broadcastPhoebeShare(
                [{ address: PEER_ADDR.toString({ bounceable: false }), endpoint: `http://127.0.0.1:${server.port}` }],
                payload,
            );
            expect(results[0]?.ok).toBe(false);
            expect(cache.size()).toBe(0);
        } finally {
            await server.close();
        }
    });

    it('rejects malformed JSON body without crashing the server', async () => {
        const cache = new PhoebeShareCache();
        const server = await startPhoebeShareExchangeServer({
            port: 0,
            logger: NOOP_LOGGER,
            knownPeers: new Set([PEER_ADDR.toString({ bounceable: false })]),
            lookupPkShare: async () => 'aa'.repeat(48),
            cache,
        });
        try {
            // Direct POST of non-JSON body — bypasses broadcastPhoebeShare.
            const res = await fetch(`http://127.0.0.1:${server.port}/phoebe/v1/share`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: 'this is not json {{{',
            });
            expect(res.ok).toBe(false);
            expect(cache.size()).toBe(0);
            // Server must still accept the NEXT valid request — i.e. it
            // didn't crash on the malformed body.
            const peerSk = randomBlsSecret();
            const peerPkHex = Buffer.from(blsPublicKey(peerSk)).toString('hex');
            // Replace lookup so next valid request lands; the server's
            // lookupPkShare is fixed at construction so we can't change
            // it mid-test. Instead, just verify the server is still
            // listening (a TCP-level liveness check).
            const probe = await fetch(`http://127.0.0.1:${server.port}/phoebe/v1/share`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{}',
            });
            expect(probe.status).toBeGreaterThanOrEqual(400);
            // (It's a 4xx response — but the fact that we got ANY
            // response proves the server is alive post-malformed body.)
            void peerPkHex;
        } finally {
            await server.close();
        }
    });
});
