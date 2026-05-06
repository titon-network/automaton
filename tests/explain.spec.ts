// TVM exit-code translation: explainExitCode walks four SDK tables (kronos,
// forgeton, atlas, fortuna) plus the TVM 1-100 range; with a `hint` argument
// the calling site forces a specific SDK's table first (resolves the cross-
// protocol overlaps in 120-169). formatExplanation renders hint-bearing
// human text; extractExitCode pulls numeric codes from SDK errors, numeric
// fields, and "exit code N" substrings in sandbox error messages.

import {
    explainExitCode,
    extractExitCode,
    extractExplainHint,
    formatExplanation,
} from '../src/errors/explain';

describe('explainExitCode', () => {
    it('recognises kronos lifecycle codes (120-159 range)', () => {
        const e = explainExitCode(120);
        expect(['kronos', 'fortuna']).toContain(e.origin); // overlapping range; either SDK may claim it
        expect(e.code).toBe(120);
        expect(e.name).toBeDefined();
        expect(e.message).toBeDefined();
    });

    it('recognises forgeton-specific codes when hinted', () => {
        const e = explainExitCode(160, 'forgeton'); // forgeton's NotAuthorizedConsumer
        expect(e.origin).toBe('forgeton');
    });

    it('recognises fortuna BLS codes when hinted', () => {
        const e = explainExitCode(161, 'fortuna');
        expect(e.origin).toBe('fortuna');
        expect(e.name).toMatch(/Bls|BLS|Signature/i);
    });

    it('recognises TVM reserved codes (1-100)', () => {
        const e = explainExitCode(13);
        expect(e.origin).toBe('tvm');
    });

    it('surfaces origin=unknown for codes no SDK recognises', () => {
        const e = explainExitCode(9999);
        expect(e.origin).toBe('unknown');
        expect(e.code).toBe(9999);
    });

    it('falls through to the priority walk when the hinted SDK returns unknown', () => {
        // 13 is TVM — not owned by any SDK's custom range. With hint='atlas'
        // it should still find the TVM table via the priority walk.
        const e = explainExitCode(13, 'atlas');
        expect(e.origin).toBe('tvm');
    });

    it('routes Atlas-side reverts via the hint (cross-SDK code overlap)', () => {
        // Code 120 is a 3-way overlap:
        //   kronos:  InsufficientFunding (RegisterJob below minFunding)
        //   fortuna: DuplicateRequest    (queryId already pending)
        //   atlas:   OperatorNotFound    (operator not in map)
        // Without a hint, the priority walk picks kronos first. Callers
        // who know the revert came from Atlas (e.g. `automaton bls register`)
        // MUST pass hint='atlas' to get the right explanation.
        const unhinted = explainExitCode(120);
        expect(unhinted.origin).toBe('kronos');
        expect(unhinted.name).toBe('InsufficientFunding');

        const atlasHinted = explainExitCode(120, 'atlas');
        expect(atlasHinted.origin).toBe('atlas');
        expect(atlasHinted.name).toBe('OperatorNotFound');
    });

    it('atlas hint also resolves OperatorNotForgetonActive (121)', () => {
        // The neighboring Atlas error — same setup hint, different cause
        // (operator IS in the map but ForgeTON deactivated them).
        const e = explainExitCode(121, 'atlas');
        expect(e.origin).toBe('atlas');
        expect(e.name).toBe('OperatorNotForgetonActive');
    });

    it('returned explanation shape has the required fields', () => {
        const e = explainExitCode(124, 'fortuna');
        expect(e.code).toBe(124);
        expect(typeof e.name).toBe('string');
        expect(typeof e.message).toBe('string');
    });
});

describe('formatExplanation', () => {
    it('renders code + origin + name + message on first line', () => {
        const out = formatExplanation({
            code: 119,
            origin: 'kronos',
            name: 'E_BAD_SCHEMA_VERSION',
            message: 'storage schema mismatch',
        });
        expect(out).toBe('exit 119 (kronos) E_BAD_SCHEMA_VERSION: storage schema mismatch');
    });

    it('appends an indented hint when present', () => {
        const out = formatExplanation({
            code: 161,
            origin: 'fortuna',
            name: 'E_INVALID_BLS_SIGNATURE',
            message: 'aggSig does not verify against cached groupPk',
            hint: 'check DST + alpha pre-image + groupEpoch freshness',
        });
        expect(out).toContain('exit 161 (fortuna) E_INVALID_BLS_SIGNATURE');
        expect(out).toContain('hint: check DST + alpha pre-image + groupEpoch freshness');
    });
});

describe('extractExitCode', () => {
    it('reads `exitCode` from SDK-style error objects', () => {
        expect(extractExitCode({ exitCode: 160 })).toBe(160);
    });

    it('reads `code` as a numeric fallback', () => {
        expect(extractExitCode({ code: 42 })).toBe(42);
    });

    it('parses `exit code N` out of message strings (sandbox errors)', () => {
        expect(extractExitCode(new Error('tx reverted with exit code 171'))).toBe(171);
    });

    it('returns null when no code can be extracted', () => {
        expect(extractExitCode(null)).toBeNull();
        expect(extractExitCode('nope')).toBeNull();
        expect(extractExitCode({ message: 'no code here' })).toBeNull();
        expect(extractExitCode(new Error('plain text'))).toBeNull();
    });

    it('ignores non-numeric `code` (e.g. ECONNRESET strings)', () => {
        expect(extractExitCode({ code: 'ECONNRESET' })).toBeNull();
    });

    it('unwraps one level of `.reason` (the PoolRejectedError shape)', () => {
        // PoolRejectedError stores the inner verify-callback exception as
        // .reason; the outer message is generic ("the wallet tx landed but
        // the pool rejected …"). Unwrapping lets the CLI surface the inner
        // exit code via formatExplanation. This is the H2 fix from the
        // triple-check audit — without it, Atlas reverts on `bls register`
        // print as opaque prose instead of exit-code explanations.
        const inner = Object.assign(new Error('reverted'), { exitCode: 120 });
        const outer = Object.assign(new Error('pool rejected'), { reason: inner });
        expect(extractExitCode(outer)).toBe(120);
    });

    it('unwraps `.cause` (native ES error chaining)', () => {
        const inner = Object.assign(new Error('atlas reverted exit code 121'), {});
        const outer = new Error('wrapped', { cause: inner });
        expect(extractExitCode(outer)).toBe(121);
    });

    it('does not loop on a self-referential `.reason` cycle', () => {
        const cyclic: { reason?: unknown; message: string } = { message: 'no code' };
        cyclic.reason = cyclic;
        // Bounded depth means we just give up and return null instead of
        // hanging or stack-overflowing.
        expect(extractExitCode(cyclic)).toBeNull();
    });

    it('prefers the outer code over a wrapped one', () => {
        // If the outer error already has an exit code, no need to unwrap.
        const inner = Object.assign(new Error('inner'), { exitCode: 999 });
        const outer = Object.assign(new Error('outer'), { exitCode: 42, reason: inner });
        expect(extractExitCode(outer)).toBe(42);
    });
});

describe('extractExplainHint', () => {
    // Companion walker to extractExitCode. Recovers the SDK origin hint
    // off a wrapped error chain so the CLI top-level catch can pass it
    // to explainExitCode and disambiguate cross-SDK code overlaps.

    it('reads .explainHint directly off the error', () => {
        const err = Object.assign(new Error('boom'), { explainHint: 'atlas' });
        expect(extractExplainHint(err)).toBe('atlas');
    });

    it('reads .origin off SDK ErrorExplanation-shaped objects', () => {
        // SDKs (atlas-sdk, etc.) put .origin on their thrown errors.
        const err = { origin: 'fortuna', code: 161, name: 'InvalidBlsSignature' };
        expect(extractExplainHint(err)).toBe('fortuna');
    });

    it("ignores .origin when it's 'unknown' or 'tvm' (no disambiguation value)", () => {
        // Neither 'unknown' nor 'tvm' tells us which custom-code SDK to
        // consult; the priority walk handles those naturally.
        expect(extractExplainHint({ origin: 'unknown' })).toBeUndefined();
        expect(extractExplainHint({ origin: 'tvm' })).toBeUndefined();
    });

    it('unwraps .reason (the PoolRejectedError shape)', () => {
        const inner = Object.assign(new Error('atlas reverted'), { explainHint: 'atlas' });
        const outer = Object.assign(new Error('pool rejected'), { reason: inner });
        expect(extractExplainHint(outer)).toBe('atlas');
    });

    it('unwraps .cause (native ES error chaining)', () => {
        const inner = Object.assign(new Error('forgeton-side'), { origin: 'forgeton' });
        const outer = new Error('wrapped', { cause: inner });
        expect(extractExplainHint(outer)).toBe('forgeton');
    });

    it('does not loop on a self-referential .reason cycle', () => {
        const cyclic: { reason?: unknown; message: string } = { message: 'no hint' };
        cyclic.reason = cyclic;
        expect(extractExplainHint(cyclic)).toBeUndefined();
    });

    it('returns undefined for plain errors without a hint', () => {
        expect(extractExplainHint(new Error('plain'))).toBeUndefined();
        expect(extractExplainHint({ message: 'no chain' })).toBeUndefined();
        expect(extractExplainHint(null)).toBeUndefined();
    });

    it('end-to-end: PoolRejectedError-shaped wrapper → CLI gets right SDK', () => {
        // Simulate what cli/index.ts does: extractExitCode + extractExplainHint
        // → explainExitCode(code, hint). For a PoolRejectedError-shaped object
        // carrying both code and hint, the resolved explanation should match
        // the hinted SDK (not the priority-walk default).
        const wrapper = Object.assign(new Error('pool rejected'), {
            exitCode: 120,
            explainHint: 'atlas',
            reason: new Error('inner'),
        });
        const code = extractExitCode(wrapper);
        const hint = extractExplainHint(wrapper);
        expect(code).toBe(120);
        expect(hint).toBe('atlas');
        const e = explainExitCode(code!, hint);
        expect(e.origin).toBe('atlas');
        expect(e.name).toBe('OperatorNotFound');
    });
});
