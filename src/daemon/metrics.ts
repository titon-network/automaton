// Single source of truth for daemon metrics. Every counter + gauge
// the process publishes lives here, named + documented in one file so
// an operator setting up Grafana can read it end-to-end.
//
// The returned `DaemonMetrics` bundle exposes:
//   - `counters` — implements the worker's `WorkerCounters` interface
//     so `runWorkerCycle` just calls `deps.counters.incrementXxx(...)`
//     without knowing prom-client exists
//   - `gauges` — wallet balance, stake, active-count, drift, etc. —
//     updated out-of-band by the orchestrator after each cycle
//   - `cycleDuration` — a histogram the orchestrator wraps around every
//     tick so Grafana can chart p50/p99
//   - `registry` — the prom-client Registry instance, passed to the
//     HTTP server for /metrics serialization
//
// NAMING CONVENTION: `automaton_<subsystem>_<metric>[_unit]`. Labels
// stay bounded — use `DecisionReason` tag for per-reason breakdowns,
// `ExecuteFailureClass` for failures (see worker/loop.ts).

import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { Decision } from '../worker/decide';
import type { ExecuteFailureClass, WorkerCounters } from '../observability';

export interface DaemonMetrics {
    registry: Registry;
    /** Decision/outcome counters produced by the worker cycle. */
    counters: WorkerCounters;
    /** Observed-state gauges (snapshot path). */
    gauges: {
        walletBalance: Gauge<string>;
        automatonStake: Gauge<string>;
        automatonActive: Gauge<string>;
        automatonSlashCount: Gauge<string>;
        activeAutomatonCount: Gauge<string>;
        syncesReceived: Gauge<string>;
        slashesRequested: Gauge<string>;
        lastCycleCompletedAt: Gauge<string>;
    };
    /**
     * Event-subscriber counters. Separate from `counters` (which is the
     * worker-decision API) and `gauges` (which are point-in-time
     * snapshots) because these are drain-side, monotonic, and only
     * touched by the orchestrator.
     */
    eventCounters: {
        selfSlash: Counter<string>;
        drainDispatched: Counter<'source'>;
        drainCapped: Counter<'source'>;
    };
    cycleDuration: Histogram<string>;
}

/**
 * Build the metrics bundle. Use a fresh Registry — the default global
 * registry leaks state across test runs; tests that instantiate this
 * more than once stay isolated.
 */
export function createDaemonMetrics(): DaemonMetrics {
    const registry = new Registry();

    const attempts = new Counter({
        name: 'automaton_execute_attempts_total',
        help: 'Execute submissions initiated, labelled by the decide-tree reason tag.',
        labelNames: ['reason'] as const,
        registers: [registry],
    });
    const successes = new Counter({
        name: 'automaton_execute_success_total',
        help: 'Execute submissions verified against post-state.',
        labelNames: ['reason'] as const,
        registers: [registry],
    });
    const failures = new Counter({
        name: 'automaton_execute_failure_total',
        help: 'Execute submissions that failed or reverted.',
        labelNames: ['reason', 'errorClass'] as const,
        registers: [registry],
    });
    const skips = new Counter({
        name: 'automaton_skip_total',
        help: 'Jobs skipped with no Execute attempt, labelled by reason.',
        labelNames: ['reason'] as const,
        registers: [registry],
    });
    const inFlightCollisions = new Counter({
        name: 'automaton_in_flight_collision_total',
        help: 'Cycles where a jobId was already mid-submit from a prior tick.',
        registers: [registry],
    });

    const counters: WorkerCounters = {
        incrementExecuteAttempt: (reason) => attempts.inc({ reason }),
        incrementExecuteSuccess: (reason) => successes.inc({ reason }),
        incrementExecuteFailure: (reason: Decision['reason'], errorClass: ExecuteFailureClass) =>
            failures.inc({ reason, errorClass }),
        incrementSkip: (reason) => skips.inc({ reason }),
        incrementInFlightCollision: () => inFlightCollisions.inc(),
    };

    const gauge = (name: string, help: string): Gauge<string> =>
        new Gauge({ name, help, registers: [registry] });

    const gauges = {
        walletBalance: gauge('automaton_wallet_balance_ton', 'Current wallet balance in TON.'),
        automatonStake: gauge('automaton_stake_ton', 'Current collateral staked in the pool, in TON.'),
        automatonActive: gauge('automaton_active', 'Is this automaton currently active in the pool (1) or not (0).'),
        automatonSlashCount: gauge(
            'automaton_slash_count',
            'Cumulative slashes this automaton has taken since registration.',
        ),
        activeAutomatonCount: gauge(
            'automaton_pool_active_count',
            'Number of active automatons in the pool — affects assignment rotation.',
        ),
        syncesReceived: gauge(
            'automaton_registry_syncs_received',
            'Registry-side count of AutomatonSync messages received from the pool.',
        ),
        slashesRequested: gauge(
            'automaton_registry_slashes_requested',
            'Registry-side count of Slash messages sent to the pool.',
        ),
        lastCycleCompletedAt: gauge(
            'automaton_last_cycle_completed_at_seconds',
            'Unix timestamp when the last poll cycle finished. /healthz flips FAIL when now − this > 2×pollIntervalMs.',
        ),
    };

    const eventCounters = {
        selfSlash: new Counter({
            name: 'automaton_self_slash_total',
            help: 'Times this wallet has been slashed (AutomatonSlashed event observed).',
            registers: [registry],
        }),
        drainDispatched: new Counter({
            name: 'automaton_events_dispatched_total',
            help: 'Event bodies decoded + dispatched by drainEvents, labelled by source (registry or pool).',
            labelNames: ['source'] as const,
            registers: [registry],
        }),
        drainCapped: new Counter({
            name: 'automaton_drain_capped_total',
            help: 'drainEvents hits maxPages — backlog exceeded the ceiling.',
            labelNames: ['source'] as const,
            registers: [registry],
        }),
    };

    const cycleDuration = new Histogram({
        name: 'automaton_cycle_duration_seconds',
        help: 'End-to-end wall time of one poll cycle (drain + worker).',
        buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
        registers: [registry],
    });

    return { registry, counters, gauges, eventCounters, cycleDuration };
}
