// Pure decision engine for a single jobId in a single poll tick.
//
// Input: the job's current state + registry config + a mirror snapshot +
// the operator's own address + the current time.
// Output: execute or skip, with a human-readable reason for logging.
//
// The decision tree mirrors the pool/registry's execution model (see
// kronos/CLAUDE.md §"Assignment + execution windows"):
//
//   status === 'never-executed'   → execute (permissionless first run)
//   status === 'primary' + me     → execute (I am the rotation pick)
//   status === 'primary' + other  → skip    (wait for fallback window)
//   status === 'fallback'         → execute (anyone can claim; we earn
//                                            the reward AND trigger a
//                                            slash of the missed pick)
//   status === 'too-early'        → skip
//   status === 'too-late'         → skip (window closed without exec)
//   status === 'expired'          → skip
//   !isActive                     → skip (paused / cancelled)
//   !isExecutable (balance, etc.) → skip (job would revert)
//   no rotation (mirror empty)    → execute (Phase 1/2 escape hatch)
//
// "Execute" here means "our decision is to submit". The actual send is
// driven by the worker loop, which also owns single-flight guarding
// (so a slow RPC doesn't double-submit the same jobId).

import type { Address } from '@ton/core';
import type { JobData, RegistryConfigReply } from '@titon-network/kronos-sdk';
import {
    isExecutable,
    jobWindowState,
    resolveAssignedAutomaton,
    type JobWindowState,
} from '@titon-network/kronos-sdk';
import { executionEconomics } from '@titon-network/kronos-sdk';

export type DecisionAction = 'execute' | 'skip';

/**
 * Closed enumeration of every reason `decide` can return. The literal
 * is the source of truth for Prometheus label cardinality — every metric
 * that labels by `reason` (`automaton_execute_attempts_total`,
 * `automaton_skip_total`, …) iterates over THIS list. Do not write a
 * reason string anywhere else; add it here first.
 */
export const DECISION_REASONS = [
    'never-executed',
    'primary-self',
    'primary-other',
    'fallback',
    'too-early',
    'too-late',
    'expired',
    'inactive',
    'underfunded',
    'no-rotation',
] as const;

export type DecisionReason = (typeof DECISION_REASONS)[number];

export interface Decision {
    action: DecisionAction;
    /** Short machine-readable reason. Useful as a metric label. */
    reason: DecisionReason;
    /** Human-readable explanation, fine for logs + dashboards. */
    detail: string;
    /** Snapshot of the window computation for observability. */
    window: JobWindowState;
    /** Assigned automaton for this run, or null if rotation is off. */
    assigned: Address | null;
}

export interface DecideInput {
    jobId: bigint;
    job: JobData;
    registryConfig: RegistryConfigReply;
    mirror: readonly Address[];
    /** This automaton's wallet address. */
    me: Address;
    /** Override current time (seconds since epoch). Defaults to Date.now()/1000. */
    now?: number;
}

/**
 * Evaluate a job against the decision tree and return whether to execute.
 * Pure: no IO, no retry — callers can run this on a mirror cache without
 * any per-iteration RPC.
 */
export function decide(input: DecideInput): Decision {
    const { job, registryConfig, mirror, me } = input;
    const now = input.now ?? Math.floor(Date.now() / 1000);

    const window = jobWindowState({
        lastExecutedAt: job.lastExecutedAt,
        interval: job.interval,
        windowBefore: job.windowBefore,
        windowAfter: job.windowAfter,
        primaryWindowSeconds: registryConfig.primaryWindowSeconds,
        expireAfter: job.expireAfter,
        now,
    });

    const assigned = resolveAssignedAutomaton({
        jobId: input.jobId,
        executionCount: job.executionCount,
        activeAutomatonCount: mirror.length,
        automatonAddresses: mirror,
    });

    if (!job.isActive) {
        return skip('inactive', 'job.isActive = false (paused or cancelled)', window, assigned);
    }

    if (window.status === 'expired') {
        return skip('expired', 'job.expireAfter elapsed', window, assigned);
    }
    if (window.status === 'too-early') {
        return skip('too-early', 'window not yet open', window, assigned);
    }
    if (window.status === 'too-late') {
        return skip('too-late', 'window closed without execution', window, assigned);
    }

    // Faithful to the on-chain `isDue` getter — checks balance, expiry, active.
    // Putting this AFTER the explicit status checks gives more useful error
    // messages ("too-late" is more actionable than "underfunded" when both
    // are true and the latter is a consequence of the former).
    const perExecutionCost: bigint = executionEconomics({
        reward: job.reward,
        gasLimit: job.gasLimit,
        protocolFeeBps: registryConfig.protocolFeeBps,
    }).totalCost;
    const executable = isExecutable({
        lastExecutedAt: job.lastExecutedAt,
        interval: job.interval,
        windowBefore: job.windowBefore,
        windowAfter: job.windowAfter,
        primaryWindowSeconds: registryConfig.primaryWindowSeconds,
        expireAfter: job.expireAfter,
        balance: job.balance,
        perExecutionCost,
        isActive: job.isActive,
        now,
    });
    if (!executable) {
        return skip(
            'underfunded',
            `balance ${job.balance} < perExecutionCost ${perExecutionCost} — Execute would revert`,
            window,
            assigned,
        );
    }

    if (window.status === 'never-executed') {
        return execute('never-executed', 'first run is permissionless', window, assigned);
    }

    // From here the window is 'primary' or 'fallback' and the job is
    // executable on-chain. The assignment determines who SHOULD win.
    if (assigned === null) {
        // Phase 1/2 escape hatch: ForgeTON unset or empty mirror. Any
        // automaton can execute.
        return execute(
            'no-rotation',
            'rotation disabled (empty mirror / forgeton unset) — permissionless',
            window,
            assigned,
        );
    }

    if (window.status === 'primary') {
        if (assigned.equals(me)) {
            return execute('primary-self', 'assigned to me in primary window', window, assigned);
        }
        return skip(
            'primary-other',
            `primary window belongs to ${assigned.toString()}, not us`,
            window,
            assigned,
        );
    }

    // window.status === 'fallback' — anyone can claim; we earn the reward
    // AND the assigned automaton gets slashed when our Execute lands.
    return execute(
        'fallback',
        `fallback window open; claiming reward (assigned ${assigned.toString()} missed)`,
        window,
        assigned,
    );
}

function execute(
    reason: DecisionReason,
    detail: string,
    window: JobWindowState,
    assigned: Address | null,
): Decision {
    return { action: 'execute', reason, detail, window, assigned };
}

function skip(
    reason: DecisionReason,
    detail: string,
    window: JobWindowState,
    assigned: Address | null,
): Decision {
    return { action: 'skip', reason, detail, window, assigned };
}
