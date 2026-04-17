// Minimal stdout/stderr logger for the daemon. Structured JSON-ish
// one-liners so operators can `| jq` or grep. D.11 swaps this for
// `pino` with redaction; the `WorkerLogger` interface shape matches
// so callers don't need to know which backend they have.
//
// Level filtering via the `LogLevel` from config/schema.ts — trace <
// debug < info < warn < error. Defaults to info.

import type { LogLevel } from '../config/schema';
import type { WorkerLogger } from '../worker/loop';

const LEVEL_ORDER: Record<LogLevel, number> = {
    trace: 0,
    debug: 1,
    info: 2,
    warn: 3,
    error: 4,
};

export interface ConsoleLoggerOptions {
    level?: LogLevel;
    /** Process PID surfaced in every record — useful when multiple daemons run under systemd. */
    pid?: number;
}

export function createConsoleLogger(options: ConsoleLoggerOptions = {}): WorkerLogger {
    const level = options.level ?? 'info';
    const minOrder = LEVEL_ORDER[level];
    const pid = options.pid ?? process.pid;

    const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
        if (LEVEL_ORDER[lvl] < minOrder) return;
        const record = {
            ts: new Date().toISOString(),
            level: lvl,
            pid,
            msg,
            ...(fields ?? {}),
        };
        const stream = lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout;
        stream.write(JSON.stringify(record) + '\n');
    };

    return {
        debug: (msg, fields) => emit('debug', msg, fields),
        info: (msg, fields) => emit('info', msg, fields),
        warn: (msg, fields) => emit('warn', msg, fields),
        error: (msg, fields) => emit('error', msg, fields),
    };
}
