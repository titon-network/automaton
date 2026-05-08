// createDaemonMetrics: every declared counter/gauge/histogram registers
// with the expected name; the WorkerCounters interface is fully callable
// without throwing; label propagation reaches the scrape output; each
// createDaemonMetrics() call yields an isolated Registry (no global leak).

import { createDaemonMetrics } from '../src/daemon/metrics';

describe('createDaemonMetrics', () => {
    it('registers every declared counter + gauge + histogram name', async () => {
        const metrics = createDaemonMetrics();
        const output = await metrics.registry.metrics();

        for (const name of [
            'automaton_execute_attempts_total',
            'automaton_execute_success_total',
            'automaton_execute_failure_total',
            'automaton_skip_total',
            'automaton_in_flight_collision_total',
            'automaton_wallet_balance_ton',
            'automaton_stake_ton',
            'automaton_active',
            'automaton_slash_count',
            'automaton_pool_active_count',
            'automaton_registry_job_count',
            'automaton_registry_accumulated_fees_ton',
            'automaton_registry_paused',
            'automaton_fortuna_pending_requests',
            'automaton_last_cycle_completed_at_seconds',
            'automaton_self_slash_total',
            'automaton_events_dispatched_total',
            'automaton_drain_capped_total',
            'automaton_cycle_duration_seconds',
        ]) {
            expect(output).toContain(name);
        }
    });

    it('counters implement the WorkerCounters interface — all methods callable', () => {
        const metrics = createDaemonMetrics();
        expect(() =>
            metrics.counters.incrementExecuteAttempt('never-executed'),
        ).not.toThrow();
        expect(() =>
            metrics.counters.incrementExecuteSuccess('primary-self'),
        ).not.toThrow();
        expect(() =>
            metrics.counters.incrementExecuteFailure('fallback', 'rpc-timeout'),
        ).not.toThrow();
        expect(() => metrics.counters.incrementSkip('too-early')).not.toThrow();
        expect(() => metrics.counters.incrementInFlightCollision()).not.toThrow();
    });

    it('counter labels propagate to the scrape output', async () => {
        const metrics = createDaemonMetrics();
        metrics.counters.incrementExecuteSuccess('primary-self');
        metrics.counters.incrementExecuteFailure('fallback', 'pool-rejected');

        const output = await metrics.registry.metrics();
        expect(output).toMatch(/automaton_execute_success_total\{reason="primary-self"\} 1/);
        expect(output).toMatch(
            /automaton_execute_failure_total\{reason="fallback",errorClass="pool-rejected"\} 1/,
        );
    });

    it('each registry instance is isolated — tests do not leak state', async () => {
        const a = createDaemonMetrics();
        const b = createDaemonMetrics();
        a.counters.incrementSkip('inactive');

        const aOut = await a.registry.metrics();
        const bOut = await b.registry.metrics();
        // prom-client only emits a label combination once it has been
        // observed — so B's output lacks the `{reason="inactive"}` row
        // entirely, proving state didn't leak across registries.
        expect(aOut).toMatch(/automaton_skip_total\{reason="inactive"\} 1/);
        expect(bOut).not.toMatch(/automaton_skip_total\{reason="inactive"\}/);
    });

    it('cycle histogram surfaces configured buckets', async () => {
        const metrics = createDaemonMetrics();
        metrics.cycleDuration.observe(0.3);
        const output = await metrics.registry.metrics();
        // Histograms emit `<name>_bucket`, `<name>_sum`, `<name>_count`.
        expect(output).toMatch(/automaton_cycle_duration_seconds_bucket/);
        expect(output).toMatch(/automaton_cycle_duration_seconds_count 1/);
    });
});
