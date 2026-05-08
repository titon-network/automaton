// `automaton playground` — fully-local simulation.
//
// Boots a sandbox blockchain in-process, deploys ForgeTON + Kronos,
// registers a demo automaton, schedules a recurring job, and runs the
// real production tick path against the simulation. Zero internet, zero
// faucet, zero wait — the user sees the automaton execute jobs and
// earn TON within seconds of typing the command.
//
// Why this is a real test, not a mock: every block of orchestrator code
// the daemon runs in production runs here too — `tickOnce`, `drainEvents`,
// `KronosWorker`, the decide tree, `AutomatonMirror`. The only swap is
// (a) `FailoverTonClient` → `SandboxTonClient` and (b) `defaultSubmitExecute`
// → `submitExecuteVia(treasury)` (bypasses real V5R1 wallet signing).
// Both swaps are exercised in the integration test suite, so a passing
// playground proves the production code path holds end-to-end.
//
// Architecture note — why we don't iterate PRODUCTS like `runDaemon`:
// The orchestrator's PRODUCTS-iterating `bootstrapWorker` path resolves
// addresses from per-network deployment constants (KRONOS_TESTNET, etc.)
// and constructs `submitExecute` / `sender` from the real wallet. The
// playground addresses live on a freshly-deployed sandbox instance and
// the I/O boundary must route through `treasury.getSender()` — neither
// is reachable from the production product registry.
//
// Both KronosWorker and FortunaWorker therefore expose explicit
// injection points (`submitExecute?` and `submitFulfill?` / `sender?`)
// that the playground uses to swap the I/O path. The Worker's pure-
// orchestration logic — pending queue, decide tree, drain, mirror —
// runs unchanged. We revisit a unified "ProductModule.bootstrapPlayground"
// hook only if a third product needs it.
//
// Output modes:
//   - 'pretty' (default): human-friendly status lines on stdout
//   - 'json': one JSON event per line (compatible with `jq`/log parsers)
//
// Lifecycle: each tick advances the sandbox clock by `jobIntervalSec`
// (so the job becomes due every cycle), runs one `tickOnce`, then waits
// `tickIntervalMs` of wall-clock so the user can read the output. The
// AbortSignal collapses the wait — Ctrl-C exits within ~100 ms.

import { fromNano, toNano, type Address, type OpenedContract } from '@ton/core';
import type { KronosEvent, KronosRegistry } from '@titon-network/kronos-sdk';
import type { Atlas } from '@titon-network/atlas-sdk';
import type { Fortuna, FortunaEvent } from '@titon-network/fortuna-sdk';
import { tickOnce } from '../daemon/orchestrator';
import { KronosWorker, REGISTRY_SOURCE, kronos } from '../products/kronos';
import { fortuna as fortunaProduct, FORTUNA_SOURCE } from '../products/fortuna';
import { FortunaWorker, type FortunaWorkerCounters } from '../worker/fortuna';
import type { ProductWorker } from '../products/types';
import { randomBlsSecret, blsPublicKey } from '../bls';
import {
    baselineEventSources,
    drainEvents,
    emptyCheckpointState,
    type CheckpointState,
    type EventHandler,
    type EventSource,
    type TxContext,
    type WorkerCounters,
    type WorkerLogger,
} from '../worker';
import { abortableSleep, isAbortError } from '../daemon/loop';
import { createSandboxHarness, type SandboxHarness } from './sandbox-runtime';

export interface PlaygroundOptions {
    /** Number of ticks to run. Omit to run until the AbortSignal fires. */
    ticks?: number;
    /** Wall-clock pause between ticks (ms). Default 500. Set 0 in tests. */
    tickIntervalMs?: number;
    /** Sandbox time advanced per tick (s). Default 5. Job interval matches. */
    jobIntervalSec?: number;
    /** Number of demo jobs to schedule. Default 1. */
    jobs?: number;
    /** External abort — Ctrl-C, test cleanup, etc. */
    signal?: AbortSignal;
    /** Override the human-facing output stream. Default `process.stdout`.
     *  Narrowed to just the `write` method we use, so tests can pass a
     *  trivial `{ write(s) { ... } }` shim instead of a real stream. */
    output?: { write(chunk: string): boolean | void };
    /** Pretty status (default) or JSON-lines for machine consumers. */
    format?: 'pretty' | 'json';
    /** Optional structured logger — production paths log via this. Default = silent. */
    logger?: WorkerLogger;
    /**
     * When true (default), also deploys Atlas + Fortuna and runs the VRF
     * fulfillment path alongside Kronos. The same demo automaton earns
     * from both protocols. Set false for a Kronos-only run (~3-4s faster
     * boot — used by the smoke gate).
     */
    withFortuna?: boolean;
}

export interface PlaygroundResult {
    ticksRun: number;
    executions: number;
    /** Number of Fortuna requests fulfilled. Always 0 when `withFortuna === false`. */
    fortunaFulfillments: number;
    earnedNano: bigint;
    finalBalanceNano: bigint;
    initialBalanceNano: bigint;
    automatonAddress: string;
    aborted: boolean;
}

const DEFAULT_TICK_INTERVAL_MS = 500;
// Kronos's default `minInterval` is 60s — anything lower gets the
// RegisterJob silently rejected by the contract. We default at 60 so the
// playground works against a stock-config registry without the user
// having to know that constraint.
const DEFAULT_JOB_INTERVAL_SEC = 60;
const DEFAULT_JOBS = 1;

/**
 * Run the playground simulation. Returns when `ticks` ticks complete or
 * the abort signal fires — whichever first.
 */
export async function runPlayground(
    opts: PlaygroundOptions = {},
): Promise<PlaygroundResult> {
    const out = opts.output ?? process.stdout;
    const format = opts.format ?? 'pretty';
    const tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    const jobIntervalSec = opts.jobIntervalSec ?? DEFAULT_JOB_INTERVAL_SEC;
    const jobCount = opts.jobs ?? DEFAULT_JOBS;
    const logger = opts.logger ?? SILENT_LOGGER;
    const signal = opts.signal ?? new AbortController().signal;
    const targetTicks = opts.ticks;
    const withFortuna = opts.withFortuna ?? true;

    const print = makePrinter(out, format);

    print({ kind: 'banner', message: 'Titon automaton playground — local simulation' });

    print({ kind: 'step', label: 'bootstrapping sandbox blockchain' });
    const harness = await createSandboxHarness({ withFortuna });
    print({
        kind: 'step-ok',
        detail: withFortuna
            ? 'deployed ForgeTON + Kronos + Atlas + Fortuna, wired as consumers'
            : 'deployed ForgeTON pool + Kronos registry, wired as consumer',
    });

    print({ kind: 'step', label: 'registering demo automaton' });
    const automaton = await harness.registerAutomaton('playground-automaton');
    const automatonAddress = automaton.address.toString();
    print({
        kind: 'step-ok',
        detail: `automaton ${shortAddr(automatonAddress)} registered with ${fromNano(harness.registerValue)} TON stake`,
    });

    print({ kind: 'step', label: `scheduling ${jobCount} demo job(s) (interval=${jobIntervalSec}s)` });
    const jobs: bigint[] = [];
    for (let i = 0; i < jobCount; i++) {
        const id = await harness.registerJob({
            jobOwner: harness.owner,
            target: harness.owner.address,
            interval: jobIntervalSec,
            funding: toNano('5'),
            windowBefore: 1,
            windowAfter: jobIntervalSec * 4,
        });
        jobs.push(id);
    }
    print({ kind: 'step-ok', detail: `scheduled job ids: ${jobs.map((j) => j.toString()).join(', ')}` });

    // The "executions this tick" counter comes from `worker.counters` —
    // every successful `submitExecute` call bumps it on the same tick the
    // submit lands. Choosing that over a JobExecuted-event counter makes
    // per-tick attribution honest: the JobExecuted event lags by one drain
    // pass, which would mis-attribute tick N's submit to tick N+1's report.
    // We still run a settle drain at the end of the loop so the per-execute
    // detail line + the running summary stay consistent.
    const submitCounter = makeWorkerCounters();
    const executionHandler = makeJobExecutedHandler(automaton.address, (event, ctx) => {
        print({
            kind: 'execution',
            jobId: event.jobId.toString(),
            rewardNano: event.reward,
            txHash: ctx.txHash,
        });
    });

    const kronosRegistry = harness.registry as unknown as OpenedContract<KronosRegistry>;
    const worker = new KronosWorker({
        registry: kronosRegistry,
        client: harness.runtime.client,
        wallet: harness.fakeWalletFor(automaton),
        logger,
        counters: submitCounter.counters,
        nowSec: harness.nowSec,
        submitExecute: harness.submitExecuteVia(automaton),
    });

    const handlers: EventHandler[] = [executionHandler];
    const productWorkers: Record<string, ProductWorker> = { kronos: worker };

    // Reuse the production `kronos.eventStreams` decoder rather than
    // hand-rolling one here. Drift is a real risk if KronosEvent gains a
    // new variant: the sandbox path would silently drop it.
    const sources: EventSource[] = [
        ...baselineEventSources(harness.runtime),
        ...kronos.eventStreams({
            client: harness.runtime.client,
            addresses: { registry: harness.registry.address },
            contracts: { registry: kronosRegistry },
        }),
    ];

    let fortunaCtx: FortunaPlaygroundContext | undefined;
    if (withFortuna) {
        fortunaCtx = await bootstrapFortunaPlayground({
            harness,
            automaton,
            logger,
            print,
        });
        // worker.eventHandler() is what populates the pending queue from
        // RequestCreated events — without it the worker never has anything
        // to submit. fortunaCtx.handler is the demo-only side-effect that
        // prints "fulfill" lines.
        handlers.push(fortunaCtx.worker.eventHandler(), fortunaCtx.handler);
        sources.push(...fortunaCtx.sources);
        productWorkers.fortuna = fortunaCtx.worker;
    }

    const initialBalance = await harness.runtime.client.call((c) =>
        c.getBalance(automaton.address),
    );
    print({
        kind: 'step-ok',
        detail: targetTicks !== undefined
            ? `ready — running ${targetTicks} tick(s)`
            : 'ready — running until Ctrl-C',
    });

    print({ kind: 'separator' });

    let checkpointState: CheckpointState = emptyCheckpointState();
    let aborted = false;
    let tick = 0;

    while (true) {
        if (signal.aborted) {
            aborted = true;
            break;
        }
        if (targetTicks !== undefined && tick >= targetTicks) break;

        tick++;
        harness.advanceSeconds(jobIntervalSec);

        // Fire a fresh RequestRandomness each tick — at most one in flight
        // at a time so the demo shows a clean request → fulfill → request
        // cycle.
        if (fortunaCtx !== undefined && !fortunaCtx.hasRequestInFlight()) {
            await fortunaCtx.fireRequest();
        }

        const beforeBalance = await harness.runtime.client.call((c) =>
            c.getBalance(automaton.address),
        );
        const beforeSubmit = submitCounter.successCount();
        const beforeFulfill = fortunaCtx?.fulfillSuccessCount() ?? 0;

        checkpointState = await tickOnce({
            runtime: harness.runtime,
            wallet: harness.fakeWalletFor(automaton),
            handlers,
            sources,
            logger,
            checkpointState,
            productWorkers,
        });

        const afterBalance = await harness.runtime.client.call((c) =>
            c.getBalance(automaton.address),
        );

        const tickEvent: PlaygroundEvent = {
            kind: 'tick',
            tick,
            executionsThisTick: submitCounter.successCount() - beforeSubmit,
            fulfillmentsThisTick: (fortunaCtx?.fulfillSuccessCount() ?? 0) - beforeFulfill,
            earnedNano: afterBalance - beforeBalance,
            advancedSec: jobIntervalSec,
        };
        if (targetTicks !== undefined) tickEvent.totalTicks = targetTicks;
        print(tickEvent);

        if (tickIntervalMs > 0) {
            try {
                await abortableSleep(tickIntervalMs, signal);
            } catch (err) {
                if (isAbortError(err)) {
                    aborted = true;
                    break;
                }
                throw err;
            }
        }
    }

    // Settle: drain one more time so JobExecuted events from the final
    // tick's submit-Execute land in the handler (and the per-execution
    // detail line prints). No new submissions — this is event-only.
    await drainEvents({
        runtime: harness.runtime,
        state: checkpointState,
        sources,
        handlers,
        logger,
    });

    const finalBalance = await harness.runtime.client.call((c) =>
        c.getBalance(automaton.address),
    );
    const earned = finalBalance - initialBalance;

    const fortunaFulfillments = fortunaCtx?.fulfillSuccessCount() ?? 0;
    print({
        kind: 'summary',
        ticksRun: tick,
        executions: submitCounter.successCount(),
        fortunaFulfillments,
        earnedNano: earned,
        aborted,
    });

    return {
        ticksRun: tick,
        executions: submitCounter.successCount(),
        fortunaFulfillments,
        earnedNano: earned,
        finalBalanceNano: finalBalance,
        initialBalanceNano: initialBalance,
        automatonAddress,
        aborted,
    };
}

/**
 * Filter `JobExecuted` events for the demo automaton and emit a
 * per-execution detail line through the user-facing printer. Same shape
 * as production's `kronosAwarenessHandler` (filter on `event.automaton.equals(me)`)
 * — the playground just adds the printer side-effect. Pure side-effect
 * handler; the source-of-truth count for the summary is `submitCounter`.
 */
function makeJobExecutedHandler(
    me: Address,
    onExecute: (event: KronosEvent & { kind: 'JobExecuted' }, ctx: TxContext) => void,
): EventHandler {
    return {
        on: {
            [REGISTRY_SOURCE]: (event, ctx) => {
                const k = event as KronosEvent;
                if (k.kind !== 'JobExecuted') return;
                if (!k.automaton.equals(me)) return;
                onExecute(k, ctx);
            },
        },
    };
}

/** Wire a fresh WorkerCounters bundle that just tallies success calls.
 *  The other slots stay no-op — the playground only surfaces "how many
 *  Executes landed" to the user; attempts / failures / skips would be
 *  noise in a successful run and aren't actionable to a first-time user. */
function makeWorkerCounters(): { counters: WorkerCounters; successCount: () => number } {
    let successes = 0;
    return {
        counters: {
            incrementExecuteAttempt: () => undefined,
            incrementExecuteSuccess: () => {
                successes++;
            },
            incrementExecuteFailure: () => undefined,
            incrementSkip: () => undefined,
            incrementInFlightCollision: () => undefined,
        },
        successCount: () => successes,
    };
}

const SILENT_LOGGER: WorkerLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

// ===== Output =====

type PlaygroundEvent =
    | { kind: 'banner'; message: string }
    | { kind: 'step'; label: string }
    | { kind: 'step-ok'; detail: string }
    | { kind: 'separator' }
    | { kind: 'execution'; jobId: string; rewardNano: bigint; txHash: string }
    | { kind: 'fulfillment'; reqKey: string; rewardNano: bigint; txHash: string }
    | {
          kind: 'tick';
          tick: number;
          totalTicks?: number;
          executionsThisTick: number;
          fulfillmentsThisTick: number;
          /** balance change for the automaton wallet during this tick (nano) */
          earnedNano: bigint;
          /** sandbox seconds advanced this tick */
          advancedSec: number;
      }
    | {
          kind: 'summary';
          ticksRun: number;
          executions: number;
          fortunaFulfillments: number;
          earnedNano: bigint;
          aborted: boolean;
      };

function makePrinter(
    out: { write(chunk: string): boolean | void },
    format: 'pretty' | 'json',
): (e: PlaygroundEvent) => void {
    if (format === 'json') {
        return (e) => {
            const json = JSON.stringify(e, (_k, v) =>
                typeof v === 'bigint' ? v.toString() : v,
            );
            out.write(`${json}\n`);
        };
    }
    return (e) => {
        out.write(`${formatPretty(e)}\n`);
    };
}

function formatPretty(e: PlaygroundEvent): string {
    switch (e.kind) {
        case 'banner':
            return `\n${e.message}\n${'─'.repeat(e.message.length)}\n`;
        case 'step':
            return `  ... ${e.label}`;
        case 'step-ok':
            return `   ok  ${e.detail}`;
        case 'separator':
            return '';
        case 'execution': {
            const reward = formatTon(e.rewardNano);
            return `      kronos   execute  job=${e.jobId}  reward=${reward} TON  tx=${e.txHash.slice(0, 12)}…`;
        }
        case 'fulfillment': {
            const reward = formatTon(e.rewardNano);
            const shortKey = `${e.reqKey.slice(0, 8)}…${e.reqKey.slice(-6)}`;
            return `      fortuna  fulfill  req=${shortKey}  reward=${reward} TON  tx=${e.txHash.slice(0, 12)}…`;
        }
        case 'tick': {
            const total = e.totalTicks ?? '∞';
            const earned = e.earnedNano >= 0n
                ? `+${formatTon(e.earnedNano)}`
                : `-${formatTon(-e.earnedNano)}`;
            const parts: string[] = [];
            if (e.executionsThisTick > 0) parts.push(`${e.executionsThisTick} exec`);
            if (e.fulfillmentsThisTick > 0) parts.push(`${e.fulfillmentsThisTick} fulfill`);
            const verdict = parts.length > 0 ? parts.join(' + ') : 'idle';
            return `  tick ${e.tick}/${total}  +${e.advancedSec}s  ${verdict}  earned ${earned} TON`;
        }
        case 'summary': {
            const earned = e.earnedNano >= 0n
                ? `+${formatTon(e.earnedNano)}`
                : `-${formatTon(-e.earnedNano)}`;
            const head = e.aborted ? 'aborted' : 'complete';
            const counts = [`${e.executions} kronos exec`];
            if (e.fortunaFulfillments > 0) counts.push(`${e.fortunaFulfillments} fortuna fulfill`);
            return [
                '',
                `  ${head} — ${e.ticksRun} tick(s), ${counts.join(' + ')}, ${earned} TON earned`,
                '',
                '  This was a fully-local simulation against an in-process sandbox.',
                '  No real TON, no chain, no network. To run against testnet:',
                '    automaton init --network testnet',
                '',
            ].join('\n');
        }
    }
}

function formatTon(nano: bigint): string {
    const ton = Number(nano) / 1e9;
    return ton.toFixed(4);
}

function shortAddr(addr: string): string {
    if (addr.length <= 16) return addr;
    return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

// ===== Fortuna playground integration =====

interface FortunaPlaygroundContext {
    worker: FortunaWorker;
    handler: EventHandler;
    sources: EventSource[];
    /** Submit a fresh `RequestRandomness` from the demo consumer. */
    fireRequest(): Promise<void>;
    /** True if a request fired earlier hasn't yet emitted RequestFulfilled. */
    hasRequestInFlight(): boolean;
    fulfillSuccessCount(): number;
}

/**
 * Bootstrap the Fortuna VRF leg of the playground:
 *   1. Generate an in-memory BLS keypair (no keystore — playground secret).
 *   2. Operator registers the pkShare at Atlas (allowed because the
 *      operator was just AutomatonSync'd into Atlas via ForgeTON's
 *      consumer fan-out).
 *   3. Owner publishes the same pkShare as the solo group key
 *      (threshold=1, memberCount=1). Atlas fans out GroupKeySync to
 *      Fortuna, which now has a verifiable group public key.
 *   4. Construct a `FortunaWorker` against the live Fortuna contract,
 *      with `sender = automaton.getSender()` to bypass V5R1 signing.
 *   5. Add a side-effect handler that prints a "fulfill" line per
 *      RequestFulfilled event the operator wins.
 *
 * Returns a context object with `fireRequest()` (used by the main loop
 * to seed a fresh RequestRandomness each tick) and `pendingCount()`
 * (used to gate firing while a request is still in flight).
 */
async function bootstrapFortunaPlayground(deps: {
    harness: SandboxHarness;
    automaton: import('@ton/sandbox').SandboxContract<import('@ton/sandbox').TreasuryContract>;
    logger: WorkerLogger;
    print: (e: PlaygroundEvent) => void;
}): Promise<FortunaPlaygroundContext> {
    const { harness, automaton, logger, print } = deps;
    if (
        harness.atlas === undefined ||
        harness.fortuna === undefined ||
        harness.registerBlsShare === undefined ||
        harness.publishGroupKey === undefined ||
        harness.requestRandomness === undefined
    ) {
        // Defensive — `withFortuna: true` was passed to createSandboxHarness
        // but the Fortuna scaffolding didn't materialise. This indicates a
        // harness-construction bug, not a user error.
        throw new Error('bootstrapFortunaPlayground: harness was not built with Fortuna enabled');
    }

    print({ kind: 'step', label: 'generating in-memory BLS keypair (solo group)' });
    // randomBlsSecret/blsPublicKey return `Uint8Array` from @noble; wrap as
    // Buffers so they fit Atlas's `storeBuffer` and FortunaWorkerDeps.blsSecret.
    const blsSecret = Buffer.from(randomBlsSecret());
    const pkShare = Buffer.from(blsPublicKey(blsSecret));
    print({ kind: 'step-ok', detail: `pkShare ${pkShare.subarray(0, 4).toString('hex')}…${pkShare.subarray(-4).toString('hex')}` });

    print({ kind: 'step', label: 'operator registers BLS share at Atlas' });
    await harness.registerBlsShare({ operator: automaton, pkShare });
    print({ kind: 'step-ok', detail: 'pkShare accepted (G1 subgroup-checked)' });

    print({ kind: 'step', label: 'owner publishes solo group key (threshold=1, member=1)' });
    await harness.publishGroupKey({ groupPk: pkShare, threshold: 1, memberCount: 1 });
    print({ kind: 'step-ok', detail: 'Atlas fanned GroupKeySync into Fortuna — VRF ready' });

    const consumer = await harness.blockchain.treasury('playground-vrf-consumer');

    const fortunaContract = harness.fortuna as unknown as OpenedContract<Fortuna>;
    const fulfillCounters = makeFortunaCounters();

    const worker = new FortunaWorker({
        fortuna: fortunaContract,
        client: harness.runtime.client,
        wallet: harness.fakeWalletFor(automaton),
        blsSecret,
        logger,
        counters: fulfillCounters.counters,
        nowSec: harness.nowSec,
        sender: automaton.getSender(),
        // Bypass production's sendAndConfirm wrapper: the sandbox treasury
        // doesn't have a real V5R1 walletContract for `client.open` to
        // attach to. The treasury sender's `send()` is inline-executed
        // by the sandbox, so we just call send + verify in sequence.
        submitFulfill: async (send, verify) => {
            await send();
            await verify();
        },
    });

    // Pre-fetch `submitterReward` so the per-fulfill detail line shows the
    // operator's earnings. The on-chain RequestFulfilled event carries
    // (reqKey, submitter, beta) only — the reward is config, not per-event.
    const fortunaConfig = await fortunaContract.getConfig();

    // Demo-local "request in flight" flag. We rate-limit to one VRF round
    // at a time so the demo shows a clean request → fulfill cycle. The
    // flag flips back to `false` on RequestFulfilled (this op's submitter)
    // or RequestReclaimed (any consumer-side cleanup). The reclaim path
    // matters for the demo's robustness: a hypothetical multi-op scenario
    // that race-loses to a peer would otherwise leave the flag stuck.
    let requestInFlight = false;

    const handler: EventHandler = {
        on: {
            [FORTUNA_SOURCE]: (event, ctx) => {
                const f = event as FortunaEvent;
                if (f.kind === 'RequestReclaimed') {
                    requestInFlight = false;
                    return;
                }
                if (f.kind !== 'RequestFulfilled') return;
                if (!f.submitter.equals(automaton.address)) return;
                requestInFlight = false;
                print({
                    kind: 'fulfillment',
                    reqKey: f.reqKey.toString(16),
                    rewardNano: fortunaConfig.submitterReward,
                    txHash: ctx.txHash,
                });
            },
        },
    };

    const sources = fortunaProduct.eventStreams({
        client: harness.runtime.client,
        addresses: { fortuna: harness.fortuna.address, atlas: harness.atlas.address },
        contracts: {
            fortuna: fortunaContract,
            atlas: harness.atlas as unknown as OpenedContract<Atlas>,
        },
    });

    let queryCounter = 0n;
    async function fireRequest(): Promise<void> {
        queryCounter++;
        // queryId/seed must be unique per consumer; counter + tick-time mix
        // makes them human-readable while still distinct across runs.
        const seed = BigInt(Math.floor(Date.now())) ^ queryCounter;
        await harness.requestRandomness!({
            consumer,
            queryId: queryCounter,
            seed,
        });
        requestInFlight = true;
    }

    return {
        worker,
        handler,
        sources,
        fireRequest,
        hasRequestInFlight: () => requestInFlight,
        fulfillSuccessCount: fulfillCounters.successCount,
    };
}

/** FortunaWorkerCounters that just tallies submit successes — same shape
 *  as `makeWorkerCounters` for Kronos. */
function makeFortunaCounters(): { counters: FortunaWorkerCounters; successCount: () => number } {
    let successes = 0;
    return {
        counters: {
            incrementFulfillAttempt: () => undefined,
            incrementFulfillSuccess: () => {
                successes++;
            },
            incrementFulfillFailure: () => undefined,
            incrementFulfillSkip: () => undefined,
        },
        successCount: () => successes,
    };
}
