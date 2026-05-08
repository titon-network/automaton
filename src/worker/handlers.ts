// Built-in BASELINE event handlers — composable EventHandler factories
// the daemon wires into `drainEvents` regardless of which products are
// enabled. Each factory returns an EventHandler with one or more
// `on[source]` callbacks; drainEvents looks up the callback by the
// EventSource's `source` key.
//
// Scope:
//   - selfSlashHandler              — ForgeTON `AutomatonSlashed { automaton==me }` → alert + webhook
//   - consumerWatchHandler          — ForgeTON `ConsumerUpdated` → log
//   - forgetonAwarenessHandler      — every ForgeTON event naming THIS automaton
//   - forgetonHealthHandler         — ForgeTON config / pause / consumer-cap / upgrade lifecycle
//
// PRODUCT-SPECIFIC handlers live in `src/products/<name>.ts`:
//   - kronos:  mirror patch, AssignedAutomatonMissed/JobExecuted awareness, registry-health log
//   - fortuna: config-cache invalidator, OperatorMirrored awareness, fortuna-health log
//
// Adding a new handler: copy the shape of `consumerWatchHandler` — return
// an EventHandler with `on: { <source>: (event, ctx) => { /* filter on
// event.kind */ } }`. Never throw; `drainEvents` refuses to advance the
// checkpoint on handler throws, which blocks forward progress until the
// handler is fixed.

import type { Address } from '@ton/core';
import type { ForgetonEvent } from '@titon-network/forgeton-sdk';
import type { EventHandler, TxContext } from './events';
import { POOL_SOURCE } from './baseline-sources';
import type { WorkerLogger } from './loop';

const WEBHOOK_TIMEOUT_MS = 5_000;

export interface SlashAlertDeps {
    me: Address;
    logger: WorkerLogger;
    /** Optional webhook URL — when set, we POST a JSON notification on self-slash. */
    webhookUrl?: string;
    /** Injected for tests — defaults to global fetch. */
    fetch?: typeof fetch;
    /** Invoked on every self-slash; production wires this to `metrics.eventCounters.selfSlash`. */
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
    // Node 22+ ships a global `fetch`; package.json pins `"node": ">=22"`,
    // so we treat it as always present. Tests override via deps.fetch.
    const fetchImpl = deps.fetch ?? fetch;

    return {
        on: {
            [POOL_SOURCE]: (event: ForgetonEvent, ctx: TxContext) => {
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

                if (deps.webhookUrl !== undefined) {
                    postWebhookDetached(fetchImpl, deps.webhookUrl, payload, deps.logger);
                }
            },
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
    // .unref() so a stalled webhook can never hold the event loop open
    // past graceful shutdown. This is the only legitimate `.unref()`
    // setTimeout in the codebase — every retry / poll path uses
    // `defaultSleep` (ref-ed) so one-shot CLI commands don't exit mid-
    // backoff with empty stdout.
    const timer = setTimeout(() => ac.abort(), WEBHOOK_TIMEOUT_MS).unref();

    fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'self-slash', ...payload }),
        signal: ac.signal,
        // SSRF defense: refuse redirects. The configured webhook host is
        // schema-validated against cloud-metadata IPs (see
        // `isAllowedWebhookUrl` in src/config/schema.ts), but undici's
        // default `redirect: 'follow'` would let an allowed host 30x to
        // 169.254.169.254. 'error' surfaces redirects as a fetch failure
        // which the .catch logs and discards — fine for a fire-and-forget
        // alert path.
        redirect: 'error',
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
        on: {
            [POOL_SOURCE]: (event: ForgetonEvent, ctx: TxContext) => {
                if (event.kind !== 'ConsumerUpdated') return;
                logger.info('pool consumer set changed', {
                    contract: event.contract.toString(),
                    isActive: event.isActive,
                    consumerCount: event.consumerCount,
                    txHash: ctx.txHash,
                });
            },
        },
    };
}

/**
 * ForgeTON events that name THIS automaton — stake lifecycle, opt-in,
 * prune, force-sync. Filters out events targeting OTHER automatons (the
 * pool emits these for every operator; this one only cares about its
 * own).
 *
 * Per-product awareness (kronos AssignedAutomatonMissed for self,
 * fortuna OperatorMirrored for self, future phoebe equivalents) lives
 * inside the product module's `buildHandlers` — this handler is purely
 * the ForgeTON-baseline subset.
 */
export function forgetonAwarenessHandler(me: Address, logger: WorkerLogger): EventHandler {
    return {
        on: {
            [POOL_SOURCE]: (event: ForgetonEvent, ctx: TxContext) => {
                switch (event.kind) {
                    case 'AutomatonRegistered':
                    case 'StakeIncreased':
                    case 'UnstakeRequested':
                    case 'UnstakeCancelled':
                    case 'Unstaked': {
                        if (!event.automaton.equals(me)) return;
                        logger.info(`forgeton: ${event.kind} for self`, {
                            kind: event.kind,
                            txHash: ctx.txHash,
                        });
                        return;
                    }
                    case 'AutomatonOptInChanged': {
                        if (!event.automaton.equals(me)) return;
                        logger.info('forgeton: opt-in flag changed for self', {
                            consumer: event.consumer.toString(),
                            isOptedIn: event.isOptedIn,
                            txHash: ctx.txHash,
                        });
                        return;
                    }
                    case 'AutomatonPruned': {
                        if (!event.automaton.equals(me)) return;
                        logger.warn('forgeton: PRUNED — owner forcibly removed this automaton from the pool', {
                            txHash: ctx.txHash,
                        });
                        return;
                    }
                    case 'PausedChanged': {
                        if (event.isPaused) {
                            logger.warn('forgeton: pool was PAUSED — slashes still process; new registrations rejected', {
                                txHash: ctx.txHash,
                            });
                        } else {
                            logger.info('forgeton: pool resumed', { txHash: ctx.txHash });
                        }
                        return;
                    }
                    case 'ForceSyncTriggered': {
                        if (!event.automaton.equals(me)) return;
                        logger.info('forgeton: pool owner triggered ForceSync for self — mirror state re-broadcast', {
                            isActive: event.isActive,
                            consumerCount: event.consumerCount,
                            txHash: ctx.txHash,
                        });
                        return;
                    }
                    default:
                        return;
                }
            },
        },
    };
}

/**
 * ForgeTON-side protocol-health logger — pool config / consumer-cap /
 * code-upgrade lifecycle. Logs at info; never throws; no side effects.
 *
 * Per-product health logs (kronos registry config / housekeeping /
 * upgrade lifecycle, fortuna group-key rotation / fortuna config update,
 * future phoebe / argus equivalents) live in their respective product
 * modules — this handler is purely the ForgeTON-baseline subset.
 */
export function forgetonHealthHandler(logger: WorkerLogger): EventHandler {
    return {
        on: {
            [POOL_SOURCE]: (event: ForgetonEvent, ctx: TxContext) => {
                switch (event.kind) {
                    case 'ForgetonConfigUpdated': {
                        logger.info('forgeton: pool config updated', {
                            minStake: event.minStake.toString(),
                            unstakeCooldown: event.unstakeCooldown,
                            syncGasCost: event.syncGasCost.toString(),
                            txHash: ctx.txHash,
                        });
                        break;
                    }
                    case 'ConsumerSlashCapUpdated': {
                        logger.info('forgeton: consumer slash cap updated', {
                            consumer: event.consumer.toString(),
                            maxSlashPerEvent: event.maxSlashPerEvent.toString(),
                            txHash: ctx.txHash,
                        });
                        break;
                    }
                    case 'CodeUpdated': {
                        logger.warn('forgeton: pool code upgraded — may need to re-sync SDK', {
                            codeHash: event.codeHash.toString(16),
                            oldCodeHash: event.oldCodeHash.toString(16),
                            txHash: ctx.txHash,
                        });
                        break;
                    }
                    default:
                        return;
                }
            },
        },
    };
}
