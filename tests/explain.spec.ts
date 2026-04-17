// TVM exit-code translation: explainExitCode picks between kronos-sdk
// (100-119), forgeton-sdk (160-182), and TVM (1-100) error tables;
// formatExplanation renders hint-bearing human text; extractExitCode
// pulls numeric codes from SDK errors, numeric fields, and "exit code N"
// substrings in sandbox error messages.

import { explainExitCode, extractExitCode, formatExplanation } from '../src/errors/explain';

describe('explainExitCode', () => {
    it('recognises kronos-specific codes (100-119 range)', () => {
        const e = explainExitCode(119); // E_BAD_SCHEMA_VERSION per kronos/CLAUDE.md
        expect(e.origin).toBe('kronos');
        expect(e.name).toBeDefined();
        expect(e.message).toBeDefined();
    });

    it('recognises forgeton-specific codes (160-182 range)', () => {
        const e = explainExitCode(160);
        // Could be any of the pool codes; just verify the origin flipped.
        expect(e.origin).toBe('forgeton');
    });

    it('recognises TVM reserved codes (1-100)', () => {
        const e = explainExitCode(13); // TVM "out of gas" canonical code
        // Could surface via either SDK's TVM table; we just require origin='tvm'.
        expect(e.origin).toBe('tvm');
    });

    it('surfaces origin=unknown for codes neither SDK recognises', () => {
        const e = explainExitCode(9999);
        expect(e.origin).toBe('unknown');
        expect(e.code).toBe(9999);
    });

    it('returned explanation shape has the required fields', () => {
        const e = explainExitCode(119);
        expect(e.code).toBe(119);
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
            code: 160,
            origin: 'forgeton',
            name: 'E_NOT_REGISTERED',
            message: 'this automaton is not in the pool',
            hint: 'run `automaton stake register`',
        });
        expect(out).toContain('exit 160 (forgeton) E_NOT_REGISTERED');
        expect(out).toContain('hint: run `automaton stake register`');
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
});
