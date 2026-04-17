// Cross-cutting observability primitives: the logger interface the
// daemon + worker share, the counter interface `runWorkerCycle` invokes,
// and the bounded failure taxonomy they both reference.
//
// Lives outside `src/daemon/` and `src/worker/` because both consume it;
// anchoring it to either side forces the other to back-import, which
// muddies the layering. Treat this as the "observability contract"
// every subsystem publishes against.
//
// Why a separate module (not `src/util/`):
//   - `src/util/` is for standalone pure helpers (atomic-write).
//   - Observability contracts are a concept layer — logging, metrics
//     counters, failure taxonomies — that deserve their own home.

import type { Decision } from '../worker/decide';

export interface WorkerLogger {
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
}

export const SILENT_LOGGER: WorkerLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
};

/**
 * Bounded error-class tags for failed Execute submissions — these become
 * Prometheus labels, so cardinality must stay finite. Do NOT add raw RPC
 * messages here.
 *
 * The `reason` label domain lives on `Decision['reason']` in
 * src/worker/decide.ts; both together make up the full
 * `automaton_execute_failure_total` label space.
 */
export type ExecuteFailureClass =
    | 'rpc-timeout'
    | 'pool-rejected'
    | 'tx-attribution'
    | 'confirmation-timeout'
    | 'verify-failed'
    | 'other';

/**
 * Counter surface the worker cycle invokes on every decision. Satisfied
 * by `createDaemonMetrics().counters` in production and `NOOP_COUNTERS`
 * in tests. A fresh decision-reason tag gets wired through here + into
 * the metric declaration in one change.
 */
export interface WorkerCounters {
    incrementExecuteAttempt(reason: Decision['reason']): void;
    incrementExecuteSuccess(reason: Decision['reason']): void;
    /** `reason` is the decide-tree tag; `errorClass` is a bounded failure taxonomy. */
    incrementExecuteFailure(reason: Decision['reason'], errorClass: ExecuteFailureClass): void;
    incrementSkip(reason: Decision['reason']): void;
    incrementInFlightCollision(): void;
}

export const NOOP_COUNTERS: WorkerCounters = {
    incrementExecuteAttempt: () => {},
    incrementExecuteSuccess: () => {},
    incrementExecuteFailure: () => {},
    incrementSkip: () => {},
    incrementInFlightCollision: () => {},
};
