// Multi-op additive aggregation — phase 1 crypto smoke test.
//
// Proves the math: a) `aggregateFortunaPartials` over N partials matches
// what would have been signed by the (theoretical) sum-of-secrets, and
// b) the on-chain BLS_VERIFY shape (verify aggregate against
// aggregateGroupPublicKey, not against any individual pkShare) accepts it.
//
// This pins the contract phase 2 implements against — when FortunaWorker
// is rewired to call aggregateFortunaPartials at line 384, the produced
// aggregate signs against `groupPk` exactly as the on-chain BLS_VERIFY
// expects.

import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { BLS_DST_G2_POP } from '@titon-network/fortuna-sdk';
import {
    aggregateFortunaPartials,
    aggregateGroupPublicKey,
    blsPublicKey,
    randomBlsSecret,
    signAlpha,
} from '../src/bls';

/** Random alpha (32-byte VRF input). The actual content doesn't matter
 *  for these tests — only that all signers sign the SAME alpha. */
function randomAlpha(): Uint8Array {
    const a = new Uint8Array(32);
    for (let i = 0; i < 32; i++) a[i] = Math.floor(Math.random() * 256);
    return a;
}

describe('aggregateFortunaPartials (additive t = n)', () => {
    it('rejects empty input', () => {
        expect(() => aggregateFortunaPartials([])).toThrow(/at least one partial/i);
    });

    it('1-of-1 (solo): identity — one partial = aggregate', () => {
        const sk = randomBlsSecret();
        const pk = blsPublicKey(sk);
        const alpha = randomAlpha();
        const partial = signAlpha(sk, alpha);

        const aggregate = aggregateFortunaPartials([partial]);
        expect(aggregate.equals(partial)).toBe(true);

        // Verifies against the single signer's pkShare (= groupPk in solo-mode).
        const ok = bls.longSignatures.verify(aggregate, bls.longSignatures.hash(alpha, BLS_DST_G2_POP), pk);
        expect(ok).toBe(true);
    });

    it('2-of-2 additive: aggregate verifies against summed groupPk', () => {
        const sk1 = randomBlsSecret();
        const sk2 = randomBlsSecret();
        const groupPk = aggregateGroupPublicKey([sk1, sk2]);

        const alpha = randomAlpha();
        const partial1 = signAlpha(sk1, alpha);
        const partial2 = signAlpha(sk2, alpha);

        const aggregate = aggregateFortunaPartials([partial1, partial2]);

        // The math the daemon will rely on: aggregate verifies against the
        // SUMMED group public key, NOT against either individual pkShare.
        // This is what Fortuna's on-chain BLS_VERIFY checks.
        const ok = bls.longSignatures.verify(aggregate, bls.longSignatures.hash(alpha, BLS_DST_G2_POP), groupPk);
        expect(ok).toBe(true);

        // And — critically — the aggregate does NOT verify against either
        // single pkShare. If the daemon naively submitted partial1 alone,
        // BLS_VERIFY against groupPk would reject. This is the very mistake
        // multi-op aggregation prevents.
        const pk1 = blsPublicKey(sk1);
        const pk2 = blsPublicKey(sk2);
        expect(bls.longSignatures.verify(partial1, bls.longSignatures.hash(alpha, BLS_DST_G2_POP), groupPk)).toBe(false);
        expect(bls.longSignatures.verify(partial2, bls.longSignatures.hash(alpha, BLS_DST_G2_POP), groupPk)).toBe(false);
        expect(bls.longSignatures.verify(aggregate, bls.longSignatures.hash(alpha, BLS_DST_G2_POP), pk1)).toBe(false);
        expect(bls.longSignatures.verify(aggregate, bls.longSignatures.hash(alpha, BLS_DST_G2_POP), pk2)).toBe(false);
    });

    it('3-of-3 additive: ordering of partials does not matter', () => {
        const sks = [randomBlsSecret(), randomBlsSecret(), randomBlsSecret()];
        const groupPk = aggregateGroupPublicKey(sks);
        const alpha = randomAlpha();
        const partials = sks.map((sk) => signAlpha(sk, alpha));

        const inOrder = aggregateFortunaPartials(partials);
        const reversed = aggregateFortunaPartials([...partials].reverse());
        const shuffled = aggregateFortunaPartials([partials[1], partials[2], partials[0]]);

        // G2 addition is commutative; all three aggregations must agree.
        expect(inOrder.equals(reversed)).toBe(true);
        expect(inOrder.equals(shuffled)).toBe(true);

        // And each verifies against the same groupPk.
        for (const agg of [inOrder, reversed, shuffled]) {
            expect(
                bls.longSignatures.verify(agg, bls.longSignatures.hash(alpha, BLS_DST_G2_POP), groupPk),
            ).toBe(true);
        }
    });

    it('rejects when one partial signs a different alpha (defence-in-depth)', () => {
        const sk1 = randomBlsSecret();
        const sk2 = randomBlsSecret();
        const groupPk = aggregateGroupPublicKey([sk1, sk2]);

        const alpha = randomAlpha();
        const wrongAlpha = randomAlpha();

        const partial1 = signAlpha(sk1, alpha);
        const partial2_wrong = signAlpha(sk2, wrongAlpha); // ← signs wrong alpha

        const aggregate = aggregateFortunaPartials([partial1, partial2_wrong]);

        // The aggregate is mathematically valid (G2 sum of two G2 points)
        // but it does NOT verify against (groupPk, alpha) because the
        // partials don't share a message. Catches a malicious peer trying
        // to slip in a partial signed over a different alpha.
        const ok = bls.longSignatures.verify(aggregate, bls.longSignatures.hash(alpha, BLS_DST_G2_POP), groupPk);
        expect(ok).toBe(false);
    });
});
