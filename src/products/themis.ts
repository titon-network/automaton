// Themis sealed-bid threshold-decryption — operator path. Threshold-
// decrypts closed-commit-window rounds at every configured chamber,
// BLS-signs the reveal payload, and submits `RevealRound`.
//
// Wires:
//   - Atlas + ForgeTON + Themis-factory addresses (resolveAddresses)
//   - Atlas + factory + per-chamber contracts        (openContracts)
//   - Atlas + factory + per-chamber schema checks    (schemaChecks)
//   - Factory + per-chamber external-out streams     (eventStreams)
//   - ThemisWorker bootstrap (gated on bls.enc + chambers list) (bootstrapWorker)
//   - Per-self awareness handlers (factory ChamberDeployed log)  (buildHandlers)
//   - Protocol-health handler (factory + per-chamber pause/etc)  (buildHandlers)
//   - Per-chamber ConfigUpdated → drop config cache              (buildHandlers)
//   - explainError themis table                                  (explainError)
//   - SDK-resolves install checks                                (doctorInstallChecks)
//
// The themis product follows the same shape as fortuna. The wrinkle is
// parent-child: one factory deploys N chambers, each with its own state.
// Operators configure the chambers they serve via `config.themis.chambers`
// (auto-discovery via the factory's ChamberDeployed events is a v1.1
// extension; v1 keeps the surface explicit so an operator knows exactly
// which chambers they're earning fees + bearing reveal liability for).

import { Address, type OpenedContract } from '@ton/core';
import {
    Atlas,
    ATLAS_TESTNET,
    ATLAS_MAINNET,
    ATLAS_STORAGE_VERSION,
} from '@titon-network/atlas-sdk';
import { FORGETON_TESTNET, FORGETON_MAINNET } from '@titon-network/forgeton-sdk';
import {
    ThemisFactory,
    ThemisChamber,
    THEMIS_TESTNET,
    THEMIS_MAINNET,
    THEMIS_FACTORY_STORAGE_VERSION,
    THEMIS_CHAMBER_STORAGE_VERSION,
    decodeEvents as decodeThemisEvents,
    explainError as explainThemisErrorMessage,
    type ThemisEvent,
} from '@titon-network/themis-sdk';
import { blsKeystoreExists, loadBlsKeystore, unlockBlsKeystore } from '../bls';
import { DeploymentNotAvailableError, parseAddressOrThrow } from '../chain/deployment';
import {
    ThemisWorker,
    THEMIS_FACTORY_SOURCE,
    chamberSourceKey,
    isThemisChamberKey,
    themisChamberAddrKey,
} from '../worker/themis';
import type { EventHandler, TxContext } from '../worker/events';
import type { WorkerLogger } from '../worker/loop';
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

export const themis: ProductModule = {
    name: 'themis',

    isEnabled(config) {
        return config.products.themis === true;
    },

    resolveAddresses(config): ProductAddresses {
        if (!themis.isEnabled(config)) return {};

        const addresses: ProductAddresses = {
            atlas: resolveThemisAtlasAddress(config),
            forgeton: resolveThemisForgetonAddress(config),
            factory: resolveThemisFactoryAddress(config),
        };
        // Per-chamber addresses are surfaced as `chamber:<addr>` keys
        // (see `themisChamberAddrKey`) so the openContracts / schemaChecks /
        // eventStreams loops can iterate them uniformly with the singleton
        // addresses.
        const chambers = config.themis?.chambers ?? [];
        for (const raw of chambers) {
            const addr = parseAddressOrThrow(raw, 'themis-chamber');
            addresses[themisChamberAddrKey(addr)] = addr;
        }
        return addresses;
    },

    openContracts({ client, addresses }): ProductContracts {
        if (Object.keys(addresses).length === 0) return {};
        const contracts: ProductContracts = {
            atlas: client.open(Atlas.createFromAddress(addresses.atlas!)),
            factory: client.open(ThemisFactory.createFromAddress(addresses.factory!)),
        };
        // The forgeton handle is the same baseline pool used by ForgeTON
        // ProductModule consumers — we don't reopen it here (the chain
        // runtime already exposes it via `runtime.pool`). The address is
        // surfaced for the schema-check loop only.
        for (const [k, addr] of Object.entries(addresses)) {
            if (isThemisChamberKey(k)) {
                contracts[k] = client.open(ThemisChamber.createFromAddress(addr));
            }
        }
        return contracts;
    },

    schemaChecks({ contracts }): SchemaCheckTask[] {
        const atlas = contracts.atlas as OpenedContract<Atlas> | undefined;
        const factory = contracts.factory as OpenedContract<ThemisFactory> | undefined;
        if (atlas === undefined || factory === undefined) return [];
        const tasks: SchemaCheckTask[] = [
            {
                contract: 'atlas',
                address: atlas.address,
                expected: ATLAS_STORAGE_VERSION,
                sdkVariable: 'ATLAS_STORAGE_VERSION',
                read: async () => (await atlas.getSchemaVersions()).storage,
            },
            {
                contract: 'themis-factory',
                address: factory.address,
                expected: THEMIS_FACTORY_STORAGE_VERSION,
                sdkVariable: 'THEMIS_FACTORY_STORAGE_VERSION',
                read: async () => (await factory.getSchemaVersions()).storage,
            },
        ];
        for (const [k, contract] of Object.entries(contracts)) {
            if (!isThemisChamberKey(k)) continue;
            const chamber = contract as OpenedContract<ThemisChamber>;
            tasks.push({
                contract: k,
                address: chamber.address,
                expected: THEMIS_CHAMBER_STORAGE_VERSION,
                sdkVariable: 'THEMIS_CHAMBER_STORAGE_VERSION',
                read: async () => (await chamber.getSchemaVersions()).storage,
            });
        }
        return tasks;
    },

    eventStreams({ addresses }): EventSource[] {
        if (addresses.factory === undefined) return [];
        const sources: EventSource[] = [
            {
                source: THEMIS_FACTORY_SOURCE,
                address: addresses.factory,
                decode: (bodies) => decodeThemisEvents(bodies),
            },
        ];
        // One stream per configured chamber. Per-chamber checkpoint state
        // is keyed by source name (in the events drain) so each chamber
        // makes forward progress independently.
        for (const [k, addr] of Object.entries(addresses)) {
            if (!isThemisChamberKey(k)) continue;
            sources.push({
                source: chamberSourceKey(addr),
                address: addr,
                decode: (bodies) => decodeThemisEvents(bodies),
            });
        }
        return sources;
    },

    async bootstrapWorker(ctx): Promise<ProductWorker | undefined> {
        if (!blsKeystoreExists()) {
            throw new Error(
                'products.themis is enabled but bls.enc is missing. ' +
                    'Run `automaton bls keygen` to create it (the same key serves ' +
                    'both Fortuna VRF and Themis reveals — the Atlas group secret).',
            );
        }

        const blsBlob = loadBlsKeystore();
        const blsSecret = unlockBlsKeystore(blsBlob, ctx.walletPassword!);

        const chambersMap = new Map<string, OpenedContract<ThemisChamber>>();
        for (const [k, contract] of Object.entries(ctx.contracts)) {
            if (!isThemisChamberKey(k)) continue;
            const chamber = contract as OpenedContract<ThemisChamber>;
            chambersMap.set(chamber.address.toString({ bounceable: false }), chamber);
        }

        const worker = new ThemisWorker({
            chambers: chambersMap,
            client: ctx.client,
            wallet: ctx.wallet,
            blsSecret,
            logger: ctx.logger,
        });

        ctx.logger.info('themis worker initialised', {
            pkShare: blsBlob.publicKey,
            atlas: ctx.addresses.atlas?.toString(),
            factory: ctx.addresses.factory?.toString(),
            chamberCount: chambersMap.size,
        });
        return worker;
    },

    buildHandlers(ctx): EventHandler[] {
        // Chamber addresses are known at build time: they were resolved
        // by `resolveAddresses` and opened by `openContracts`, both run
        // before `buildHandlers`. We pull them from `ctx.contracts` so
        // each handler registers explicit per-source callbacks (matches
        // fortuna's `[FORTUNA_SOURCE]: ...` pattern; no Proxy needed).
        const chamberAddrs: Address[] = [];
        for (const [k, contract] of Object.entries(ctx.contracts)) {
            if (!isThemisChamberKey(k)) continue;
            chamberAddrs.push((contract as OpenedContract<ThemisChamber>).address);
        }

        const handlers: EventHandler[] = [
            // Per-self awareness — factory's ChamberDeployed event is the
            // primary "new chamber lit up" signal; we log it so operators
            // know to consider adding the chamber to their config.
            themisAwarenessHandler(ctx.wallet.address, ctx.logger, chamberAddrs),
            // Protocol-health logger — factory + per-chamber pause/upgrade/
            // fee-withdrawal lifecycle. Always-on; never targets self.
            themisHealthHandler(ctx.logger, chamberAddrs),
        ];
        // Config-cache invalidator — the worker caches per-chamber config
        // (revealerReward, callbackGas, …); chamber `ConfigUpdated` events
        // need to drop those entries so the next reveal sizes the value
        // attachment correctly.
        if (ctx.worker !== undefined) {
            handlers.push(
                themisConfigInvalidatorHandler(ctx.worker as ThemisWorker, ctx.logger, chamberAddrs),
            );
        }
        return handlers;
    },

    explainError(code) {
        return explainThemisError(code);
    },

    doctorInstallChecks(): InstallCheck[] {
        return [
            makeSdkResolveCheck('@titon-network/themis-sdk'),
        ];
    },
};

// ===== Internal helpers =====

function resolveThemisAtlasAddress(config: import('../config/schema').Config): Address {
    const override = config.themis?.atlasAddress;
    if (override !== undefined) return parseAddressOrThrow(override, 'themis-atlas');

    // Themis pins its own Atlas at deploy time, so the SDK exposes the pinned
    // address in THEMIS_TESTNET/MAINNET. Fall back to the canonical Atlas
    // SDK constant when the themis SDK doesn't ship a deployment yet.
    const themisDep = config.network === 'testnet' ? THEMIS_TESTNET : THEMIS_MAINNET;
    if (themisDep !== null) return themisDep.atlas;

    const atlasDep = config.network === 'testnet' ? ATLAS_TESTNET : ATLAS_MAINNET;
    if (atlasDep !== null) return atlasDep.atlas;

    throw new DeploymentNotAvailableError(
        `Themis ${config.network} deployment is not yet live in @titon-network/themis-sdk, ` +
            `and no override was supplied.\n` +
            `  Set config.themis.atlasAddress, or export AUTOMATON_THEMIS_ATLAS_ADDRESS, or ` +
            `wait for the SDK to ship a non-null THEMIS_${config.network.toUpperCase()}.`,
    );
}

function resolveThemisForgetonAddress(config: import('../config/schema').Config): Address {
    const override = config.themis?.forgetonAddress;
    if (override !== undefined) return parseAddressOrThrow(override, 'themis-forgeton');

    const themisDep = config.network === 'testnet' ? THEMIS_TESTNET : THEMIS_MAINNET;
    if (themisDep !== null) return themisDep.forgeton;

    // Falls back to the baseline ForgeTON pool address. This is identical to
    // what the rest of the daemon uses; surfacing it here keeps the
    // ProductModule self-contained.
    return config.network === 'testnet' ? FORGETON_TESTNET.forgeton : FORGETON_MAINNET.forgeton;
}

function resolveThemisFactoryAddress(config: import('../config/schema').Config): Address {
    const override = config.themis?.factoryAddress;
    if (override !== undefined) return parseAddressOrThrow(override, 'themis-factory');

    const themisDep = config.network === 'testnet' ? THEMIS_TESTNET : THEMIS_MAINNET;
    if (themisDep !== null) return themisDep.factory;

    throw new DeploymentNotAvailableError(
        `Themis ${config.network} deployment is not yet live in @titon-network/themis-sdk, ` +
            `and no override was supplied.\n` +
            `  Set config.themis.factoryAddress, or export AUTOMATON_THEMIS_FACTORY_ADDRESS, or ` +
            `wait for the SDK to ship a non-null THEMIS_${config.network.toUpperCase()}.`,
    );
}

/**
 * Map a numeric exit code to a Themis-rooted ErrorExplanation. Themis
 * owns 152-179 (Themis-specific) plus the chamber-binding 159 sentinel;
 * codes outside its claimed ranges return `origin: 'unknown'` so the
 * unified `explainExitCode` walk falls through to other SDK explainers.
 */
function explainThemisError(code: number): ErrorExplanation {
    // Themis-specific range (152-179). 150 + 151 are reserved.
    const isThemisOwned = code >= 152 && code <= 179;
    if (!isThemisOwned) {
        return { code, origin: 'unknown', name: 'Unknown', message: '' };
    }
    const message = explainThemisErrorMessage(code);
    return {
        code,
        origin: 'themis',
        name: themisErrorName(code),
        message,
    };
}

/** Map themis-specific code → constant name (for ErrorExplanation.name).
 *  Mirrors the `E_*` exports in `@titon-network/themis-sdk/errors`. */
function themisErrorName(code: number): string {
    switch (code) {
        case 152: return 'E_COMMIT_WINDOW_CLOSED';
        case 153: return 'E_COMMIT_WINDOW_OPEN';
        case 154: return 'E_REVEAL_DEADLINE_PASSED';
        case 155: return 'E_REVEAL_DEADLINE_NOT_PASSED';
        case 156: return 'E_ROUND_ALREADY_REVEALED';
        case 157: return 'E_INVALID_CIPHERTEXT';
        case 158: return 'E_BIDS_PER_ROUND_EXCEEDED';
        case 159: return 'E_WRONG_CHAMBER_BINDING';
        case 160: return 'E_INVALID_BLS_SIGNATURE';
        case 162: return 'E_INVALID_G1_POINT';
        case 164: return 'E_GROUP_KEY_NOT_SET';
        case 165: return 'E_GROUP_EPOCH_NOT_MONOTONIC';
        case 166: return 'E_GROUP_EPOCH_STALE_SIGNED';
        case 170: return 'E_OPERATOR_NOT_FOUND';
        case 171: return 'E_OPERATOR_NOT_ACTIVE';
        case 173: return 'E_CONSUMER_NOT_SET';
        case 176: return 'E_INVALID_CONFIG';
        case 179: return 'E_REWARD_POOL_UNDERFLOW';
        default:  return `E_THEMIS_${code}`;
    }
}

/**
 * Drop ThemisWorker's per-chamber config cache on chamber `ConfigUpdated`.
 * Worker uses the cached `revealerReward` / `callbackGas` / `minXcGas` /
 * `minReserve` to size the RevealRound value attachment — an owner-side
 * retune needs to propagate without waiting out the 5-minute TTL.
 *
 * The factory's own ConfigUpdated touches a different blob (deploy-chamber
 * fee, max-fanout); the worker does NOT cache those, so we only react to
 * per-chamber events.
 */
function themisConfigInvalidatorHandler(
    worker: ThemisWorker,
    logger: WorkerLogger,
    chambers: readonly Address[],
): EventHandler {
    const on: EventHandler['on'] = {};
    for (const addr of chambers) {
        on[chamberSourceKey(addr)] = (event: ThemisEvent, ctx: TxContext) => {
            if (event.kind !== 'ConfigUpdated') return;
            worker.dropConfigCache(addr);
            logger.info('themis: chamber ConfigUpdated — worker config cache invalidated', {
                chamber: addr.toString(),
                txHash: ctx.txHash,
            });
        };
    }
    return { on };
}

/**
 * Themis events that name THIS automaton, plus factory `ChamberDeployed`
 * (operator-relevant: a new chamber appeared the operator may want to
 * add to their config). Registers on the factory source key + every
 * configured chamber's source key.
 */
function themisAwarenessHandler(
    me: Address,
    logger: WorkerLogger,
    chambers: readonly Address[],
): EventHandler {
    const on: EventHandler['on'] = {};
    on[THEMIS_FACTORY_SOURCE] = (event: ThemisEvent, ctx: TxContext) => {
        if (event.kind !== 'ChamberDeployed') return;
        logger.info(
            'themis: new chamber deployed by factory — add to ' +
                'config.themis.chambers + restart to serve it',
            {
                serial: event.serial.toString(),
                chamber: event.chamber.toString(),
                chamberOwner: event.chamberOwner.toString(),
                consumer: event.consumer.toString(),
                txHash: ctx.txHash,
            },
        );
    };
    for (const addr of chambers) {
        on[chamberSourceKey(addr)] = (event: ThemisEvent, ctx: TxContext) => {
            if (event.kind !== 'OperatorSynced') return;
            if (!event.automaton.equals(me)) return;
            logger.info('themis: operator-mirror updated for self at chamber', {
                chamber: addr.toString(),
                isActive: event.isActive,
                txHash: ctx.txHash,
            });
        };
    }
    return { on };
}

/**
 * Themis protocol-health log — pause/unpause + group-key rotation +
 * code-upgrade lifecycle + fee withdrawals at the factory and at every
 * chamber. Always-on; never targets a specific automaton.
 *
 * Both factory and chamber emit the same event vocabulary (Paused /
 * Unpaused / UpgradeProposed / CodeUpdated / UpgradeCancelled /
 * FeesWithdrawn); the chamber additionally emits GroupKeyCached and
 * the factory additionally emits ChildCodeUpdated + FanoutCycleComplete.
 * Per-source handlers share a `dispatch(label, event, ctx)` body so the
 * branch list stays in one place.
 */
function themisHealthHandler(logger: WorkerLogger, chambers: readonly Address[]): EventHandler {
    const on: EventHandler['on'] = {};
    on[THEMIS_FACTORY_SOURCE] = (event: ThemisEvent, ctx: TxContext) =>
        dispatchHealth('factory', event, ctx, logger, /* isFactory */ true);
    for (const addr of chambers) {
        const label = `chamber ${addr.toString()}`;
        on[chamberSourceKey(addr)] = (event: ThemisEvent, ctx: TxContext) =>
            dispatchHealth(label, event, ctx, logger, /* isFactory */ false);
    }
    return { on };
}

function dispatchHealth(
    label: string,
    event: ThemisEvent,
    ctx: TxContext,
    logger: WorkerLogger,
    isFactory: boolean,
): void {
    switch (event.kind) {
        case 'Paused':
            logger.warn(`themis: ${label} PAUSED`, { txHash: ctx.txHash });
            return;
        case 'Unpaused':
            logger.info(`themis: ${label} resumed`, { txHash: ctx.txHash });
            return;
        case 'GroupKeyCached':
            // Atlas published a new group key — the chamber's worker
            // state caches it on the same event in `dispatchChamberEvent`;
            // this handler just surfaces it at warn level.
            logger.warn(`themis: ${label} cached new group key — re-check BLS share if epoch changed`, {
                oldEpoch: event.oldEpoch,
                newEpoch: event.newEpoch,
                threshold: event.threshold,
                memberCount: event.memberCount,
                txHash: ctx.txHash,
            });
            return;
        case 'UpgradeProposed':
            logger.warn(`themis: ${label} code upgrade proposed`, {
                newHash: event.newHash.toString(16),
                eta: event.eta,
                txHash: ctx.txHash,
            });
            return;
        case 'CodeUpdated':
            logger.warn(`themis: ${label} code upgraded — may need to re-sync SDK`, {
                oldHash: event.oldHash.toString(16),
                newHash: event.newHash.toString(16),
                txHash: ctx.txHash,
            });
            return;
        case 'UpgradeCancelled':
            logger.info(`themis: ${label} code upgrade cancelled`, { txHash: ctx.txHash });
            return;
        case 'ChildCodeUpdated':
            // Factory-only event; chamber-side ignore is harmless (chamber
            // never emits this opcode) but the guard keeps the log clean.
            if (!isFactory) return;
            logger.warn(`themis: factory child-code (chamber bytecode) upgraded`, {
                oldHash: event.oldHash.toString(16),
                newHash: event.newHash.toString(16),
                txHash: ctx.txHash,
            });
            return;
        case 'FeesWithdrawn':
            logger.info(`themis: ${label} owner withdrew fees`, {
                to: event.to.toString(),
                amount: event.amount.toString(),
                txHash: ctx.txHash,
            });
            return;
        case 'FanoutCycleComplete':
            // Factory-only event; informational.
            if (!isFactory) return;
            logger.debug('themis: factory fan-out cycle complete', {
                syncType: event.syncType,
                txHash: ctx.txHash,
            });
            return;
        default:
            return;
    }
}
