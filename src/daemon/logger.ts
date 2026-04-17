// Daemon logger: pino with structural redaction.
//
// REDACT_PATHS covers field names matching `password`, `mnemonic`,
// `privateKey`, `seed`, `secretKey` at top-level AND one level deep
// (pino's `*.x` wildcard doesn't recurse). Every call site must keep
// log-field objects FLAT or nest at most one level — do NOT pass
// `logger.info('x', { foo: { bar: { mnemonic } } })`; pino won't catch
// that redaction path. The existing call sites (~45 as of this
// writing) all follow that convention; new ones should too.
//
// Level filtering via `LogLevel` from config/schema.ts — trace < debug
// < info < warn < error. Defaults to info.

import pino from 'pino';
import type { LogLevel } from '../config/schema';
import type { WorkerLogger } from '../worker/loop';

const REDACT_PATHS: readonly string[] = [
    'password',
    'mnemonic',
    'privateKey',
    'seed',
    'secretKey',
    '*.password',
    '*.mnemonic',
    '*.privateKey',
    '*.seed',
    '*.secretKey',
];

export interface PinoLoggerOptions {
    level?: LogLevel;
    /** Destination stream. Defaults to process.stdout. Tests pass a writable. */
    destination?: NodeJS.WritableStream;
}

/**
 * Production daemon logger. Emits newline-delimited JSON to stdout so
 * systemd-journal / docker-log-driver / promtail can pick it up.
 * Redaction is structural — fields named `password` / `mnemonic` /
 * `privateKey` / `seed` / `secretKey` (at top level OR one level deep)
 * are replaced with `[Redacted]` regardless of call-site discipline.
 */
export function createPinoLogger(options: PinoLoggerOptions = {}): WorkerLogger {
    const dest = options.destination ?? process.stdout;
    const logger = pino(
        {
            level: options.level ?? 'info',
            redact: { paths: [...REDACT_PATHS], censor: '[Redacted]' },
        },
        dest,
    );
    return {
        debug: (msg, fields) => logger.debug(fields ?? {}, msg),
        info: (msg, fields) => logger.info(fields ?? {}, msg),
        warn: (msg, fields) => logger.warn(fields ?? {}, msg),
        error: (msg, fields) => logger.error(fields ?? {}, msg),
    };
}

export const REDACTED_LOG_PATHS: readonly string[] = REDACT_PATHS;
