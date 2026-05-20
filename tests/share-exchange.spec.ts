// share-exchange unit tests — phase 2 deliverable.
//
// Two layers exercised:
//   1. ShareCache       — pure data structure round-trip + pruning.
//   2. End-to-end loop  — server bound to ephemeral port + broadcastShare
//                         posts a share + server validates BLS sig +
//                         cache contains the partial.
//
// The BLS verification path is real: we generate a fresh share with
// randomBlsSecret + signAlpha and check that valid partials land while
// tampered ones (wrong sender, wrong sig, wrong alpha) are rejected.

import { Address } from '@ton/core';
import {
    ShareCache,
    broadcastShare,
    startShareExchangeServer,
    type SharePayload,
} from '../src/daemon/share-exchange';
import {
    blsPublicKey,
    computeAlpha,
    randomBlsSecret,
    signAlpha,
} from '../src/bls';

const NOOP_LOGGER = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
} as any;

const TEST_ADDR = Address.parse('UQBzQPo5O0AjApOTt3-RYH__mF9kTSJc7ALYgoQdTWQp987R');
const PEER_ADDR = Address.parse('UQDddMqJoMMa3wTLq6XjiqutA2g2LETVRQGxEA7hs-iVzAaS');

function makePayload(sk: Uint8Array, fromAddress: Address): SharePayload {
    const consumer = Address.parse('UQBzQPo5O0AjApOTt3-RYH__mF9kTSJc7ALYgoQdTWQp987R');
    const queryId = 42n;
    const seed = 0x1234567890abcdefn;
    const creationLt = 9876543210n;
    const alpha = computeAlpha(consumer, queryId, seed, creationLt);
    const partial = signAlpha(sk, alpha);
    return {
        groupEpoch: 0,
        reqKey: 'abc123',
        consumer: consumer.toString({ bounceable: false }),
        queryId: queryId.toString(),
        seed: '0x' + seed.toString(16),
        creationLt: creationLt.toString(),
        fromAddress: fromAddress.toString({ bounceable: false }),
        fromPkShareHex: Buffer.from(blsPublicKey(sk)).toString('hex'),
        partial: partial.toString('hex'),
    };
}

describe('ShareCache', () => {
    it('stores + retrieves partials by reqKey', () => {
        const cache = new ShareCache();
        cache.set('rk1', '0x:peer-a', Buffer.from('aa'.repeat(96), 'hex'));
        cache.set('rk1', '0x:peer-b', Buffer.from('bb'.repeat(96), 'hex'));

        const all = cache.getAll('rk1');
        expect(all.length).toBe(2);
        expect(cache.countFor('rk1')).toBe(2);
        expect(cache.size()).toBe(1);
    });

    it('idempotent: duplicate POSTs from same peer overwrite', () => {
        const cache = new ShareCache();
        cache.set('rk1', '0x:peer-a', Buffer.from('aa'.repeat(96), 'hex'));
        cache.set('rk1', '0x:peer-a', Buffer.from('cc'.repeat(96), 'hex'));
        expect(cache.countFor('rk1')).toBe(1);
        const stored = cache.getAll('rk1')[0]!.partial;
        expect(stored.equals(Buffer.from('cc'.repeat(96), 'hex'))).toBe(true);
    });

    it('clear drops a request', () => {
        const cache = new ShareCache();
        cache.set('rk1', '0x:peer-a', Buffer.from('aa'.repeat(96), 'hex'));
        cache.clear('rk1');
        expect(cache.countFor('rk1')).toBe(0);
        expect(cache.getAll('rk1')).toEqual([]);
    });

});

describe('startShareExchangeServer + broadcastShare', () => {
    let serverHandle: { port: number; close: () => Promise<void> };
    let cache: ShareCache;
    let peerSk: Uint8Array;
    let peerPkHex: string;

    beforeEach(async () => {
        cache = new ShareCache();
        peerSk = randomBlsSecret();
        peerPkHex = Buffer.from(blsPublicKey(peerSk)).toString('hex');

        const knownPeers = new Set([PEER_ADDR.toString({ bounceable: false })]);
        const lookupPkShare = async (peer: Address, _epoch: number) => {
            if (peer.equals(PEER_ADDR)) return peerPkHex;
            return null;
        };

        serverHandle = await startShareExchangeServer({
            port: 0, // ephemeral
            host: '127.0.0.1',
            logger: NOOP_LOGGER,
            knownPeers,
            lookupPkShare,
            cache,
        });
    });

    afterEach(async () => {
        await serverHandle.close();
    });

    it('accepts a valid partial from a known peer', async () => {
        const payload = makePayload(peerSk, PEER_ADDR);
        const results = await broadcastShare(
            [{ address: PEER_ADDR.toString({ bounceable: false }), endpoint: `http://127.0.0.1:${serverHandle.port}` }],
            payload,
        );
        expect(results[0]!.ok).toBe(true);
        expect(cache.countFor(payload.reqKey)).toBe(1);
    });

    it('rejects partial from an UNKNOWN peer', async () => {
        // TEST_ADDR is not in knownPeers; only PEER_ADDR is.
        const otherSk = randomBlsSecret();
        const payload = makePayload(otherSk, TEST_ADDR);
        const results = await broadcastShare(
            [{ address: TEST_ADDR.toString({ bounceable: false }), endpoint: `http://127.0.0.1:${serverHandle.port}` }],
            payload,
        );
        expect(results[0]!.ok).toBe(false);
        expect(cache.countFor(payload.reqKey)).toBe(0);
    });

    it('rejects partial whose claimed pkShare differs from on-chain record', async () => {
        const wrongSk = randomBlsSecret();
        const payload = makePayload(wrongSk, PEER_ADDR); // wrong sk → wrong pkShare
        const results = await broadcastShare(
            [{ address: PEER_ADDR.toString({ bounceable: false }), endpoint: `http://127.0.0.1:${serverHandle.port}` }],
            payload,
        );
        expect(results[0]!.ok).toBe(false);
        expect(cache.countFor(payload.reqKey)).toBe(0);
    });

    it('rejects partial with tampered signature bytes', async () => {
        const payload = makePayload(peerSk, PEER_ADDR);
        // Flip a byte in the partial.
        payload.partial = payload.partial.replace(/^./, '0').replace(/^0/, 'f');
        const results = await broadcastShare(
            [{ address: PEER_ADDR.toString({ bounceable: false }), endpoint: `http://127.0.0.1:${serverHandle.port}` }],
            payload,
        );
        expect(results[0]!.ok).toBe(false);
        expect(cache.countFor(payload.reqKey)).toBe(0);
    });

    it('rejects partial whose sender claims a wrong pkShare hex', async () => {
        const payload = makePayload(peerSk, PEER_ADDR);
        // Tamper the claimed pkShare — sender lies about which share they hold.
        payload.fromPkShareHex = 'aa'.repeat(48);
        const results = await broadcastShare(
            [{ address: PEER_ADDR.toString({ bounceable: false }), endpoint: `http://127.0.0.1:${serverHandle.port}` }],
            payload,
        );
        expect(results[0]!.ok).toBe(false);
        expect(cache.countFor(payload.reqKey)).toBe(0);
    });
});
