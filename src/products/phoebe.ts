// Phoebe price oracle — operator path. Heartbeat-pushes BLS-attested
// Merkle snapshots of the configured static price feeds. Reacts to
// Phoebe's `Paused` / `Unpaused` / `GroupKeyCached` events to keep the
// worker's view of pause + group epoch fresh; logs per-self
// `OperatorMirrored` for off-chain observability.
//
// Wires:
//   - Atlas + Phoebe addresses     (resolveAddresses)
//   - Atlas + Phoebe contracts     (openContracts)
//   - Atlas + Phoebe schema check  (schemaChecks)
//   - Phoebe external-out events   (eventStreams)
//   - PhoebeWorker bootstrap       (bootstrapWorker — gated on bls.enc presence)
//   - Per-self awareness handlers  (buildHandlers — OperatorMirrored, RewardClaimed)
//   - Protocol-health logger       (buildHandlers — pause/group/upgrade/fees)
//   - explainError phoebe table    (explainError)
//   - SDK-resolves install checks  (doctorInstallChecks)

import type { Address, OpenedContract } from '@ton/core';
import {
    Atlas,
    ATLAS_TESTNET,
    ATLAS_MAINNET,
    ATLAS_STORAGE_VERSION,
} from '@titon-network/atlas-sdk';
import {
    Phoebe,
    PHOEBE_TESTNET,
    PHOEBE_MAINNET,
    PHOEBE_STORAGE_VERSION,
    decodeEvents as decodePhoebeEvents,
    explainError as explainPhoebeError,
    type PhoebeEvent,
} from '@titon-network/phoebe-sdk';
import { blsKeystoreExists, loadBlsKeystore, unlockBlsKeystore } from '../bls';
import { DeploymentNotAvailableError, parseAddressOrThrow } from '../chain/deployment';
import { PhoebeWorker, type PhoebeFeedEntry } from '../worker/phoebe';
import type { EventHandler, TxContext } from '../worker/events';
import type { WorkerLogger } from '../worker/loop';
import {
    PhoebeShareCache,
    startPhoebeShareExchangeServer,
    type PkShareLookup,
    type PhoebeShareExchangeServer,
} from '../daemon/share-exchange-phoebe';
import {
    PriceFeedManager,
    buildAdapters,
    type FeedConfig as PriceFeedConfig,
    type FeedSourceBinding,
} from './phoebe-sources';
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

/** Source key for the Phoebe external-out event stream. */
export const PHOEBE_SOURCE = 'phoebe' as const;

export const phoebe: ProductModule = {
    name: 'phoebe',

    isEnabled(config) {
        return config.products.phoebe === true;
    },

    resolveAddresses(config): ProductAddresses {
        if (!phoebe.isEnabled(config)) return {};
        return {
            atlas: resolveAtlasAddress(config),
            phoebe: resolvePhoebeAddress(config),
        };
    },

    openContracts({ client, addresses }): ProductContracts {
        if (Object.keys(addresses).length === 0) return {};
        return {
            atlas: client.open(Atlas.createFromAddress(addresses.atlas!)),
            phoebe: client.open(Phoebe.createFromAddress(addresses.phoebe!)),
        };
    },

    schemaChecks({ contracts }): SchemaCheckTask[] {
        const atlas = contracts.atlas as OpenedContract<Atlas> | undefined;
        const phoebeContract = contracts.phoebe as OpenedContract<Phoebe> | undefined;
        if (atlas === undefined || phoebeContract === undefined) return [];
        return [
            {
                contract: 'atlas',
                address: atlas.address,
                expected: ATLAS_STORAGE_VERSION,
                sdkVariable: 'ATLAS_STORAGE_VERSION',
                read: async () => (await atlas.getSchemaVersions()).storage,
            },
            {
                contract: 'phoebe',
                address: phoebeContract.address,
                expected: PHOEBE_STORAGE_VERSION,
                sdkVariable: 'PHOEBE_STORAGE_VERSION',
                read: async () => (await phoebeContract.getSchemaVersions()).storage,
            },
        ];
    },

    // Atlas's own event stream isn't drained — Phoebe re-emits the
    // relevant rotation / mirror events as its own `GroupKeyCached` /
    // `OperatorMirrored`. One drain covers both protocols.
    eventStreams({ addresses }): EventSource[] {
        if (addresses.phoebe === undefined) return [];
        return [
            {
                source: PHOEBE_SOURCE,
                address: addresses.phoebe,
                decode: (bodies) => decodePhoebeEvents(bodies),
            },
        ];
    },

    async bootstrapWorker(ctx): Promise<ProductWorker | undefined> {
        if (!blsKeystoreExists()) {
            throw new Error(
                'products.phoebe is enabled but bls.enc is missing. ' +
                    'Run `automaton bls keygen` to create it.',
            );
        }

        const phoebeContract = ctx.contracts.phoebe as OpenedContract<Phoebe> | undefined;
        if (phoebeContract === undefined) {
            throw new Error(
                'products.phoebe enabled but openContracts returned no phoebe handle. ' +
                    'This is a bug in the phoebe ProductModule.',
            );
        }

        const blsBlob = loadBlsKeystore();
        const blsSecret = unlockBlsKeystore(blsBlob, ctx.walletPassword!);

        const phoebeCfg = ctx.config.phoebe;
        const feeds = parseFeeds(phoebeCfg?.feeds);
        const peers = phoebeCfg?.peers ?? [];

        // If any feed is dynamic, build the price-source manager: pick
        // the union of source names across all dynamic feeds, instantiate
        // those adapters, hand them to a fresh PriceFeedManager, start
        // the websocket connections. Solo or multi-op, same code path.
        let priceManager: PriceFeedManager | undefined;
        const dynamicFeeds = feeds.filter((f): f is Extract<PhoebeFeedEntry, { kind: 'dynamic' }> =>
            f.kind === 'dynamic',
        );
        if (dynamicFeeds.length > 0) {
            // Honest warning: dynamic feeds aggregate independently per
            // operator, so two operators in a multi-op group can
            // compute different medians (e.g. one received a Coinbase
            // tick the other hasn't yet) → different snapshot roots →
            // BLS partials don't aggregate. The leader-grace fallback
            // still gets a snapshot pushed (some operator submits
            // alone), but the threshold-attestation guarantee is lost
            // for that window. Static feeds are the only path that
            // produces byte-identical roots across operators today;
            // proper multi-op dynamic feeds need a coordination round
            // (v2.1 — leader proposes prices, peers ratify).
            if (peers.length > 0) {
                ctx.logger.warn(
                    'phoebe: dynamic feeds + multi-op peers is BEST-EFFORT. Partial ' +
                        'aggregation may fail when operators see slightly different ' +
                        'tick sets; leader-grace fallback then has one operator ' +
                        'submit alone (losing the threshold-attestation guarantee). ' +
                        'For strict t=n attestation, use static feeds.',
                    { dynamicFeeds: dynamicFeeds.length, peers: peers.length },
                );
            }
            const sourceNames = new Set<string>();
            for (const f of dynamicFeeds) {
                for (const binding of f.cfg.sources) sourceNames.add(binding.name);
                // Single-source dynamic feed = single point of price
                // truth + no median safety net. Loud warn so the
                // operator (and any AI helping configure) catches it.
                if (f.cfg.sources.length === 1) {
                    ctx.logger.warn(
                        'phoebe: dynamic feed has only ONE source — a single ' +
                            'misreport from that exchange will move the signed price ' +
                            'directly. Add at least 2 sources for median safety.',
                        { feedId: f.feedId, source: f.cfg.sources[0]!.name },
                    );
                }
            }
            const adapters = buildAdapters(sourceNames, ctx.logger);
            priceManager = new PriceFeedManager({
                logger: ctx.logger,
                sources: adapters,
                feeds: dynamicFeeds.map((f) => f.cfg),
            });
            try {
                await priceManager.start();
            } catch (err) {
                // Don't leak sockets on a partial-start failure.
                await priceManager.stop().catch(() => undefined);
                throw err;
            }
            ctx.logger.info('phoebe: price-source manager started', {
                adapters: [...sourceNames],
                dynamicFeeds: dynamicFeeds.length,
            });
        }

        // Seed the worker's initial group epoch from a live read so the
        // very first push (under multi-op) has the right value. Failure
        // here is non-fatal — the worker waits for the first
        // GroupKeyCached event and skips pushes meanwhile.
        let initialGroupEpoch = 0;
        try {
            const gk = await phoebeContract.getGroupKey();
            if (gk !== null && gk.groupEpoch > 0) {
                initialGroupEpoch = gk.groupEpoch;
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.logger.warn('phoebe: getGroupKey at bootstrap failed — proceeding with epoch=0', {
                error: msg,
            });
        }

        // Multi-op wiring: build a shared PhoebeShareCache + start the
        // share-exchange HTTP server when peers are configured. Solo
        // takes the fast path (no server, no cache).
        let shareCache: PhoebeShareCache | undefined;
        let shareServer: PhoebeShareExchangeServer | undefined;

        if (peers.length > 0) {
            const atlasContract = ctx.contracts.atlas as OpenedContract<Atlas> | undefined;
            if (atlasContract === undefined) {
                throw new Error(
                    'multi-op phoebe requires the atlas contract handle, ' +
                        'but ctx.contracts.atlas is undefined.',
                );
            }
            shareCache = new PhoebeShareCache();

            // Atlas-backed pkShare lookup. Cached by epoch so an Atlas
            // rotation invalidates by epoch — old entries simply become
            // unreachable when lookup is called for the new epoch.
            const pkShareCacheByEpoch = new Map<number, Map<string, string>>();
            const lookupPkShare: PkShareLookup = async (peerAddress, groupEpoch) => {
                const k = peerAddress.toString({ bounceable: false });
                const epochCache = pkShareCacheByEpoch.get(groupEpoch);
                const hit = epochCache?.get(k);
                if (hit !== undefined) return hit;
                // groupId = 0 (v1 single-group — same convention as fortuna).
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
            shareServer = await startPhoebeShareExchangeServer({
                port: phoebeCfg?.shareExchangePort ?? 9092,
                host: phoebeCfg?.shareExchangeHost ?? '127.0.0.1',
                logger: ctx.logger,
                knownPeers,
                lookupPkShare,
                cache: shareCache,
            });
        }

        // Compose the worker's dispose chain: stop the price-source
        // manager (if any) BEFORE the share-exchange server, so any
        // in-flight aggregate that referenced live ticks settles
        // cleanly. try/finally so a stop failure on one doesn't leak
        // the other.
        const composedServerHandle =
            priceManager !== undefined || shareServer !== undefined
                ? {
                      close: async (): Promise<void> => {
                          try {
                              if (priceManager !== undefined) {
                                  await priceManager.stop();
                                  ctx.logger.info('phoebe: price-source manager stopped');
                              }
                          } finally {
                              if (shareServer !== undefined) await shareServer.close();
                          }
                      },
                  }
                : undefined;

        const worker = new PhoebeWorker({
            phoebe: phoebeContract,
            client: ctx.client,
            wallet: ctx.wallet,
            blsSecret,
            logger: ctx.logger,
            feeds,
            priceManager,
            pushIntervalSec: phoebeCfg?.pushIntervalMs !== undefined
                ? Math.max(1, Math.floor(phoebeCfg.pushIntervalMs / 1000))
                : undefined,
            peers,
            shareCache,
            leaderGraceSec: phoebeCfg?.leaderGraceSec,
            initialGroupEpoch,
            serverHandle: composedServerHandle,
        });
        ctx.logger.info('phoebe worker initialised', {
            pkShare: blsBlob.publicKey,
            atlas: ctx.addresses.atlas?.toString(),
            phoebe: ctx.addresses.phoebe?.toString(),
            feeds: feeds.length,
            mode: peers.length > 0 ? `multi-op (n=${peers.length + 1})` : 'solo',
            shareExchangePort: shareServer?.port,
            initialGroupEpoch,
        });
        return worker;
    },

    buildHandlers(ctx): EventHandler[] {
        return [
            phoebeAwarenessHandler(ctx.wallet.address, ctx.logger),
            phoebeHealthHandler(ctx.logger),
        ];
    },

    explainError(code) {
        // explainPhoebeError already returns the canonical shape; cast
        // narrows the SDK's union to our open-string `origin`.
        return explainPhoebeError(code) as ErrorExplanation;
    },

    doctorInstallChecks(): InstallCheck[] {
        // atlas-sdk is already covered by fortuna's doctorInstallChecks
        // and themis depends on it transitively too; we only need to
        // contribute the phoebe-sdk row to keep `doctor` lean.
        return [
            makeSdkResolveCheck('@titon-network/phoebe-sdk'),
        ];
    },
};

// ===== Internal helpers =====

function resolveAtlasAddress(config: import('../config/schema').Config): Address {
    const override = config.phoebe?.atlasAddress;
    if (override !== undefined) return parseAddressOrThrow(override, 'atlas');

    const sdk = config.network === 'testnet' ? ATLAS_TESTNET : ATLAS_MAINNET;
    if (sdk !== null) return sdk.atlas;

    throw new DeploymentNotAvailableError(
        `Atlas ${config.network} deployment is not yet live in @titon-network/atlas-sdk, ` +
            `and no override was supplied.\n` +
            `  Set config.phoebe.atlasAddress, or export AUTOMATON_ATLAS_ADDRESS, or ` +
            `wait for the SDK to ship a non-null ATLAS_${config.network.toUpperCase()}.`,
    );
}

function resolvePhoebeAddress(config: import('../config/schema').Config): Address {
    const override = config.phoebe?.phoebeAddress;
    if (override !== undefined) return parseAddressOrThrow(override, 'phoebe');

    const sdk = config.network === 'testnet' ? PHOEBE_TESTNET : PHOEBE_MAINNET;
    if (sdk !== null) return sdk.phoebe;

    throw new DeploymentNotAvailableError(
        `Phoebe ${config.network} deployment is not yet live in @titon-network/phoebe-sdk, ` +
            `and no override was supplied.\n` +
            `  Set config.phoebe.phoebeAddress, or export AUTOMATON_PHOEBE_ADDRESS, or ` +
            `wait for the SDK to ship a non-null PHOEBE_${config.network.toUpperCase()}.`,
    );
}

/** Walk `config.phoebe.feeds[]` (the schema's static-or-dynamic union)
 *  and convert to the worker's `PhoebeFeedEntry`. Static entries get
 *  their decimal-string mantissa parsed to bigint; dynamic entries
 *  carry the source bindings + tuning knobs through unchanged. The
 *  input type is derived from the zod schema so a future field
 *  addition flows through automatically (no parallel `RawFeed`
 *  declaration to keep in sync). */
type PhoebeFeedCfg = NonNullable<NonNullable<import('../config/schema').Config['phoebe']>['feeds']>[number];

function parseFeeds(raw: readonly PhoebeFeedCfg[] | undefined): PhoebeFeedEntry[] {
    if (raw === undefined || raw.length === 0) return [];
    return raw.map((f): PhoebeFeedEntry => {
        if ('mantissa' in f) {
            return {
                kind: 'static',
                feedId: f.feedId,
                mantissa: BigInt(f.mantissa),
                expo: f.expo,
                confBps: f.confBps,
            };
        }
        const cfg: PriceFeedConfig = {
            feedId: f.feedId,
            sources: f.sources.map((s): FeedSourceBinding => ({
                name: s.name,
                symbol: s.symbol,
            })),
            ...(f.minSources !== undefined ? { minSources: f.minSources } : {}),
            ...(f.maxStaleMs !== undefined ? { maxStaleMs: f.maxStaleMs } : {}),
            ...(f.expo !== undefined ? { expo: f.expo } : {}),
        };
        return { kind: 'dynamic', feedId: f.feedId, cfg };
    });
}

/** Phoebe events that name THIS automaton. Mirrors the fortuna/themis
 *  variants. */
function phoebeAwarenessHandler(me: Address, logger: WorkerLogger): EventHandler {
    return {
        on: {
            [PHOEBE_SOURCE]: (event: PhoebeEvent, ctx: TxContext) => {
                switch (event.kind) {
                    case 'OperatorMirrored':
                        if (!event.automaton.equals(me)) return;
                        logger.info('phoebe: operator mirror updated for self', {
                            isActive: event.isActive,
                            cause: event.cause,
                            txHash: ctx.txHash,
                        });
                        return;
                    case 'SnapshotPushed':
                        if (!event.submitter.equals(me)) return;
                        logger.info('phoebe: our snapshot accepted', {
                            timestamp: event.timestamp,
                            txHash: ctx.txHash,
                        });
                        return;
                    case 'RewardClaimed':
                        if (!event.claimant.equals(me)) return;
                        logger.info('phoebe: we claimed accrued reward', {
                            amount: event.amount.toString(),
                            to: event.to.toString(),
                            txHash: ctx.txHash,
                        });
                        return;
                    case 'OperatorPruned':
                        if (!event.automaton.equals(me)) return;
                        logger.warn('phoebe: this operator was pruned (inactive too long)', {
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

/** Phoebe protocol-health log — pause/unpause/group rotation/config/upgrade
 *  lifecycle/fee withdrawals. Always-on; never targets a specific automaton.
 *
 *  Paused / Unpaused are dual-purpose: the PhoebeWorker subscribes via its
 *  own eventHandler() to update internal `paused` state (gates pushes);
 *  this handler logs the transition for operators reading the log stream. */
function phoebeHealthHandler(logger: WorkerLogger): EventHandler {
    return {
        on: {
            [PHOEBE_SOURCE]: (event: PhoebeEvent, ctx: TxContext) => {
                switch (event.kind) {
                    case 'Paused':
                        logger.warn('phoebe: PAUSED — push attempts will be rejected', {
                            txHash: ctx.txHash,
                        });
                        return;
                    case 'Unpaused':
                        logger.info('phoebe: resumed', { txHash: ctx.txHash });
                        return;
                    case 'GroupKeyCached':
                        logger.warn('phoebe: group key rotated — re-check BLS share registration if epoch changed', {
                            oldEpoch: event.oldEpoch,
                            newEpoch: event.newEpoch,
                            threshold: event.threshold,
                            memberCount: event.memberCount,
                            txHash: ctx.txHash,
                        });
                        return;
                    case 'ConfigUpdated':
                        logger.info('phoebe: config updated by owner', { txHash: ctx.txHash });
                        return;
                    case 'CodeUpgradeProposed':
                        logger.warn('phoebe: code upgrade proposed', {
                            newCodeHash: event.newCodeHash.toString(16),
                            eta: event.eta,
                            txHash: ctx.txHash,
                        });
                        return;
                    case 'CodeUpgradeExecuted':
                        logger.warn('phoebe: code upgraded — may need to re-sync SDK', {
                            newCodeHash: event.newCodeHash.toString(16),
                            oldCodeHash: event.oldCodeHash.toString(16),
                            txHash: ctx.txHash,
                        });
                        return;
                    case 'CodeUpgradeCancelled':
                        logger.info('phoebe: code upgrade cancelled', {
                            newCodeHash: event.newCodeHash.toString(16),
                            txHash: ctx.txHash,
                        });
                        return;
                    case 'FeesWithdrawn':
                        logger.info('phoebe: owner withdrew accumulated fees', {
                            to: event.to.toString(),
                            amount: event.amount.toString(),
                            txHash: ctx.txHash,
                        });
                        return;
                    case 'SyncAtlasRequested':
                        logger.info('phoebe: owner requested Atlas resync', { txHash: ctx.txHash });
                        return;
                    default:
                        return;
                }
            },
        },
    };
}
