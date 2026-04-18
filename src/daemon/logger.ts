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
// Stack traces are an exception worth calling out: pino redacts by
// KEY, not by string content. If a caller logs `{ stack: err.stack }`,
// anything embedded in the stack string — V8's auto-captured locals,
// operator-custom `Error.prepareStackTrace` output, or an error whose
// `toString` embedded a secret — flows through verbatim. Don't pass
// raw errors/stacks that could have touched keystore state; wrap them
// in `err.message`-only surfaces first. The uncaught-exception path
// accepts the tradeoff (operators need stacks to debug crashes).
//
// Level filtering via `LogLevel` from config/schema.ts — trace < debug
// < info < warn < error. Defaults to info.

import pino from 'pino';
import type { LogLevel } from '../config/schema';
import type { WorkerLogger } from '../observability';

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

/**
 * Output format selector.
 *   'json'   — newline-delimited JSON (default production shape; systemd /
 *              docker / promtail parse this directly).
 *   'pretty' — human-friendly colourised output via pino-pretty. Use for
 *              interactive `automaton run` sessions.
 *   'auto'   — pretty if stdout is a TTY, json otherwise. Default.
 */
export type LogFormat = 'json' | 'pretty' | 'auto';

export interface PinoLoggerOptions {
    level?: LogLevel;
    /** Destination stream. Defaults to process.stdout. Tests pass a writable. */
    destination?: NodeJS.WritableStream;
    /** Output format selector. Ignored when `destination` is set (tests). */
    format?: LogFormat;
}

function resolvePretty(format: LogFormat | undefined, dest: NodeJS.WritableStream): boolean {
    if (format === 'pretty') return true;
    if (format === 'json') return false;
    // 'auto' (or undefined): pretty iff the destination is a TTY. Only
    // process.stdout / process.stderr carry isTTY; arbitrary writable
    // streams (test harnesses) are treated as non-TTY → json.
    const maybeTty = dest as NodeJS.WritableStream & { isTTY?: boolean };
    return Boolean(maybeTty.isTTY);
}

/**
 * Production daemon logger. Defaults to newline-delimited JSON so
 * systemd-journal / docker-log-driver / promtail can parse it directly;
 * switches to pino-pretty output when stdout is a TTY (or when
 * `format: 'pretty'` is forced) for interactive runs.
 *
 * Redaction is structural — fields named `password` / `mnemonic` /
 * `privateKey` / `seed` / `secretKey` (at top level OR one level deep)
 * are replaced with `[Redacted]` regardless of call-site discipline.
 * Redaction applies in both json and pretty modes.
 */
export function createPinoLogger(options: PinoLoggerOptions = {}): WorkerLogger {
    const dest = options.destination ?? process.stdout;
    const pretty = options.destination === undefined && resolvePretty(options.format, dest);

    const baseOpts: pino.LoggerOptions = {
        level: options.level ?? 'info',
        redact: { paths: [...REDACT_PATHS], censor: '[Redacted]' },
    };

    // Pretty mode: let pino spawn a worker thread that loads pino-pretty.
    // Falls back to JSON if the dep is missing at runtime (best-effort —
    // pino throws on worker failure, so the catch re-creates a plain logger).
    if (pretty) {
        try {
            const prettyLogger = pino({
                ...baseOpts,
                transport: {
                    target: 'pino-pretty',
                    options: {
                        colorize: true,
                        translateTime: 'SYS:HH:MM:ss.l',
                        ignore: 'pid,hostname',
                        singleLine: false,
                    },
                },
            });
            return wrap(prettyLogger);
        } catch {
            // Fall through to JSON mode; pino-pretty likely missing.
        }
    }

    return wrap(pino(baseOpts, dest));
}

function wrap(logger: pino.Logger): WorkerLogger {
    return {
        debug: (msg, fields) => logger.debug(fields ?? {}, msg),
        info: (msg, fields) => logger.info(fields ?? {}, msg),
        warn: (msg, fields) => logger.warn(fields ?? {}, msg),
        error: (msg, fields) => logger.error(fields ?? {}, msg),
    };
}

export const REDACTED_LOG_PATHS: readonly string[] = REDACT_PATHS;
