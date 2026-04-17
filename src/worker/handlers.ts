// Built-in event handlers. Each returns an {@link EventHandler} that
// the daemon (D.10) plugs into `drainEvents`. Kept separate from
// `events.ts` so user-defined handlers (future experimentation, tests)
// can be composed alongside the defaults without touching the drain
// machinery.

import type { Address } from '@ton/core';
import type { EventHandler, TxContext } from './events';
import type { AutomatonMirror } from './mirror';
import type { WorkerLogger } from './loop';

const WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * Invalidates the mirror cache on any `AutomatonMirrorUpdated`. Debounced:
 * a stake burst can land N mirror events in one drain (the pool may
 * emit several in a single block), but we only want to pay one
 * `refresh()` round-trip per cycle. We set a dirty flag on every
 * matching event and flush via `onCycleEnd`.
 */
export function mirrorPatchHandler(mirror: AutomatonMirror, logger: WorkerLogger): EventHandler {
    let needsRefresh = false;
    let lastEventCount: number | undefined;
    return {
        onRegistry(event) {
            if (event.kind !== 'AutomatonMirrorUpdated') return;
            needsRefresh = true;
            lastEventCount = event.activeAutomatonCount;
        },
        async onCycleEnd() {
            if (!needsRefresh) return;
            needsRefresh = false;
            logger.info('mirror event(s) received — refreshing cache', {
                activeAutomatonCount: lastEventCount,
            });
            await mirror.refresh();
        },
    };
}

export interface SlashAlertDeps {
    me: Address;
    logger: WorkerLogger;
    /** Optional webhook URL — when set, we POST a JSON notification on self-slash. */
    webhookUrl?: string;
    /** Injected for tests — defaults to global fetch. */
    fetch?: typeof fetch;
    /** Invoked on every self-slash; D.11 wires this to a prom-client counter. */
    onSelfSlash?: (event: SelfSlashPayload) => void;
}

/**
 * Payload POSTed to `config.alertWebhookUrl` on self-slash.
 *
 * Consumers SHOULD dedupe on `txHash` — the drain is idempotent at the
 * handler boundary (checkpoint advances after dispatch; a crash mid-
 * batch causes replay), and the webhook WILL be re-sent on restart.
 */
export interface SelfSlashPayload {
    automaton: string;
    slasher: string;
    reason: number;
    amount: string;
    remainingStake: string;
    slashCount: number;
    txHash: string;
    ts: number;
}

/**
 * Alerts when `AutomatonSlashed { automaton == me }` fires. Never
 * throws — a self-slash cannot crash the daemon; we just surface.
 *
 * Webhook POST is fire-and-forget with a 5s timeout. We do NOT await
 * its completion: a slow / stalled alert endpoint must not stall event
 * dispatch (which would, in turn, stall the worker cycle and checkpoint
 * advancement). Failures are logged but not retried.
 */
export function selfSlashHandler(deps: SlashAlertDeps): EventHandler {
    const fetchImpl = deps.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);

    return {
        onPool(event, ctx) {
            if (event.kind !== 'AutomatonSlashed') return;
            if (!event.automaton.equals(deps.me)) return;

            const payload: SelfSlashPayload = {
                automaton: event.automaton.toString(),
                slasher: event.slasher.toString(),
                reason: event.reason,
                amount: event.amount.toString(),
                remainingStake: event.remainingStake.toString(),
                slashCount: event.slashCount,
                txHash: ctx.txHash,
                ts: ctx.now,
            };

            deps.logger.warn('SLASH — this automaton was slashed', { ...payload });
            deps.onSelfSlash?.(payload);

            if (deps.webhookUrl !== undefined && fetchImpl !== undefined) {
                postWebhookDetached(fetchImpl, deps.webhookUrl, payload, deps.logger);
            }
        },
    };
}

function postWebhookDetached(
    fetchImpl: typeof fetch,
    url: string,
    payload: SelfSlashPayload,
    logger: WorkerLogger,
): void {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), WEBHOOK_TIMEOUT_MS);

    fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'self-slash', ...payload }),
        signal: ac.signal,
    })
        .then((res) => {
            if (!res.ok) {
                logger.error('slash webhook POST non-OK', {
                    status: res.status,
                    url,
                });
            }
        })
        .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error('slash webhook POST failed', { error: msg });
        })
        .finally(() => clearTimeout(timer));
}

/**
 * Logs consumer changes. The worker doesn't cache `consumerCount` in
 * memory (stake commands read fresh each invocation), so there's no
 * state to patch — this handler is purely informational / metric bait.
 */
export function consumerWatchHandler(logger: WorkerLogger): EventHandler {
    return {
        onPool(event, ctx: TxContext) {
            if (event.kind !== 'ConsumerUpdated') return;
            logger.info('pool consumer set changed', {
                contract: event.contract.toString(),
                isActive: event.isActive,
                consumerCount: event.consumerCount,
                txHash: ctx.txHash,
            });
        },
    };
}
