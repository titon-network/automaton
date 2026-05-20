// Kronos automation — operator path. Polls the registry per tick,
// decides which jobs to execute, and sends `Execute` for each due job.
// Reacts to `AutomatonMirrorUpdated` to keep the assignment-rotation
// cache fresh; logs `AssignedAutomatonMissed` / `JobExecuted` events
// targeting this automaton.
//
// Kronos is the default-on product (every fresh `automaton init` sets
// `products.kronos = true`), but it follows the same `ProductModule`
// shape as Fortuna / Phoebe / Argus — a specialised operator (e.g. a
// Phoebe-only oracle node) can disable it and the daemon adapts.
//
// Wires:
//   - Registry address          (resolveAddresses)
//   - Registry contract         (openContracts)
//   - Registry schema check     (schemaChecks)
//   - Registry external-out     (eventStreams)
//   - KronosWorker bootstrap    (bootstrapWorker)
//   - Mirror cache patch        (buildHandlers)
//   - Per-self awareness        (buildHandlers — AssignedAutomatonMissed,
//                                JobExecuted, kronos PausedChanged)
//   - Registry-health log       (buildHandlers — ConfigUpdated, etc.)
//   - explainError kronos table (explainError)
//   - SDK-resolves install check (doctorInstallChecks)

import type { Address, OpenedContract } from '@ton/core';
import {
    KronosRegistry,
    KRONOS_MAINNET,
    KRONOS_TESTNET,
    REGISTRY_STORAGE_VERSION,
    decodeEvent as decodeKronosEvent,
    explainError as explainKronosError,
    type KronosEvent,
} from '@titon-network/kronos-sdk';
import { AutomatonMirror } from '../worker/mirror';
import { runWorkerCycle, type SubmitExecuteFn, type WorkerCounters } from '../worker/loop';
import type { EventHandler, TxContext } from '../worker/events';
import type { WorkerLogger } from '../worker/loop';
import type { AutomatonWallet } from '../wallet';
import type { FailoverTonClient } from '../chain/ton-client';
import type { DaemonMetrics } from '../daemon/metrics';
import {
    makeSdkResolveCheck,
    type ErrorExplanation,
    type EventSource,
    type InstallCheck,
    type ProductAddresses,
    type ProductContext,
    type ProductContracts,
    type ProductModule,
    type ProductWorker,
    type SchemaCheckTask,
} from './types';

/** Source key for the Kronos registry external-out event stream. */
export const REGISTRY_SOURCE = 'registry' as const;

/**
 * Operator-side worker for Kronos automation.
 *
 * Encapsulates: AutomatonMirror, in-flight jobId set, per-tick
 * `runWorkerCycle` invocation. Constructed by `kronos.bootstrapWorker`
 * and surfaced via `runtime.products.kronos`.
 */
export class KronosWorker implements ProductWorker {
    readonly mirror: AutomatonMirror;
    readonly inFlight = new Set<bigint>();
    private readonly registry: OpenedContract<KronosRegistry>;
    private readonly client: FailoverTonClient;
    private readonly wallet: AutomatonWallet;
    private readonly logger: WorkerLogger;
    private readonly counters: WorkerCounters;
    private readonly nowSec?: () => number;
    private readonly submitExecute?: SubmitExecuteFn;
    private readonly jobFetchConcurrency?: number;

    constructor(deps: {
        registry: OpenedContract<KronosRegistry>;
        client: FailoverTonClient;
        wallet: AutomatonWallet;
        logger: WorkerLogger;
        counters: WorkerCounters;
        nowSec?: () => number;
        submitExecute?: SubmitExecuteFn;
        jobFetchConcurrency?: number;
        /** Optional pre-built mirror — tests inject an instrumented one to
         *  spy on refresh invocations from the mirror-patch handler. */
        mirror?: AutomatonMirror;
    }) {
        this.registry = deps.registry;
        this.client = deps.client;
        this.wallet = deps.wallet;
        this.logger = deps.logger;
        this.counters = deps.counters;
        this.mirror = deps.mirror ?? new AutomatonMirror(deps.registry);
        if (deps.nowSec !== undefined) this.nowSec = deps.nowSec;
        if (deps.submitExecute !== undefined) this.submitExecute = deps.submitExecute;
        if (deps.jobFetchConcurrency !== undefined) this.jobFetchConcurrency = deps.jobFetchConcurrency;
    }

    async tick(): Promise<unknown> {
        return runWorkerCycle({
            registry: this.registry,
            client: this.client,
            wallet: this.wallet,
            mirror: this.mirror,
            inFlight: this.inFlight,
            counters: this.counters,
            logger: this.logger,
            ...(this.nowSec !== undefined ? { nowSec: this.nowSec } : {}),
            ...(this.submitExecute !== undefined ? { submitExecute: this.submitExecute } : {}),
            ...(this.jobFetchConcurrency !== undefined
                ? { jobFetchConcurrency: this.jobFetchConcurrency }
                : {}),
        });
    }

    hasInFlight(): boolean {
        return this.inFlight.size > 0;
    }

    /** Worker doesn't drive any direct event subscription — the mirror
     *  patch handler (contributed via buildHandlers) consumes events on
     *  its behalf. Returning an empty handler keeps the EventHandler
     *  composition pattern uniform with other workers. */
    eventHandler(): EventHandler {
        return {};
    }
}

export const kronos: ProductModule = {
    name: 'kronos',

    isEnabled(config) {
        return config.products.kronos === true;
    },

    resolveAddresses(config): ProductAddresses {
        if (!kronos.isEnabled(config)) return {};
        return { registry: resolveRegistryAddress(config) };
    },

    openContracts({ client, addresses }): ProductContracts {
        if (addresses.registry === undefined) return {};
        return {
            registry: client.open(KronosRegistry.createFromAddress(addresses.registry)),
        };
    },

    schemaChecks({ contracts }): SchemaCheckTask[] {
        const registry = contracts.registry as OpenedContract<KronosRegistry> | undefined;
        if (registry === undefined) return [];
        return [
            {
                contract: 'registry',
                address: registry.address,
                expected: REGISTRY_STORAGE_VERSION,
                sdkVariable: 'REGISTRY_STORAGE_VERSION',
                read: () => registry.getStorageVersion(),
            },
        ];
    },

    eventStreams({ addresses }): EventSource[] {
        if (addresses.registry === undefined) return [];
        return [
            {
                source: REGISTRY_SOURCE,
                address: addresses.registry,
                // Kronos exports a singular `decodeEvent` that returns null on
                // unknown opcode; map+filter keeps the union cleanly typed.
                decode: (bodies) => {
                    const events: KronosEvent[] = [];
                    for (const body of bodies) {
                        const e = decodeKronosEvent(body);
                        if (e !== null) events.push(e);
                    }
                    return events;
                },
            },
        ];
    },

    async bootstrapWorker(ctx): Promise<ProductWorker | undefined> {
        const registry = ctx.contracts.registry as OpenedContract<KronosRegistry> | undefined;
        if (registry === undefined) {
            throw new Error(
                'products.kronos enabled but openContracts returned no registry handle. ' +
                    'This is a bug in the kronos ProductModule.',
            );
        }
        return new KronosWorker({
            registry,
            client: ctx.client,
            wallet: ctx.wallet,
            logger: ctx.logger,
            counters: ctx.metrics?.counters ?? NOOP_COUNTERS,
        });
    },

    buildHandlers(ctx): EventHandler[] {
        const handlers: EventHandler[] = [
            // Per-self awareness — kronos events naming THIS automaton
            // (assigned-miss, JobExecuted, registry pause flips).
            kronosAwarenessHandler(ctx.wallet.address, ctx.logger),
            // Protocol-health logger — registry-wide config / treasury /
            // housekeeping / upgrade lifecycle / slash retry.
            kronosHealthHandler(ctx.logger),
        ];
        // Mirror cache patch — only wired when the worker is present
        // (the mirror lives on the worker instance).
        if (ctx.worker !== undefined) {
            const worker = ctx.worker as KronosWorker;
            handlers.push(mirrorPatchHandler(worker.mirror, ctx.logger));
        }
        return handlers;
    },

    explainError(code) {
        return explainKronosError(code) as ErrorExplanation;
    },

    doctorInstallChecks(): InstallCheck[] {
        return [makeSdkResolveCheck('@titon-network/kronos-sdk')];
    },
};

// ===== Internal helpers =====

const NOOP_COUNTERS: WorkerCounters = {
    incrementExecuteAttempt: () => undefined,
    incrementExecuteSuccess: () => undefined,
    incrementExecuteFailure: () => undefined,
    incrementSkip: () => undefined,
    incrementInFlightCollision: () => undefined,
};

function resolveRegistryAddress(config: import('../config/schema').Config): Address {
    switch (config.network) {
        case 'testnet':
            return KRONOS_TESTNET.registry;
        case 'mainnet':
            return KRONOS_MAINNET.registry;
    }
}

/**
 * Invalidates the mirror cache on any `AutomatonMirrorUpdated`. Debounced:
 * a stake burst can land N mirror events in one drain, but we only want
 * to pay one `refresh()` round-trip per cycle.
 *
 * Exported for sandbox tests that exercise the handler against a
 * pre-built (instrumented) mirror — production wiring goes through
 * `kronos.buildHandlers`.
 */
export function mirrorPatchHandler(mirror: AutomatonMirror, logger: WorkerLogger): EventHandler {
    let needsRefresh = false;
    let lastEventCount: number | undefined;
    return {
        on: {
            [REGISTRY_SOURCE]: (event: KronosEvent) => {
                if (event.kind !== 'AutomatonMirrorUpdated') return;
                needsRefresh = true;
                lastEventCount = event.activeAutomatonCount;
            },
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

/** Kronos events that name THIS automaton — AssignedAutomatonMissed
 *  (assigned to us OR executed by us when someone else missed) and
 *  JobExecuted for self. Parallel to `fortunaAwarenessHandler`
 *  (`OperatorMirrored` for self) and `forgetonAwarenessHandler`
 *  (stake lifecycle / opt-in / prune for self). */
function kronosAwarenessHandler(me: Address, logger: WorkerLogger): EventHandler {
    return {
        on: {
            [REGISTRY_SOURCE]: (event: KronosEvent, ctx: TxContext) => {
                switch (event.kind) {
                    case 'AssignedAutomatonMissed': {
                        const assignedIsMe = event.assigned.equals(me);
                        const executorIsMe = event.executor.equals(me);
                        if (assignedIsMe) {
                            logger.warn('kronos: missed an assigned slot — fallback automaton picked it up', {
                                jobId: event.jobId.toString(),
                                executor: event.executor.toString(),
                                txHash: ctx.txHash,
                            });
                        } else if (executorIsMe) {
                            logger.info('kronos: executed a fallback slot the assigned operator missed', {
                                jobId: event.jobId.toString(),
                                missedBy: event.assigned.toString(),
                                txHash: ctx.txHash,
                            });
                        }
                        break;
                    }
                    case 'JobExecuted': {
                        if (!event.automaton.equals(me)) return;
                        logger.debug('kronos: JobExecuted observed for self', {
                            jobId: event.jobId.toString(),
                            executionCount: event.executionCount,
                            reward: event.reward.toString(),
                            protocolFee: event.protocolFee.toString(),
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

/** Kronos protocol-health log — registry-wide pause flips, owner-side
 *  config / treasury / housekeeping pin / upgrade lifecycle / SlashRetried.
 *  Always-on; never targets a specific automaton (parallel to
 *  `fortunaHealthHandler` and `forgetonHealthHandler`). */
function kronosHealthHandler(logger: WorkerLogger): EventHandler {
    return {
        on: {
            [REGISTRY_SOURCE]: (event: KronosEvent, ctx: TxContext) => {
                switch (event.kind) {
                    case 'PausedChanged': {
                        // Registry-wide pause flip. Worker tick re-reads
                        // `getIsPaused` every cycle anyway — this is the
                        // operator-facing log trail so they know WHY their
                        // attempts started no-op'ing.
                        if (event.paused) {
                            logger.warn('kronos: registry was just PAUSED — Execute submissions will be skipped', {
                                txHash: ctx.txHash,
                            });
                        } else {
                            logger.info('kronos: registry resumed', { txHash: ctx.txHash });
                        }
                        break;
                    }
                    case 'ConfigUpdated': {
                        logger.info('kronos: registry config updated', {
                            minReward: event.minReward.toString(),
                            protocolFeeBps: event.protocolFeeBps,
                            primaryWindowSeconds: event.primaryWindowSeconds,
                            slashGasCost: event.slashGasCost.toString(),
                            txHash: ctx.txHash,
                        });
                        break;
                    }
                    case 'TreasuryUpdated': {
                        logger.info('kronos: treasury address updated', {
                            treasury: event.treasury.toString(),
                            txHash: ctx.txHash,
                        });
                        break;
                    }
                    case 'HousekeepingJobSet': {
                        logger.info('kronos: housekeeping job pinned', {
                            jobId: event.jobId.toString(),
                            txHash: ctx.txHash,
                        });
                        break;
                    }
                    case 'ForgetonSet': {
                        logger.info('kronos: forgeton pool address pinned', {
                            forgeton: event.forgeton.toString(),
                            txHash: ctx.txHash,
                        });
                        break;
                    }
                    case 'UpgradeProposed': {
                        logger.warn('kronos: code upgrade proposed', {
                            codeHash: event.codeHash.toString(16),
                            eta: event.eta,
                            txHash: ctx.txHash,
                        });
                        break;
                    }
                    case 'UpgradeCancelled': {
                        logger.info('kronos: code upgrade cancelled', {
                            codeHash: event.codeHash.toString(16),
                            txHash: ctx.txHash,
                        });
                        break;
                    }
                    case 'CodeUpdated': {
                        logger.warn('kronos: code was upgraded — may need to re-sync SDK', {
                            codeHash: event.codeHash.toString(16),
                            oldCodeHash: event.oldCodeHash.toString(16),
                            timestamp: event.timestamp,
                            txHash: ctx.txHash,
                        });
                        break;
                    }
                    case 'SlashRetried': {
                        logger.info('kronos: SlashRetried (owner-driven replay of dropped slash)', {
                            automaton: event.automaton.toString(),
                            jobId: event.jobId.toString(),
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
