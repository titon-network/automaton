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
});
