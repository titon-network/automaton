// Fortuna VRF — operator path. Threshold-BLS signing of `RequestRandomness`
// alphas, racing peers to land `FulfillRandomness` before the deadline.
//
// Wires:
//   - Atlas + Fortuna addresses     (resolveAddresses)
//   - Atlas + Fortuna contracts     (openContracts)
//   - Atlas + Fortuna schema check  (schemaChecks)
//   - Fortuna external-out events   (eventStreams)
//   - FortunaWorker bootstrap       (bootstrapWorker — gated on bls.enc presence)
//   - Config-cache invalidator      (buildHandlers)
//   - Per-self awareness handlers   (buildHandlers)
//   - Protocol-health logger        (buildHandlers)
//   - explainError fortuna table    (explainError)
//   - SDK-resolves install checks   (doctorInstallChecks)
//
// The fortuna product is the canonical reference for adding new products
// (Phoebe price oracle, Argus indexer, …). Copy the shape — the only file
// outside `src/products/` that needs to know about a new product is the
// `config.products.<name>` boolean in `src/config/schema.ts`.

import type { Address, OpenedContract } from '@ton/core';
import {
    Atlas,
    ATLAS_TESTNET,
    ATLAS_MAINNET,
    ATLAS_STORAGE_VERSION,
} from '@titon-network/atlas-sdk';
import {
    Fortuna,
    FORTUNA_TESTNET,
    FORTUNA_MAINNET,
    FORTUNA_STORAGE_VERSION,
    decodeEvents as decodeFortunaEvents,
    explainError as explainFortunaError,
    type FortunaEvent,
} from '@titon-network/fortuna-sdk';
import { blsKeystoreExists, loadBlsKeystore, unlockBlsKeystore } from '../bls';
import { DeploymentNotAvailableError, parseAddressOrThrow } from '../chain/deployment';
import { FortunaWorker } from '../worker/fortuna';
import type { EventHandler, TxContext } from '../worker/events';
import type { WorkerLogger } from '../worker/loop';
import {
    ShareCache,
    startShareExchangeServer,
    type PkShareLookup,
    type ShareExchangeServer,
} from '../daemon/share-exchange';
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

/** Source key for the Fortuna external-out event stream. Used as the
 *  EventHandler.on key for any handler listening on Fortuna events. */
export const FORTUNA_SOURCE = 'fortuna' as const;

export const fortuna: ProductModule = {
    name: 'fortuna',

    isEnabled(config) {
        return config.products.fortuna === true;
    },

    resolveAddresses(config): ProductAddresses {
        if (!fortuna.isEnabled(config)) return {};

        const atlasAddr = resolveAtlasAddress(config);
        const fortunaAddr = resolveFortunaAddress(config);
        return { atlas: atlasAddr, fortuna: fortunaAddr };
    },

    openContracts({ client, addresses }): ProductContracts {
        if (Object.keys(addresses).length === 0) return {};
        return {
            atlas: client.open(Atlas.createFromAddress(addresses.atlas!)),
            fortuna: client.open(Fortuna.createFromAddress(addresses.fortuna!)),
        };
    },

    schemaChecks({ contracts }): SchemaCheckTask[] {
        const atlas = contracts.atlas as OpenedContract<Atlas> | undefined;
        const fortunaContract = contracts.fortuna as OpenedContract<Fortuna> | undefined;
        if (atlas === undefined || fortunaContract === undefined) return [];
        return [
            {
                contract: 'atlas',
                address: atlas.address,
                expected: ATLAS_STORAGE_VERSION,
                sdkVariable: 'ATLAS_STORAGE_VERSION',
                read: async () => (await atlas.getSchemaVersions()).storage,
            },
            {
                contract: 'fortuna',
                address: fortunaContract.address,
                expected: FORTUNA_STORAGE_VERSION,
                sdkVariable: 'FORTUNA_STORAGE_VERSION',
                read: async () => (await fortunaContract.getSchemaVersions()).storage,
            },
        ];
    },

    // Note: Atlas's own event stream isn't drained because Fortuna re-emits
    // the relevant rotation / operator-mirror events as its own
    // `GroupKeyCached` / `OperatorMirrored`. One drain covers both protocols.
    eventStreams({ addresses }): EventSource[] {
        if (addresses.fortuna === undefined) return [];
        return [
            {
                source: FORTUNA_SOURCE,
                address: addresses.fortuna,
                decode: (bodies) => decodeFortunaEvents(bodies),
            },
        ];
    },

    async bootstrapWorker(ctx): Promise<ProductWorker | undefined> {
        if (!blsKeystoreExists()) {
            throw new Error(
                'products.fortuna is enabled but bls.enc is missing. ' +
                    'Run `automaton bls keygen` to create it.',
            );
        }

        const fortunaContract = ctx.contracts.fortuna as OpenedContract<Fortuna> | undefined;
        if (fortunaContract === undefined) {
            // Should have been caught at buildChainRuntime — assertion here as
            // a defense-in-depth signal that the product wiring is consistent.
            throw new Error(
                'products.fortuna enabled but openContracts returned no fortuna handle. ' +
                    'This is a bug in the fortuna ProductModule.',
            );
        }

        const blsBlob = loadBlsKeystore();
        const blsSecret = unlockBlsKeystore(blsBlob, ctx.walletPassword!);

        // Multi-op wiring: when config.fortuna.peers is non-empty, build
        // a shared ShareCache + start the share-exchange HTTP server +
        // pass everything into the FortunaWorker so it runs the
        // threshold-additive flow. Empty peers list = solo-mode fast-path
        // (no server, no cache, current testnet-canary behavior).
        const fortunaCfg = ctx.config.fortuna;
        const peers = fortunaCfg?.peers ?? [];
        let shareCache: ShareCache | undefined;
        let shareServer: ShareExchangeServer | undefined;

        if (peers.length > 0) {
            const atlasContract = ctx.contracts.atlas as OpenedContract<Atlas> | undefined;
            if (atlasContract === undefined) {
                throw new Error(
                    'multi-op fortuna requires the atlas contract handle, ' +
                        'but ctx.contracts.atlas is undefined.',
                );
            }
            shareCache = new ShareCache();

            // Atlas-backed pkShare lookup. Cached by (peer-address, epoch);
            // Atlas's groupKey rotation invalidates by epoch — old entries
            // for prior epochs simply become unreachable when the lookup
            // is called for the new epoch. We do not pre-populate; lookup
            // is reactive on the first inbound share from each peer.
            const pkShareCacheByEpoch = new Map<number, Map<string, string>>();
            const lookupPkShare: PkShareLookup = async (peerAddress, groupEpoch) => {
                const k = peerAddress.toString({ bounceable: false });
                const epochCache = pkShareCacheByEpoch.get(groupEpoch);
                const hit = epochCache?.get(k);
                if (hit !== undefined) return hit;
                // groupId = 0 (v1 single-group; see atlas/CLAUDE.md §"Multi-group forward-compat").
                const share = await atlasContract.getOperatorShare(0, peerAddress);
                if (share === null || !share.hasShare || share.shareEpoch !== groupEpoch) {
                    return null;
                }
                const hex = share.pkShare.toString('hex');
                const inner = pkShareCacheByEpoch.get(groupEpoch) ?? new Map<string, string>();
                inner.set(k, hex);
                pkShareCacheByEpoch.set(groupEpoch, inner);
                return hex;
            };

            const knownPeers = new Set(peers.map((p) => p.address));
            shareServer = await startShareExchangeServer({
                port: fortunaCfg?.shareExchangePort ?? 9091,
                host: fortunaCfg?.shareExchangeHost ?? '127.0.0.1',
                logger: ctx.logger,
                knownPeers,
                lookupPkShare,
                cache: shareCache,
            });
        }

        const worker = new FortunaWorker({
            fortuna: fortunaContract,
            client: ctx.client,
            wallet: ctx.wallet,
            blsSecret,
            logger: ctx.logger,
            peers,
            shareCache,
            leaderGraceSec: fortunaCfg?.leaderGraceSec,
            // Hand the server handle so worker.dispose() can close it on
            // shutdown without the orchestrator needing to know about it.
            serverHandle: shareServer,
        });
        ctx.logger.info('fortuna worker initialised', {
            pkShare: blsBlob.publicKey,
            atlas: ctx.addresses.atlas?.toString(),
            fortuna: ctx.addresses.fortuna?.toString(),
            mode: peers.length > 0 ? `multi-op (n=${peers.length + 1})` : 'solo',
            shareExchangePort: shareServer?.port,
        });
        return worker;
    },

    buildHandlers(ctx): EventHandler[] {
        const handlers: EventHandler[] = [
            // Per-self awareness — fortuna events that name THIS automaton.
            // Parallel to `kronosAwarenessHandler` (src/products/kronos.ts)
            // and `forgetonAwarenessHandler` (src/worker/handlers.ts) — each
            // protocol owns its own event-kind strings.
            fortunaAwarenessHandler(ctx.wallet.address, ctx.logger),
            // Protocol-health logger — fortuna pause/unpause/group-key rotation/
            // config update / upgrade lifecycle / fee withdrawal. Always-on,
            // info-level (warn for adverse transitions).
            fortunaHealthHandler(ctx.logger),
        ];
        // Config-cache invalidator — only useful when a worker is present,
        // because it pokes worker.dropConfigCache().
        if (ctx.worker !== undefined) {
            handlers.push(fortunaConfigInvalidatorHandler(ctx.worker as FortunaWorker, ctx.logger));
        }
        return handlers;
    },

    explainError(code) {
        // explainFortunaError already returns the canonical shape; cast
        // narrows the SDK's union to our open-string `origin`.
        return explainFortunaError(code) as ErrorExplanation;
    },

    doctorInstallChecks(): InstallCheck[] {
        return [
            makeSdkResolveCheck('@titon-network/atlas-sdk'),
            makeSdkResolveCheck('@titon-network/fortuna-sdk'),
        ];
    },
};

// ===== Internal helpers =====

function resolveAtlasAddress(config: import('../config/schema').Config): Address {
    const override = config.fortuna?.atlasAddress;
    if (override !== undefined) return parseAddressOrThrow(override, 'atlas');

    const sdk = config.network === 'testnet' ? ATLAS_TESTNET : ATLAS_MAINNET;
    if (sdk !== null) return sdk.atlas;

    throw new DeploymentNotAvailableError(
        `Atlas ${config.network} deployment is not yet live in @titon-network/atlas-sdk, ` +
            `and no override was supplied.\n` +
            `  Set config.fortuna.atlasAddress, or export AUTOMATON_ATLAS_ADDRESS, or ` +
            `wait for the SDK to ship a non-null ATLAS_${config.network.toUpperCase()}.`,
    );
}

function resolveFortunaAddress(config: import('../config/schema').Config): Address {
    const override = config.fortuna?.fortunaAddress;
    if (override !== undefined) return parseAddressOrThrow(override, 'fortuna');

    const sdk = config.network === 'testnet' ? FORTUNA_TESTNET : FORTUNA_MAINNET;
    if (sdk !== null) return sdk.fortuna;

    throw new DeploymentNotAvailableError(
        `Fortuna ${config.network} deployment is not yet live in @titon-network/fortuna-sdk, ` +
            `and no override was supplied.\n` +
            `  Set config.fortuna.fortunaAddress, or export AUTOMATON_FORTUNA_ADDRESS, or ` +
            `wait for the SDK to ship a non-null FORTUNA_${config.network.toUpperCase()}.`,
    );
}

/**
 * Drop the FortunaWorker's cached config on Fortuna `ConfigUpdated`. The
 * worker uses the cached `submitterReward` + `minForwardReserve` to size
 * the FulfillRandomness value; an owner-side retune (UpdateConfig) needs
 * to propagate without waiting out the 5-minute TTL or the next
 * fulfillment would attach the wrong value and the message would either
 * over-pay or fail at the floor.
 */
function fortunaConfigInvalidatorHandler(
    worker: FortunaWorker,
    logger: WorkerLogger,
): EventHandler {
    return {
        on: {
            [FORTUNA_SOURCE]: (event: FortunaEvent, ctx: TxContext) => {
                if (event.kind !== 'ConfigUpdated') return;
                worker.dropConfigCache();
                logger.info('fortuna: ConfigUpdated — worker config cache invalidated', {
                    baseRequestFee: event.baseRequestFee.toString(),
                    submitterReward: event.submitterReward.toString(),
                    requestTtl: event.requestTtl,
                    minForwardReserve: event.minForwardReserve.toString(),
                    txHash: ctx.txHash,
                });
            },
        },
    };
}

/** Fortuna events that name THIS automaton. Mirrors the kronos/forgeton
 *  variant in src/worker/handlers.ts but for fortuna's event kinds. */
function fortunaAwarenessHandler(me: Address, logger: WorkerLogger): EventHandler {
    return {
        on: {
            [FORTUNA_SOURCE]: (event: FortunaEvent, ctx: TxContext) => {
                if (event.kind !== 'OperatorMirrored') return;
                if (!event.automaton.equals(me)) return;
                logger.info('fortuna: operator mirror updated for self', {
                    isActive: event.isActive,
                    cause: event.cause,
                    txHash: ctx.txHash,
                });
            },
        },
    };
}

/** Fortuna protocol-health log — pause/unpause/group-key rotation/config/upgrade
 *  lifecycle/fee withdrawals. Always-on; never targets a specific automaton. */
function fortunaHealthHandler(logger: WorkerLogger): EventHandler {
    return {
        on: {
            [FORTUNA_SOURCE]: (event: FortunaEvent, ctx: TxContext) => {
                switch (event.kind) {
                    case 'Paused':
                        logger.warn('fortuna: PAUSED — request creation will be rejected; existing fulfillments still process', {
                            txHash: ctx.txHash,
                        });
                        return;
                    case 'Unpaused':
                        logger.info('fortuna: resumed', { txHash: ctx.txHash });
                        return;
                    case 'GroupKeyCached':
                        // Atlas published a new group key (rotation or first bootstrap).
                        // Operator should re-check BLS share registration if rotation
                        // changed membership; signed alphas against pre-rotation
                        // pkShare won't verify.
                        logger.warn('fortuna: group key rotated — re-check BLS share registration if epoch changed', {
                            oldEpoch: event.oldEpoch,
                            newEpoch: event.newEpoch,
                            threshold: event.threshold,
                            memberCount: event.memberCount,
                            txHash: ctx.txHash,
                        });
                        return;
                    case 'CodeUpgradeProposed':
                        logger.warn('fortuna: code upgrade proposed', {
                            newCodeHash: event.newCodeHash.toString(16),
                            eta: event.eta,
                            txHash: ctx.txHash,
                        });
                        return;
                    case 'CodeUpgradeExecuted':
                        logger.warn('fortuna: code upgraded — may need to re-sync SDK', {
                            newCodeHash: event.newCodeHash.toString(16),
                            oldCodeHash: event.oldCodeHash.toString(16),
                            txHash: ctx.txHash,
                        });
                        return;
                    case 'CodeUpgradeCancelled':
                        logger.info('fortuna: code upgrade cancelled', {
                            newCodeHash: event.newCodeHash.toString(16),
                            txHash: ctx.txHash,
                        });
                        return;
                    case 'FeesWithdrawn':
                        logger.info('fortuna: owner withdrew accumulated fees', {
                            to: event.to.toString(),
                            amount: event.amount.toString(),
                            txHash: ctx.txHash,
                        });
                        return;
                    default:
                        return;
                }
            },
        },
    };
}
