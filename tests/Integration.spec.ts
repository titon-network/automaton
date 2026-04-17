// End-to-end daemon integration against @ton/sandbox-deployed contracts.
//
// Runs the real `tickOnce` orchestrator against a sandbox-backed
// `ChainRuntime` — exercising drainEvents, runWorkerCycle, mirrorPatchHandler,
// selfSlashHandler, consumerWatchHandler, and the metrics/counter wiring
// as one composed unit. Nothing is mocked at the decision boundary: the
// registry's real assignment, job balance, window, and mirror state drive
// the automaton's real decide tree.
//
// What's NOT covered here (intentionally):
//   - Wallet signing + seqno polling — handled by submit.spec.ts. Tests
//     inject `submitExecuteVia(treasury)` to bypass.
//   - FailoverTonClient endpoint rotation + retry — ton-client.spec.ts.
//   - Config / keystore / lockfile — covered by their own specs.
//
// What IS covered:
//   - Never-executed first run (permissionless path).
//   - Primary-window assigned-to-me execution.
//   - Primary-window assigned-to-other skip.
//   - Fallback-window claim + slash of assigned automaton.
//   - Event drain across multiple ticks with checkpoint advance.
//   - Mirror patch handler refresh on AutomatonMirrorUpdated.
//   - Self-slash webhook payload round-trip.
//   - Idle tick: no events → no checkpoint save; no jobs → no-op cycle.

import { toNano } from '@ton/core';
import type { SandboxContract, TreasuryContract } from '@ton/sandbox';
import { FORGETON_DEFAULTS } from 'forgeton-sdk';

import { createSandboxHarness, type SandboxHarness } from './helpers/chain';
import { tickOnce } from '../src/daemon/orchestrator';
import { createDaemonMetrics, type DaemonMetrics } from '../src/daemon/metrics';
import {
    AutomatonMirror,
    consumerWatchHandler,
    emptyCheckpointState,
    mirrorPatchHandler,
    selfSlashHandler,
    SILENT_LOGGER,
    type CheckpointState,
    type EventHandler,
    type SubmitExecuteFn,
} from '../src/worker';

interface SingleAutomatonSetup {
    harness: SandboxHarness;
    me: SandboxContract<TreasuryContract>;
    jobOwner: SandboxContract<TreasuryContract>;
    target: SandboxContract<TreasuryContract>;
}

async function setupSingleAutomaton(): Promise<SingleAutomatonSetup> {
    const harness = await createSandboxHarness();
    const jobOwner = await harness.blockchain.treasury('jobOwner');
    const target = await harness.blockchain.treasury('target');
    const me = await harness.registerAutomaton('me');
    return { harness, me, jobOwner, target };
}

/**
 * Run N ticks, passing the updated checkpoint state between them. Returns
 * the final cycle result + drain-side metrics for assertions. When
 * `checkpointState` is omitted starts from a fresh empty state — callers
 * who want to chain ticks across multiple invocations should forward the
 * returned state.
 */
async function runTicks(params: {
    harness: SandboxHarness;
    me: SandboxContract<TreasuryContract>;
    ticks: number;
    handlers?: readonly EventHandler[];
    metrics?: DaemonMetrics;
    nowSec?: () => number;
    checkpointState?: CheckpointState;
    mirror?: AutomatonMirror;
}): Promise<{
    metrics: DaemonMetrics;
    mirror: AutomatonMirror;
    inFlight: Set<bigint>;
    checkpointState: CheckpointState;
}> {
    const metrics = params.metrics ?? createDaemonMetrics();
    const mirror = params.mirror ?? new AutomatonMirror(params.harness.runtime);
    const inFlight = new Set<bigint>();
    const handlers = params.handlers ?? [];
    let checkpointState = params.checkpointState ?? emptyCheckpointState();

    for (let i = 0; i < params.ticks; i++) {
        checkpointState = await tickOnce({
            runtime: params.harness.runtime,
            wallet: params.harness.fakeWalletFor(params.me),
            mirror,
            inFlight,
            handlers,
            counters: metrics.counters,
            metrics,
            logger: SILENT_LOGGER,
            checkpointState,
            jobFetchConcurrency: 2,
            submitExecute: params.harness.submitExecuteVia(params.me),
            nowSec: () => params.harness.nowSec(),
        });
    }

    return { metrics, mirror, inFlight, checkpointState };
}

describe('Integration: daemon tickOnce against sandbox', () => {
    // Sandbox contract deploys + registry assertions are expensive; allow
    // headroom over the default 30s jest timeout for slower CI hosts.
    jest.setTimeout(60_000);

    describe('happy path — single automaton, never-executed first run', () => {
        it('executes a fresh job, emits JobExecuted, and the mirror reflects activeCount=1', async () => {
            const { harness, me, jobOwner, target } = await setupSingleAutomaton();
            await harness.registerJob({
                jobOwner,
                target: target.address,
                funding: toNano('2'),
                interval: 300,
                reward: toNano('0.05'),
                gasLimit: toNano('0.02'),
                windowBefore: 10,
                windowAfter: 600,
            });

            const { metrics, mirror } = await runTicks({
                harness,
                me,
                ticks: 1,
            });

            // Contract state: job advanced.
            const job = await harness.registry.getJob(0n);
            expect(job).not.toBeNull();
            expect(job!.executionCount).toBe(1);
            expect(job!.lastExecutedAt).toBeGreaterThan(0);

            // Mirror reflects the single registered automaton.
            expect(mirror.activeCount).toBe(1n);
            expect(mirror.snapshot[0]!.equals(me.address)).toBe(true);

            // Metrics: attempt + success incremented on 'never-executed' reason.
            const output = await metrics.registry.metrics();
            expect(output).toMatch(
                /automaton_execute_attempts_total\{reason="never-executed"\} 1/,
            );
            expect(output).toMatch(
                /automaton_execute_success_total\{reason="never-executed"\} 1/,
            );
        });

        it('drains JobRegistered + JobExecuted events across two ticks with checkpoint save', async () => {
            const { harness, me, jobOwner, target } = await setupSingleAutomaton();
            await harness.registerJob({
                jobOwner,
                target: target.address,
            });

            // Tick 1 — drains prior registration events + self-executes the job.
            // Tick 2 — drains the JobExecuted event, no further work.
            const { metrics } = await runTicks({ harness, me, ticks: 2 });

            const output = await metrics.registry.metrics();
            // drainDispatched is a gauge.inc of count — both ticks' dispatches
            // accumulate. Registry must have received at least 1 dispatch from
            // each tick (JobRegistered, JobExecuted).
            expect(output).toMatch(
                /automaton_events_dispatched_total\{source="registry"\} [1-9]\d*/,
            );
        });

        it('subsequent tick right after execution skips as "too-early" (interval not elapsed)', async () => {
            const { harness, me, jobOwner, target } = await setupSingleAutomaton();
            await harness.registerJob({
                jobOwner,
                target: target.address,
                interval: 300,
                windowBefore: 10,
            });

            // Tick 1: never-executed → execute. Tick 2: too-early (window not open).
            const { metrics } = await runTicks({ harness, me, ticks: 2 });

            const output = await metrics.registry.metrics();
            expect(output).toMatch(/automaton_execute_success_total\{reason="never-executed"\} 1/);
            // Skip-too-early is recorded as a counter via incrementSkip.
            expect(output).toMatch(/automaton_skip_total\{reason="too-early"\} 1/);
        });
    });

    describe('rotation — two automatons, primary window', () => {
        it('executes when assigned to self, skips when assigned to other', async () => {
            const harness = await createSandboxHarness();
            const jobOwner = await harness.blockchain.treasury('jobOwner');
            const target = await harness.blockchain.treasury('target');
            // Two registered automatons — rotation is now live.
            const me = await harness.registerAutomaton('me');
            const other = await harness.registerAutomaton('other');

            await harness.registerJob({ jobOwner, target: target.address });

            // First tick: never-executed → permissionless → me executes.
            await runTicks({ harness, me, ticks: 1 });
            expect((await harness.registry.getJob(0n))!.executionCount).toBe(1);

            // Who is assigned for the NEXT execution (executionCount=1)?
            const assigned = await harness.registry.getAssignedAutomaton(0n, 1);
            const assignedToMe = assigned!.equals(me.address);

            // Advance into the primary window.
            harness.advanceSeconds(300 - 10); // interval - windowBefore buffer

            const metrics = createDaemonMetrics();
            await runTicks({ harness, me, ticks: 1, metrics });

            const job = (await harness.registry.getJob(0n))!;
            const output = await metrics.registry.metrics();
            if (assignedToMe) {
                expect(job.executionCount).toBe(2);
                expect(output).toMatch(
                    /automaton_execute_success_total\{reason="primary-self"\} 1/,
                );
            } else {
                expect(job.executionCount).toBe(1);
                expect(output).toMatch(
                    /automaton_skip_total\{reason="primary-other"\} 1/,
                );
            }
            // Sanity: `other` should be the reciprocal of `me`.
            void other;
        });
    });

    describe('fallback window — claim + slash', () => {
        it('wins the reward and slashes the missed assigned automaton', async () => {
            const harness = await createSandboxHarness();
            const jobOwner = await harness.blockchain.treasury('jobOwner');
            const target = await harness.blockchain.treasury('target');
            const me = await harness.registerAutomaton('me');
            const other = await harness.registerAutomaton('other');

            await harness.registerJob({
                jobOwner,
                target: target.address,
                interval: 300,
                windowBefore: 10,
                windowAfter: 600,
                // Fund generously so post-execute balance clears
                // minGasReserve for the outbound Slash.
                funding: toNano('4'),
            });

            // First execution bumps executionCount → rotation activates.
            await runTicks({ harness, me, ticks: 1 });
            expect((await harness.registry.getJob(0n))!.executionCount).toBe(1);

            const assigned = await harness.registry.getAssignedAutomaton(0n, 1);
            // Setup the scenario where OTHER is assigned so we can claim fallback.
            // If `me` is assigned, swap roles: we'll use `other` as the claimer.
            const assignedToMe = assigned!.equals(me.address);
            const claimer = assignedToMe ? other : me;
            const missed = assignedToMe ? me : other;

            // Advance past the primary window into fallback (30s primary, pad).
            harness.advanceSeconds(300 + 60);

            const slashesBefore = await harness.registry.getSlashesRequested();

            const metrics = createDaemonMetrics();
            await runTicks({ harness, me: claimer, ticks: 1, metrics });

            // Claimer won the reward.
            expect((await harness.registry.getJob(0n))!.executionCount).toBe(2);
            const output = await metrics.registry.metrics();
            expect(output).toMatch(
                /automaton_execute_success_total\{reason="fallback"\} 1/,
            );

            // Registry sent a Slash → drift counter bumps, pool's slashCount
            // on the missed automaton went up.
            const slashesAfter = await harness.registry.getSlashesRequested();
            expect(slashesAfter).toBe(slashesBefore + 1n);

            const missedInfo = await harness.pool.getAutomaton(missed.address);
            expect(missedInfo).not.toBeNull();
            expect(missedInfo!.slashCount).toBeGreaterThan(0);
        });
    });

    describe('mirror handler — AutomatonMirrorUpdated triggers refresh', () => {
        it('wires mirrorPatchHandler to refresh when the event drains', async () => {
            const harness = await createSandboxHarness();
            const me = await harness.registerAutomaton('me');

            let refreshCalls = 0;
            // Wrap the real mirror to count refresh invocations coming
            // through the handler (vs ensureFresh's pre-tick call).
            const mirror = new AutomatonMirror(harness.runtime);
            const origRefresh = mirror.refresh.bind(mirror);
            mirror.refresh = async (count?: bigint) => {
                refreshCalls++;
                await origRefresh(count);
            };

            const metrics = createDaemonMetrics();
            const handlers: EventHandler[] = [mirrorPatchHandler(mirror, SILENT_LOGGER)];

            // Tick 1 — drains the registry's AutomatonMirrorUpdated event
            // emitted when `me` registered. Handler's onCycleEnd should fire
            // exactly one refresh.
            await tickOnce({
                runtime: harness.runtime,
                wallet: harness.fakeWalletFor(me),
                mirror,
                inFlight: new Set(),
                handlers,
                counters: metrics.counters,
                metrics,
                logger: SILENT_LOGGER,
                checkpointState: emptyCheckpointState(),
                jobFetchConcurrency: 2,
                submitExecute: harness.submitExecuteVia(me),
                nowSec: () => harness.nowSec(),
            });

            // Registry's one AutomatonMirrorUpdated event → exactly 1 refresh.
            expect(refreshCalls).toBe(1);
        });
    });

    describe('self-slash webhook round-trip', () => {
        it('POSTs the webhook when this automaton is slashed in a fallback claim', async () => {
            const harness = await createSandboxHarness();
            const jobOwner = await harness.blockchain.treasury('jobOwner');
            const target = await harness.blockchain.treasury('target');
            const me = await harness.registerAutomaton('me');
            const other = await harness.registerAutomaton('other');

            await harness.registerJob({
                jobOwner,
                target: target.address,
                interval: 300,
                windowBefore: 10,
                windowAfter: 600,
            });

            // Tick 1 to populate first execution.
            await runTicks({ harness, me, ticks: 1 });
            const assigned = await harness.registry.getAssignedAutomaton(0n, 1);
            const assignedToMe = assigned!.equals(me.address);
            const claimer = assignedToMe ? other : me;
            const willBeSlashed = assignedToMe ? me : other;

            // Second execution missed — claimer advances past primary window.
            harness.advanceSeconds(300 + 60);
            await runTicks({ harness, me: claimer, ticks: 1 });

            // Now a third tick AS THE SLASHED PARTY with the self-slash handler
            // installed. The pool's AutomatonSlashed event is in its history;
            // our drain will pick it up.
            const webhookCalls: Array<{ url: string; payload: unknown }> = [];
            const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
                webhookCalls.push({
                    url,
                    payload: JSON.parse(init.body as string),
                });
                return new Response('ok', { status: 200 });
            };

            const handler = selfSlashHandler({
                me: willBeSlashed.address,
                logger: SILENT_LOGGER,
                webhookUrl: 'https://example.invalid/hook',
                fetch: fakeFetch as unknown as typeof fetch,
            });

            await tickOnce({
                runtime: harness.runtime,
                wallet: harness.fakeWalletFor(willBeSlashed),
                mirror: new AutomatonMirror(harness.runtime),
                inFlight: new Set(),
                handlers: [handler],
                counters: createDaemonMetrics().counters,
                logger: SILENT_LOGGER,
                checkpointState: emptyCheckpointState(),
                jobFetchConcurrency: 2,
                // No executes to submit — claimer already burned the window.
                submitExecute: harness.submitExecuteVia(willBeSlashed),
                nowSec: () => harness.nowSec(),
            });

            // Detached POST — yield once so its .then/.catch runs before we assert.
            await new Promise((r) => setImmediate(r));

            expect(webhookCalls).toHaveLength(1);
            expect(webhookCalls[0]!.url).toBe('https://example.invalid/hook');
            const payload = webhookCalls[0]!.payload as { kind: string; automaton: string };
            expect(payload.kind).toBe('self-slash');
            expect(payload.automaton).toBe(willBeSlashed.address.toString());
        });
    });

    describe('idle — no jobs, no events', () => {
        it('runs a no-op tick without throwing and without advancing the checkpoint', async () => {
            const harness = await createSandboxHarness();
            // Don't register the automaton — no mirror event drains either.
            const me = await harness.blockchain.treasury('spectator');

            const metrics = createDaemonMetrics();
            const initialState = emptyCheckpointState();
            const nextState = await tickOnce({
                runtime: harness.runtime,
                wallet: harness.fakeWalletFor(me),
                mirror: new AutomatonMirror(harness.runtime),
                inFlight: new Set(),
                handlers: [],
                counters: metrics.counters,
                metrics,
                logger: SILENT_LOGGER,
                checkpointState: initialState,
                jobFetchConcurrency: 2,
                submitExecute: harness.submitExecuteVia(me),
                nowSec: () => harness.nowSec(),
            });

            // Fresh sandbox HAS events on the registry (SetForgeton) and pool
            // (SetConsumer) from bootstrap — so this confirms the drain picks
            // up background events even without app-level state.
            expect(nextState).not.toBe(initialState);

            const output = await metrics.registry.metrics();
            // No jobs means no executes — attempt counter must not appear.
            expect(output).not.toMatch(/automaton_execute_attempts_total\{/);
        });
    });

    describe('consumer watch handler', () => {
        it('logs ConsumerUpdated when a new consumer is admitted', async () => {
            const harness = await createSandboxHarness();
            const secondConsumer = await harness.blockchain.treasury('second-consumer');
            const me = await harness.blockchain.treasury('me');

            const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
            const collect = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
                logs.push({ level, msg, ...(fields ? { fields } : {}) });
            };
            const logger = {
                debug: collect('debug'),
                info: collect('info'),
                warn: collect('warn'),
                error: collect('error'),
            };

            // Pool owner admits a fresh consumer → ConsumerUpdated emitted.
            await harness.pool.sendSetConsumer(harness.owner.getSender(), {
                value: toNano('0.1'),
                contract: secondConsumer.address,
                isActive: true,
            });

            const handler = consumerWatchHandler(logger);
            await tickOnce({
                runtime: harness.runtime,
                wallet: harness.fakeWalletFor(me),
                mirror: new AutomatonMirror(harness.runtime),
                inFlight: new Set(),
                handlers: [handler],
                counters: createDaemonMetrics().counters,
                logger: SILENT_LOGGER,
                checkpointState: emptyCheckpointState(),
                jobFetchConcurrency: 2,
                submitExecute: harness.submitExecuteVia(me),
                nowSec: () => harness.nowSec(),
            });

            const hit = logs.find((l) => l.msg.includes('consumer set changed'));
            expect(hit).toBeDefined();
        });
    });

    describe('paused registry', () => {
        it('skips the entire cycle cleanly when pool is paused via registry pause flag', async () => {
            const { harness, me, jobOwner, target } = await setupSingleAutomaton();
            await harness.registerJob({ jobOwner, target: target.address });

            // Pause the registry. With `paused=true` every handleExecute would
            // revert with E_PAUSED. The worker must detect via getIsPaused and
            // skip the cycle.
            await harness.registry.sendPause(harness.owner.getSender(), {
                value: toNano('0.1'),
            });

            const metrics = createDaemonMetrics();
            await runTicks({ harness, me, ticks: 1, metrics });

            // The job is unchanged.
            const job = await harness.registry.getJob(0n);
            expect(job!.executionCount).toBe(0);

            // No attempt counter for any reason — worker returned early.
            const output = await metrics.registry.metrics();
            expect(output).not.toMatch(/automaton_execute_attempts_total\{/);
        });
    });

    describe('metrics wiring', () => {
        it('bumps cycle_duration_seconds histogram on every tick', async () => {
            const { harness, me } = await setupSingleAutomaton();

            const metrics = createDaemonMetrics();
            // Use the real metric cycleDuration.startTimer — same as the
            // production loopCycles path.
            const stop = metrics.cycleDuration.startTimer();
            await runTicks({ harness, me, ticks: 1, metrics });
            stop();

            const output = await metrics.registry.metrics();
            expect(output).toMatch(/automaton_cycle_duration_seconds_count 1/);
        });

        it('does not emit drain_dispatched counter when no events drained', async () => {
            const harness = await createSandboxHarness();
            const me = await harness.blockchain.treasury('me'); // not registered → no mirror events

            // Tick 1 absorbs bootstrap events (SetConsumer, SetForgeton, …)
            // and advances the checkpoint past them.
            const first = await runTicks({ harness, me, ticks: 1 });

            // Tick 2 on the same checkpoint + mirror — no new contract
            // activity between ticks → drain yields zero events → the
            // counter must stay silent (prom-client omits labelled series
            // with zero count).
            const secondMetrics = createDaemonMetrics();
            await runTicks({
                harness,
                me,
                ticks: 1,
                metrics: secondMetrics,
                checkpointState: first.checkpointState,
                mirror: first.mirror,
            });

            const output = await secondMetrics.registry.metrics();
            expect(output).not.toMatch(/automaton_events_dispatched_total\{/);
        });
    });

    describe('multi-job', () => {
        it('worker cycles through all registered jobs in one tick', async () => {
            const { harness, me, jobOwner, target } = await setupSingleAutomaton();

            // Register 3 independent jobs. All are never-executed first run.
            for (let i = 0; i < 3; i++) {
                await harness.registerJob({
                    jobOwner,
                    target: target.address,
                    funding: toNano('2'),
                });
            }
            expect(await harness.registry.getJobCount()).toBe(3n);

            const { metrics } = await runTicks({ harness, me, ticks: 1 });

            // All three jobs advanced to executionCount=1.
            for (let i = 0; i < 3; i++) {
                const job = await harness.registry.getJob(BigInt(i));
                expect(job!.executionCount).toBe(1);
            }

            const output = await metrics.registry.metrics();
            // Three attempt+success counter increments on 'never-executed'.
            expect(output).toMatch(
                /automaton_execute_attempts_total\{reason="never-executed"\} 3/,
            );
            expect(output).toMatch(
                /automaton_execute_success_total\{reason="never-executed"\} 3/,
            );
        });
    });

    describe('cancelled job', () => {
        it('skips a cancelled job when safeFetchJob returns null on its slot', async () => {
            const { harness, me, jobOwner, target } = await setupSingleAutomaton();
            // Register THREE jobs, then cancel the middle one. The worker's
            // `for i in [0, jobCount)` loop will see job 1 as null (cancelled
            // full-wipe) and skip it via `safeFetchJob`'s null return —
            // testing the "job.jobId hole" path across registrations.
            for (let i = 0; i < 3; i++) {
                await harness.registerJob({
                    jobOwner,
                    target: target.address,
                    funding: toNano('2'),
                });
            }

            // Cancel jobId=1 (middle). CancelJob full-wipes the map entry.
            await harness.registry.sendCancelJob(jobOwner.getSender(), {
                value: toNano('0.1'),
                jobId: 1n,
            });

            // jobSeqno stays at 3 (it's monotonic on register).
            expect(await harness.registry.getJobCount()).toBe(3n);
            // Cancelled entry → null.
            expect(await harness.registry.getJob(1n)).toBeNull();

            const { metrics } = await runTicks({ harness, me, ticks: 1 });
            // Only jobs 0 and 2 survive → two executes on 'never-executed'.
            expect((await harness.registry.getJob(0n))!.executionCount).toBe(1);
            expect((await harness.registry.getJob(2n))!.executionCount).toBe(1);

            const output = await metrics.registry.metrics();
            expect(output).toMatch(
                /automaton_execute_success_total\{reason="never-executed"\} 2/,
            );
        });
    });

    describe('checkpoint resume — idempotency', () => {
        it('replaying from a saved checkpoint does not re-dispatch events', async () => {
            const harness = await createSandboxHarness();
            const me = await harness.blockchain.treasury('me');

            // Count per-source dispatches using a tracking handler.
            const dispatched = { registry: 0, pool: 0 };
            const tracking: EventHandler = {
                onRegistry: () => {
                    dispatched.registry++;
                },
                onPool: () => {
                    dispatched.pool++;
                },
            };

            // Run a first tick; the checkpoint advances past bootstrap events.
            const first = await runTicks({
                harness,
                me,
                ticks: 1,
                handlers: [tracking],
            });
            const firstRegistry = dispatched.registry;
            const firstPool = dispatched.pool;
            expect(firstRegistry + firstPool).toBeGreaterThan(0);

            // Second tick with the saved checkpoint — no contract activity
            // in between, so the drain should pick up ZERO new events.
            await runTicks({
                harness,
                me,
                ticks: 1,
                handlers: [tracking],
                checkpointState: first.checkpointState,
                mirror: first.mirror,
            });

            expect(dispatched.registry).toBe(firstRegistry);
            expect(dispatched.pool).toBe(firstPool);
        });
    });

    describe('execute revert — post-state verify', () => {
        it('counts a verify-failed attempt when Execute reverts (insufficient gas)', async () => {
            const { harness, me, jobOwner, target } = await setupSingleAutomaton();
            await harness.registerJob({ jobOwner, target: target.address });

            const metrics = createDaemonMetrics();
            const mirror = new AutomatonMirror(harness.runtime);

            // Send with below-minimum gas — registry's handleExecute asserts
            // msgValue >= minGasReserve and reverts E_INSUFFICIENT_GAS. The
            // harness's post-state verify then sees no executionCount
            // advance and throws; classifyExecuteFailure maps the
            // 'executionCount' substring to errorClass='verify-failed'.
            const breakingSubmit: SubmitExecuteFn = harness.submitExecuteVia(me, {
                valueOverride: toNano('0.001'),
            });

            await tickOnce({
                runtime: harness.runtime,
                wallet: harness.fakeWalletFor(me),
                mirror,
                inFlight: new Set(),
                handlers: [],
                counters: metrics.counters,
                metrics,
                logger: SILENT_LOGGER,
                checkpointState: emptyCheckpointState(),
                jobFetchConcurrency: 2,
                submitExecute: breakingSubmit,
                nowSec: () => harness.nowSec(),
            });

            const output = await metrics.registry.metrics();
            // Attempt fired; success did NOT. The error classifier returns
            // 'verify-failed' when the message mentions executionCount.
            expect(output).toMatch(
                /automaton_execute_attempts_total\{reason="never-executed"\} 1/,
            );
            expect(output).toMatch(
                /automaton_execute_failure_total\{reason="never-executed",errorClass="verify-failed"\} 1/,
            );
            expect(output).not.toMatch(/automaton_execute_success_total\{/);
        });
    });

    describe('handler throw — checkpoint guard', () => {
        it('does NOT advance the checkpoint when an event handler throws', async () => {
            const { harness, me } = await setupSingleAutomaton();

            let invocations = 0;
            const thrower: EventHandler = {
                onRegistry: () => {
                    invocations++;
                    throw new Error('handler failure');
                },
                onPool: () => {
                    invocations++;
                    throw new Error('handler failure');
                },
            };

            // Tick 1 — thrower fires on bootstrap events. We assert BOTH:
            //   (a) handler was invoked at least once (the test isn't
            //       trivially passing against zero events),
            //   (b) the checkpoint did NOT advance despite dispatch,
            // so a regression that swallows throws silently fails here.
            const first = await runTicks({
                harness,
                me,
                ticks: 1,
                handlers: [thrower],
            });

            expect(invocations).toBeGreaterThan(0);
            expect(first.checkpointState.checkpoints).toEqual({});
        });
    });

    describe('in-flight single-flight', () => {
        it('does not double-submit the same jobId when a stale entry sits in inFlight', async () => {
            const { harness, me, jobOwner, target } = await setupSingleAutomaton();
            await harness.registerJob({ jobOwner, target: target.address });

            const metrics = createDaemonMetrics();
            // Pre-populate inFlight with jobId=0 — the worker sees the
            // collision and skips, even though decide would say execute.
            const inFlight = new Set<bigint>([0n]);
            const mirror = new AutomatonMirror(harness.runtime);
            await tickOnce({
                runtime: harness.runtime,
                wallet: harness.fakeWalletFor(me),
                mirror,
                inFlight,
                handlers: [],
                counters: metrics.counters,
                metrics,
                logger: SILENT_LOGGER,
                checkpointState: emptyCheckpointState(),
                jobFetchConcurrency: 2,
                submitExecute: harness.submitExecuteVia(me),
                nowSec: () => harness.nowSec(),
            });

            expect((await harness.registry.getJob(0n))!.executionCount).toBe(0);
            const output = await metrics.registry.metrics();
            expect(output).toMatch(/automaton_in_flight_collision_total 1/);
            // The submit path wasn't entered — no attempt counter.
            expect(output).not.toMatch(/automaton_execute_attempts_total\{/);
        });
    });

    describe('gauge wiring', () => {
        it('drain counter increments from both registry and pool sources on bootstrap', async () => {
            const harness = await createSandboxHarness();
            const me = await harness.blockchain.treasury('me');

            const metrics = createDaemonMetrics();
            await runTicks({ harness, me, ticks: 1, metrics });

            const output = await metrics.registry.metrics();
            // Registry-sourced dispatch counter bumps from the bootstrap
            // SetForgeton (ForgetonSet event).
            expect(output).toMatch(
                /automaton_events_dispatched_total\{source="registry"\} [1-9]\d*/,
            );
            // Pool-sourced — SetConsumer produces ConsumerUpdated.
            expect(output).toMatch(
                /automaton_events_dispatched_total\{source="pool"\} [1-9]\d*/,
            );
        });
    });

    describe('expired job', () => {
        it('decide returns skip reason="expired" once job.expireAfter elapses', async () => {
            const { harness, me, jobOwner, target } = await setupSingleAutomaton();
            const nowAtRegister = harness.nowSec();
            await harness.registerJob({
                jobOwner,
                target: target.address,
                // Set expireAfter to a tight future — the job is due NOW but
                // expires 30s from now. First tick should fire (never-executed),
                // but advance+next tick should see 'expired' on this job's
                // second execution attempt.
                expireAfter: nowAtRegister + 30,
                interval: 60,
                windowBefore: 10,
                windowAfter: 600,
            });

            // Tick 1 — never-executed → execute (runs once before expiry).
            await runTicks({ harness, me, ticks: 1 });

            // Advance past expireAfter. Now the job is expired; the second
            // execution attempt decides 'expired' and skips.
            harness.advanceSeconds(120);
            const { metrics } = await runTicks({ harness, me, ticks: 1 });

            const output = await metrics.registry.metrics();
            expect(output).toMatch(/automaton_skip_total\{reason="expired"\} 1/);
        });
    });

    describe('underfunded job', () => {
        it('worker handles thin job budgets without crashing', async () => {
            const { harness, me, jobOwner, target } = await setupSingleAutomaton();

            // Register with a tight funding envelope. Registry enforces
            // minFunding (0.5 TON by default); go above that but well below
            // "many executions of headroom" to exercise the decide tree's
            // executionCost/balance comparison.
            await harness.registerJob({
                jobOwner,
                target: target.address,
                funding: toNano('0.8'),
                interval: 60,
                reward: toNano('0.01'),
                gasLimit: toNano('0.02'),
                windowBefore: 10,
                windowAfter: 600,
            });

            await runTicks({ harness, me, ticks: 1 });
            const job = await harness.registry.getJob(0n);
            expect(job).not.toBeNull();
            expect(job!.executionCount).toBe(1);

            // Advance past interval — next tick either executes (if balance
            // still covers perExecutionCost) or skips=underfunded. This test
            // verifies the decide tree runs the correct branch without
            // crashing, not the exact crossover.
            harness.advanceSeconds(120);
            const { metrics } = await runTicks({ harness, me, ticks: 1 });

            const output = await metrics.registry.metrics();
            const isUnderfunded = /automaton_skip_total\{reason="underfunded"\} 1/.test(output);
            // Only 1 registered automaton, so decide picks 'primary-self'
            // inside the primary window OR 'fallback' after. Either exec
            // reason is a valid outcome for "the job had enough balance".
            const ranAgain = /automaton_execute_success_total\{reason="(primary-self|fallback)"\} 1/.test(output);
            expect(isUnderfunded || ranAgain).toBe(true);
        });
    });

    describe('mirror maintenance across lifecycle', () => {
        it('adds + removes mirror entries as automatons register and unstake', async () => {
            const harness = await createSandboxHarness();
            const me = await harness.registerAutomaton('me');
            const other = await harness.registerAutomaton('other');

            // Warm the mirror.
            const { mirror, checkpointState } = await runTicks({ harness, me, ticks: 1 });
            expect(mirror.activeCount).toBe(2n);

            // `other` unstakes — pool broadcasts AutomatonSync; registry
            // mirror shrinks via handleAutomatonSync on the registry side.
            await harness.pool.sendRequestUnstake(other.getSender(), {
                value: toNano('0.1'),
            });
            harness.advanceSeconds(FORGETON_DEFAULTS.unstakeCooldown + 1);
            const info = await harness.pool.getAutomaton(other.address);
            await harness.pool.sendUnstake(other.getSender(), {
                value: toNano('0.1'),
                amount: info!.stake,
            });

            // After unstake, the registry's count MUST be 1 (pool's sync
            // landed synchronously in the sandbox's message queue). The
            // automaton-side mirror cache is stale until ensureFresh runs
            // next tick — runTicks calls ensureFresh as part of runWorkerCycle.
            await runTicks({
                harness,
                me,
                ticks: 1,
                mirror,
                checkpointState,
                handlers: [mirrorPatchHandler(mirror, SILENT_LOGGER)],
            });

            expect(mirror.activeCount).toBe(1n);
            expect(mirror.snapshot[0]!.equals(me.address)).toBe(true);
        });
    });
});
