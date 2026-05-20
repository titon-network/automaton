// Shared test helpers for log capture + silent loggers. The `with-fields`
// shape (records msg + structured fields) is the production logger
// surface — this is what every handler test ends up needing.

import type { WorkerLogger } from '../../src/worker/loop';

export interface CapturedMessage {
    level: 'debug' | 'info' | 'warn' | 'error';
    msg: string;
    fields?: Record<string, unknown>;
}

export interface CapturedLogger {
    log: WorkerLogger;
    messages: CapturedMessage[];
}

/** A WorkerLogger that records every call. Useful for asserting on
 *  log level + message + structured fields across handler dispatch. */
export function captureLogger(): CapturedLogger {
    const messages: CapturedMessage[] = [];
    const collect = (level: CapturedMessage['level']) =>
        (msg: string, fields?: Record<string, unknown>) => {
            messages.push({ level, msg, ...(fields ? { fields } : {}) });
        };
    return {
        log: {
            debug: collect('debug'),
            info: collect('info'),
            warn: collect('warn'),
            error: collect('error'),
        },
        messages,
    };
}

/** A WorkerLogger that drops everything. Use when the test asserts only
 *  on side-effects elsewhere and log noise would clutter the run output. */
export function silentLogger(): WorkerLogger {
    return {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
    };
}
