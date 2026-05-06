// Solo-mode pkShare-vs-groupPk tripwire (`bls register` pre-flight).
//
// Background — see src/cli/commands/bls.ts › assertSoloModeGroupMatch.
//
// Atlas now ENFORCES `pkShare == groupPk` on-chain in solo-mode (atlas
// `handleRegisterBlsShare` reverts with E_SOLO_PK_SHARE_MISMATCH = 161 when
// memberCount=1 and pkShare != groupPk). This pre-flight is defense-in-depth:
// it catches the same mismatch BEFORE the tx is sent so the operator gets a
// clear local error rather than burning registration gas on a guaranteed
// revert.
//
// Original incident (May 2026 canary): a fresh `automaton bls keygen`
// generated a secret unrelated to the published groupPk; FulfillRandomness
// signatures then failed Fortuna's BLS_VERIFY (exit 161) every time. The
// fix landed in two layers:
//   - on-chain: Atlas asserts pkShare == groupPk in solo-mode at register
//     time (atlas/contracts/atlas.tolk + atlas/tests/Atlas.spec.ts solo-mode
//     suite).
//   - off-chain: this pre-flight, so operators get an actionable error
//     before the tx is broadcast.
//
// Mainnet won't ship in solo-mode (production uses multi-op DKG —
// memberCount > 1, individual pkShares are aggregate contributions and
// don't match groupPk individually), so the check correctly skips there.

import { assertSoloModeGroupMatch } from '../src/cli/commands/bls';

// 48-byte G1 buffer fixtures (compressed point shape — content doesn't have
// to be on-curve for the equality check). Any two distinct 48-byte buffers
// with hex strings that differ are sufficient for the pre-flight logic.
const GROUP_PK = Buffer.from(
    '89c1e7abb277d2b53615fcc63e2fcbd99b807ebb2265a85c87dca753f040ea4771bc187dad463b286aca91cbf322a808',
    'hex',
);
const OUR_PKSHARE_MATCHING = '89c1e7abb277d2b53615fcc63e2fcbd99b807ebb2265a85c87dca753f040ea4771bc187dad463b286aca91cbf322a808';
const OUR_PKSHARE_MISMATCH = '9534b816a930edcfd8087efde0efa6a74e95620d658d2e91aa105397cde4e73c5007e9c10d80a82501cc5f44f13a5bd0';

describe('assertSoloModeGroupMatch — solo-mode pkShare-vs-groupPk tripwire', () => {
    it('throws an explanatory error when solo group + pkShare mismatch', () => {
        // The exact scenario we hit on the canary: a fresh `automaton bls
        // keygen` generated a secret unrelated to the published groupPk.
        // pkShare ≠ groupPk; on-chain Atlas would revert with
        // E_SOLO_PK_SHARE_MISMATCH (161). The pre-flight catches it first.
        expect(() =>
            assertSoloModeGroupMatch(
                {
                    groupId: 0,
                    groupPk: GROUP_PK,
                    groupEpoch: 1,
                    threshold: 1,
                    memberCount: 1,
                },
                OUR_PKSHARE_MISMATCH,
            ),
        ).toThrow(/solo-mode pkShare mismatch/);
    });

    it('error message includes both pubkeys + on-chain enforcement pointer', () => {
        try {
            assertSoloModeGroupMatch(
                {
                    groupId: 0,
                    groupPk: GROUP_PK,
                    groupEpoch: 1,
                    threshold: 1,
                    memberCount: 1,
                },
                OUR_PKSHARE_MISMATCH,
            );
            throw new Error('should have thrown');
        } catch (err) {
            const msg = (err as Error).message;
            // Operator needs to see both pubkeys (so they can copy-paste-verify)
            // and the on-chain enforcement reference (so they understand
            // this is mechanical, not a quirk).
            expect(msg).toContain(GROUP_PK.toString('hex'));
            expect(msg).toContain(OUR_PKSHARE_MISMATCH);
            expect(msg).toContain('E_SOLO_PK_SHARE_MISMATCH');
            expect(msg).toContain('memberCount=1, threshold=1');
        }
    });

    it('passes silently when solo group + pkShare match (correct onboarding)', () => {
        // Operator generated their own secret, gave the public pkShare to
        // the protocol team, the protocol team published it as groupPk via
        // publishSoloGroupKey.ts. pkShare == groupPk by construction.
        expect(() =>
            assertSoloModeGroupMatch(
                {
                    groupId: 0,
                    groupPk: GROUP_PK,
                    groupEpoch: 1,
                    threshold: 1,
                    memberCount: 1,
                },
                OUR_PKSHARE_MATCHING,
            ),
        ).not.toThrow();
    });

    it('skips the check entirely for multi-op DKG groups (memberCount > 1)', () => {
        // Mainnet path: memberCount + threshold both > 1. Individual pkShares
        // are aggregate contributions — they don't equal groupPk. The check
        // would false-positive without the early-return.
        expect(() =>
            assertSoloModeGroupMatch(
                {
                    groupId: 0,
                    groupPk: GROUP_PK,
                    groupEpoch: 1,
                    threshold: 3,
                    memberCount: 5,
                },
                OUR_PKSHARE_MISMATCH, // intentionally different — should be ignored
            ),
        ).not.toThrow();
    });

    it('skips when threshold > 1 even if memberCount = 1 (defensive on rotation edge cases)', () => {
        // Belt-and-suspenders: a future rotation could in principle leave
        // memberCount=1 with threshold>1 transiently. We treat that as "not
        // solo" — the equality check is solo-specific.
        expect(() =>
            assertSoloModeGroupMatch(
                {
                    groupId: 0,
                    groupPk: GROUP_PK,
                    groupEpoch: 2,
                    threshold: 2,
                    memberCount: 1,
                },
                OUR_PKSHARE_MISMATCH,
            ),
        ).not.toThrow();
    });

    it('throws clear "no group key published yet" error when group key is null', () => {
        // Atlas reverts RegisterBlsShare with E_GROUP_KEY_NOT_SET (140) when
        // groups[0] is empty, but the bare exit-code surface is unhelpful for
        // the operator — they can't unblock themselves; the Atlas owner has
        // to publish first. Surface that asymmetric, actionable info before
        // burning gas. Pre-flight runs first; the contract-side check is the
        // safety net.
        expect(() => assertSoloModeGroupMatch(null, OUR_PKSHARE_MISMATCH))
            .toThrow(/no group key published at Atlas yet/);
    });

    it('case-sensitive comparison — uppercase hex from on-chain reads still works', () => {
        // SDK ErrorExplanation buffers use canonical lowercase, but defensive
        // against future SDK changes that might emit uppercase. Failing this
        // test is a clear signal that case-handling drifted.
        const lowercase = GROUP_PK.toString('hex');
        const uppercase = lowercase.toUpperCase();
        // Today: case-sensitive comparison (buffer.toString returns lowercase
        // by convention). If SDK ever changes this, the test will start
        // failing for the matching case — at which point we either normalise
        // case in the helper, or document the requirement that callers
        // pre-normalise. Pinning current behaviour:
        expect(() =>
            assertSoloModeGroupMatch(
                {
                    groupId: 0,
                    groupPk: GROUP_PK,
                    groupEpoch: 1,
                    threshold: 1,
                    memberCount: 1,
                },
                uppercase,
            ),
        ).toThrow(/mismatch/);
    });
});
