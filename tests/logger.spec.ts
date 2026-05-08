// createPinoLogger: structural secret redaction (top-level + one level deep),
// LogLevel filter enforcement across trace/debug/info/warn/error, timestamp
// + level field emission. The redact list doubles as a grep target for
// "don't log this plaintext" audits.

import { Writable } from 'stream';
import { createPinoLogger, REDACTED_LOG_PATHS } from '../src/daemon/logger';

function captureWrites(): { stream: Writable; lines: () => unknown[] } {
    const buffer: string[] = [];
    const stream = new Writable({
        write(chunk, _encoding, cb) {
            buffer.push(chunk.toString('utf8'));
            cb();
        },
    });
    return {
        stream,
        lines: () =>
            buffer
                .join('')
                .split('\n')
                .filter((s) => s.length > 0)
                .map((line) => JSON.parse(line)),
    };
}

describe('createPinoLogger redaction', () => {
    it('redacts top-level secret-named fields', () => {
        const { stream, lines } = captureWrites();
        const log = createPinoLogger({ destination: stream });

        log.info('ok', { password: 'hunter2', username: 'alice' });

        const [record] = lines();
        expect(record).toMatchObject({
            msg: 'ok',
            password: '[Redacted]',
            username: 'alice',
        });
    });

    it('redacts one-level-deep secret-named fields', () => {
        const { stream, lines } = captureWrites();
        const log = createPinoLogger({ destination: stream });

        log.info('ok', { payload: { mnemonic: 'abandon ability ...', note: 'hi' } });

        const [record] = lines();
        expect((record as { payload: { mnemonic: string; note: string } }).payload).toEqual({
            mnemonic: '[Redacted]',
            note: 'hi',
        });
    });

    it('redacts privateKey and seed variants', () => {
        const { stream, lines } = captureWrites();
        const log = createPinoLogger({ destination: stream });

        log.info('ok', {
            privateKey: 'deadbeef',
            seed: 'badc0ffee',
            secretKey: 'abcdef',
        });

        const [record] = lines();
        expect(record).toMatchObject({
            privateKey: '[Redacted]',
            seed: '[Redacted]',
            secretKey: '[Redacted]',
        });
    });

    it('emits msg + level + timestamp on every record', () => {
        const { stream, lines } = captureWrites();
        const log = createPinoLogger({ destination: stream, level: 'debug' });

        log.debug('dbg');
        log.info('i');
        log.warn('w');
        log.error('e');

        const rows = lines();
        expect(rows).toHaveLength(4);
        for (const row of rows) {
            const r = row as { msg: string; level: number; time: number };
            expect(r.msg).toBeDefined();
            expect(r.level).toBeDefined();
            expect(r.time).toBeDefined();
        }
    });

    it('filters out records below the configured level', () => {
        const { stream, lines } = captureWrites();
        const log = createPinoLogger({ destination: stream, level: 'warn' });

        log.debug('dbg');
        log.info('i');
        log.warn('w');
        log.error('e');

        expect(lines()).toHaveLength(2);
    });

    it('exposes REDACTED_LOG_PATHS for documentation / auditing', () => {
        expect(REDACTED_LOG_PATHS).toContain('password');
        expect(REDACTED_LOG_PATHS).toContain('mnemonic');
        expect(REDACTED_LOG_PATHS).toContain('privateKey');
        expect(REDACTED_LOG_PATHS).toContain('seed');
        expect(REDACTED_LOG_PATHS).toContain('secretKey');
    });

    // --------------------------------------------------------------
    // Deep-nesting redaction. Pino's wildcard is single-segment, so
    // N-deep redaction needs N explicit `*.*…` patterns. We cover up to
    // 3 levels because the wallet object — the deepest real shape we
    // log — tops out at wallet.keyPair.secretKey (2 deep).
    // --------------------------------------------------------------

    it('redacts two-level-deep secret-named fields', () => {
        const { stream, lines } = captureWrites();
        const log = createPinoLogger({ destination: stream });

        log.info('ok', { ctx: { request: { password: 'leak-2' } } });

        const [record] = lines();
        const r = record as { ctx: { request: { password: string } } };
        expect(r.ctx.request.password).toBe('[Redacted]');
    });

    it('redacts three-level-deep secret-named fields', () => {
        const { stream, lines } = captureWrites();
        const log = createPinoLogger({ destination: stream });

        log.info('ok', { a: { b: { c: { secretKey: 'leak-3' } } } });

        const [record] = lines();
        const r = record as { a: { b: { c: { secretKey: string } } } };
        expect(r.a.b.c.secretKey).toBe('[Redacted]');
    });

    it('redacts the canonical wallet shape (wallet.mnemonic + wallet.keyPair.secretKey)', () => {
        const { stream, lines } = captureWrites();
        const log = createPinoLogger({ destination: stream });

        log.info('ok', {
            wallet: {
                address: '0Q...',
                mnemonic: ['abandon', 'ability', 'able'],
                keyPair: {
                    publicKey: 'pub',
                    secretKey: 'CANARY-SHOULD-NOT-APPEAR',
                },
            },
        });

        const [record] = lines();
        const serialized = JSON.stringify(record);
        // Address is intentionally non-secret; verify it survives.
        expect(serialized).toContain('0Q...');
        // Both secret paths are masked.
        expect(serialized).not.toContain('CANARY-SHOULD-NOT-APPEAR');
        expect(serialized).not.toContain('abandon');
        expect(serialized).toContain('[Redacted]');
    });

    it('redaction patterns include depth-3 wildcards + canonical wallet paths', () => {
        // Drift guard: if someone trims REDACT_PATHS thinking they're
        // dead code, this test catches it.
        expect(REDACTED_LOG_PATHS).toContain('*.*.password');
        expect(REDACTED_LOG_PATHS).toContain('*.*.*.secretKey');
        expect(REDACTED_LOG_PATHS).toContain('wallet.mnemonic');
        expect(REDACTED_LOG_PATHS).toContain('wallet.keyPair.secretKey');
    });
});
