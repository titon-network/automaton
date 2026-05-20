// In-process sandbox runtime — production-grade local simulator.
//
// Bootstraps an isolated Blockchain with both ForgeTON + KronosRegistry
// deployed and wired (SetForgeton + SetConsumer). Returns a bundle that
// conforms to `ChainRuntime` so production code paths (`drainEvents`,
// `runWorkerCycle`, `tickOnce`) run unchanged against the sandbox.
//
// Lives in `src/` (rather than `tests/helpers/`) because both the
// integration tests AND the user-facing `automaton playground` command
// build on the same harness — the playground IS a production-flow
// integration test, just with a TUI instead of jest assertions.
//
// Adapter strategy: `FailoverTonClient` is replaced by a thin facade that
// implements the three methods production actually calls through
// `client.call(fn)`: `getTransactions`, `getBalance`, `getMasterchainInfo`.
// `.open()` delegates to `blockchain.openContract()` — `SandboxContract<T>`
// is structurally compatible with `OpenedContract<T>` for all `get*` /
// `send*` methods, which is the full surface used by the worker.
//
// Wallet strategy: production's `AutomatonWallet` wraps a
// `WalletContractV5R1` + keyPair + mnemonic, feeding into `sendAndConfirm`'s
// seqno-polling path. In the sandbox we bypass seqno entirely by using a
// `SubmitExecuteFn` override that sends via `registry.sendExecute(treasury.getSender())`
// directly. The production code path is unit-tested in submit.spec.ts;
// here we exercise decide → contract-state → drain → metrics without
// reimplementing wallet signing in a test harness.

import {
    Blockchain,
    type SandboxContract,
    type TreasuryContract,
} from '@ton/sandbox';
import {
    Address,
    beginCell,
    type Cell,
    type Contract,
    type OpenedContract,
    type Transaction,
    toNano,
} from '@ton/core';
import type { KeyPair } from '@ton/crypto';
import type { WalletContractV5R1 } from '@ton/ton';
import {
    KronosRegistry,
    loadRegistryCode,
    REGISTRY_DEFAULTS,
} from '@titon-network/kronos-sdk';
import {
    ForgeTON,
    FORGETON_DEFAULTS,
    loadForgetonCode,
} from '@titon-network/forgeton-sdk';
import { Atlas, loadAtlasCode } from '@titon-network/atlas-sdk';
import { Fortuna, loadFortunaCode } from '@titon-network/fortuna-sdk';

import type { ChainRuntime } from '../chain';
import type { FailoverTonClient } from '../chain/ton-client';
import type { AutomatonWallet } from '../wallet';
import type { SubmitExecuteFn } from '../worker/loop';

const FAKE_ENDPOINT = 'https://sandbox.invalid/api/v2/jsonRPC';
const DEPLOY_VALUE = toNano('0.5');
const MIN_GAS = toNano('0.1');
// Stake + gas + sync fan-out to a single admitted consumer (the registry).
// Mirror `REGISTER_VALUE` from kronos/tests/Integration.spec.ts so amount
// semantics match the contract's enforcement.
const REGISTER_VALUE_KRONOS =
    FORGETON_DEFAULTS.minStake +
    FORGETON_DEFAULTS.minGasForRegister +
    FORGETON_DEFAULTS.syncGasCost;

// Same math but with three admitted consumers (kronos + atlas + fortuna),
// so AutomatonSync fans out to all three when an operator registers.
// If a fourth product is ever added to the playground, bump the
// multiplier here AND admit it as a consumer in the deploy block below;
// the contract's REGISTER_VALUE check is tight (rejects shortfall, no
// upper bound).
const REGISTER_VALUE_FULL =
    FORGETON_DEFAULTS.minStake +
    FORGETON_DEFAULTS.minGasForRegister +
    3n * FORGETON_DEFAULTS.syncGasCost;

export interface SandboxHarnessOpts {
    /**
     * When true, also deploy Atlas + Fortuna and admit them as ForgeTON
     * consumers BEFORE `registerAutomaton`, so AutomatonSync fans out to
     * all three on register. The harness then exposes `atlas`, `fortuna`,
     * and the three Fortuna helper methods (`registerBlsShare`,
     * `publishGroupKey`, `requestRandomness`).
     *
     * Default: false (Kronos-only, matches the integration test suite's
     * faster bootstrap).
     */
    withFortuna?: boolean;
}

export interface SandboxHarness {
    blockchain: Blockchain;
    owner: SandboxContract<TreasuryContract>;
    treasury: SandboxContract<TreasuryContract>;
    registry: SandboxContract<KronosRegistry>;
    pool: SandboxContract<ForgeTON>;
    /** Atlas — populated only when `createSandboxHarness({ withFortuna: true })`. */
    atlas?: SandboxContract<Atlas>;
    /** Fortuna — populated only when `createSandboxHarness({ withFortuna: true })`. */
    fortuna?: SandboxContract<Fortuna>;
    runtime: ChainRuntime;
    /**
     * Pool's REGISTER_VALUE — stake + gas + sync fan-out for one consumer.
     * Exported so scenarios can mint a well-funded treasury before calling
     * registerAutomaton.
     */
    registerValue: bigint;
    /** Register an automaton via the pool. Returns the treasury contract. */
    registerAutomaton(seed: string): Promise<SandboxContract<TreasuryContract>>;
    /** Register a test job via the registry; returns the jobId assigned. */
    registerJob(opts: {
        jobOwner: SandboxContract<TreasuryContract>;
        target: Address;
        message?: Cell;
        funding?: bigint;
        interval?: number;
        reward?: bigint;
        gasLimit?: bigint;
        maxExecutions?: number;
        windowBefore?: number;
        windowAfter?: number;
        expireAfter?: number;
    }): Promise<bigint>;
    /**
     * Build a minimal {@link AutomatonWallet} pointing at `treasury`. Only
     * `address` and `network` are used by the code paths exercised in
     * integration tests; the other fields are empty stubs so type-check
     * passes. Anyone calling `defaultSubmitExecute` against this would
     * crash — tests MUST pass `submitExecuteVia(treasury)` as the
     * `submitExecute` override.
     */
    fakeWalletFor(treasury: SandboxContract<TreasuryContract>): AutomatonWallet;
    /**
     * `SubmitExecuteFn` that sends Execute via `treasury.getSender()`,
     * bypassing wallet signing + seqno polling. Verifies the post-state
     * executionCount delta just like production — so a reverted Execute
     * still throws.
     */
    submitExecuteVia(
        treasury: SandboxContract<TreasuryContract>,
        options?: { valueOverride?: bigint },
    ): SubmitExecuteFn;
    /** Canonical empty-body message cell (`storeUint(0, 32)`). */
    noopMessage(): Cell;
    /**
     * Clock source aligned with `blockchain.now` — pass to `tickOnce.nowSec`
     * so the decide tree's window arithmetic matches simulated time instead
     * of falling back to wall-clock.
     */
    nowSec(): number;
    /** Advance `blockchain.now` by `seconds`. */
    advanceSeconds(seconds: number): void;

    // ===== Fortuna helpers — populated only when `withFortuna: true`. =====

    /**
     * Register a BLS pkShare for `operator` at Atlas. Operator must already
     * be active in Atlas's mirror (i.e. they registered at ForgeTON after
     * Atlas was admitted as a consumer). Atlas validates the pkShare is on
     * the G1 curve.
     */
    registerBlsShare?(opts: {
        operator: SandboxContract<TreasuryContract>;
        pkShare: Buffer;
        pkShareG2: Buffer;
    }): Promise<void>;

    /**
     * Owner publishes the initial group key at Atlas. Atlas fans out the
     * resulting `GroupKeySync` to every admitted verifier (i.e. Fortuna),
     * which caches `(groupPk, groupEpoch=1, threshold, memberCount)`.
     */
    publishGroupKey?(opts: {
        groupPk: Buffer;
        groupPkG2: Buffer;
        threshold: number;
        memberCount: number;
    }): Promise<void>;

    /**
     * Send a `RequestRandomness` to Fortuna from a treasury sender. Computes
     * the required value (baseRequestFee + submitterReward + callbackGas
     * + minForwardReserve + slack) from live Fortuna config so changes to
     * tunables don't break the playground.
     */
    requestRandomness?(opts: {
        consumer: SandboxContract<TreasuryContract>;
        queryId: bigint;
        seed: bigint;
        callbackGas?: bigint;
    }): Promise<void>;
}

/**
 * Create a fresh sandbox with ForgeTON + KronosRegistry deployed and wired.
 *
 * Default wiring (Kronos only):
 *   1. Blockchain.create() (fresh state)
 *   2. Deploy ForgeTON (owner)
 *   3. Deploy KronosRegistry (owner, treasury)
 *   4. registry.sendSetForgeton(pool.address)
 *   5. pool.sendSetConsumer(registry.address, isActive=true)
 *   6. blockchain.now = current wall-clock (seconds)
 *
 * With `{ withFortuna: true }` (full 3-product stack):
 *   7. Deploy Atlas (pointing at the same ForgeTON pool)
 *   8. Deploy Fortuna (pointing at ForgeTON + Atlas)
 *   9. pool.sendSetConsumer(atlas, true) + pool.sendSetConsumer(fortuna, true)
 *   10. atlas.sendSetVerifier(fortuna, true) — Atlas fans GroupKeySync into Fortuna
 *
 * In either mode, AutomatonSync fans out to every admitted consumer at
 * `registerAutomaton` time — `registerValue` is sized accordingly so the
 * full-stack mode covers 3 × `syncGasCost` instead of 1 ×.
 */
export async function createSandboxHarness(
    opts: SandboxHarnessOpts = {},
): Promise<SandboxHarness> {
    const blockchain = await Blockchain.create();
    const owner = await blockchain.treasury('owner');
    const treasury = await blockchain.treasury('treasury');

    const registry = blockchain.openContract(
        KronosRegistry.createFromConfig(
            { owner: owner.address, treasury: treasury.address },
            loadRegistryCode(),
        ),
    );
    await registry.sendDeploy(owner.getSender(), DEPLOY_VALUE);

    const pool = blockchain.openContract(
        ForgeTON.createFromConfig({ owner: owner.address }, loadForgetonCode()),
    );
    await pool.sendDeploy(owner.getSender(), DEPLOY_VALUE);

    await registry.sendSetForgeton(owner.getSender(), {
        value: MIN_GAS,
        forgeton: pool.address,
    });
    await pool.sendSetConsumer(owner.getSender(), {
        value: MIN_GAS,
        contract: registry.address,
        isActive: true,
    });

    let atlas: SandboxContract<Atlas> | undefined;
    let fortuna: SandboxContract<Fortuna> | undefined;
    if (opts.withFortuna === true) {
        atlas = blockchain.openContract(
            Atlas.createFromConfig(
                { owner: owner.address, forgeton: pool.address },
                loadAtlasCode(),
            ),
        );
        await atlas.sendDeploy(owner.getSender(), toNano('1'));

        fortuna = blockchain.openContract(
            Fortuna.createFromConfig(
                {
                    owner: owner.address,
                    forgeton: pool.address,
                    atlas: atlas.address,
                },
                loadFortunaCode(),
            ),
        );
        await fortuna.sendDeploy(owner.getSender(), toNano('1'));

        await pool.sendSetConsumer(owner.getSender(), {
            value: MIN_GAS,
            contract: atlas.address,
            isActive: true,
        });
        await pool.sendSetConsumer(owner.getSender(), {
            value: MIN_GAS,
            contract: fortuna.address,
            isActive: true,
        });
        await atlas.sendSetVerifier(owner.getSender(), {
            value: MIN_GAS,
            contract: fortuna.address,
            isActive: true,
        });
    }

    blockchain.now = Math.floor(Date.now() / 1000);

    const client = new SandboxTonClient(blockchain);
    const runtime: ChainRuntime = {
        client: client as unknown as FailoverTonClient,
        deployment: {
            pool: pool.address,
            products: {
                kronos: { registry: registry.address },
                ...(fortuna !== undefined && atlas !== undefined
                    ? { fortuna: { fortuna: fortuna.address, atlas: atlas.address } }
                    : {}),
            },
        },
        pool: pool as unknown as OpenedContract<ForgeTON>,
        products: {
            kronos: { registry: registry as unknown as OpenedContract<KronosRegistry> },
            ...(fortuna !== undefined && atlas !== undefined
                ? {
                      fortuna: {
                          fortuna: fortuna as unknown as OpenedContract<Fortuna>,
                          atlas: atlas as unknown as OpenedContract<Atlas>,
                      },
                  }
                : {}),
        },
    };

    const registerValue =
        opts.withFortuna === true ? REGISTER_VALUE_FULL : REGISTER_VALUE_KRONOS;

    const harness: SandboxHarness = {
        blockchain,
        owner,
        treasury,
        registry,
        pool,
        ...(atlas !== undefined ? { atlas } : {}),
        ...(fortuna !== undefined ? { fortuna } : {}),
        runtime,
        registerValue,
        async registerAutomaton(seed: string) {
            const t = await blockchain.treasury(seed);
            await pool.sendRegisterAutomaton(t.getSender(), { value: registerValue });
            return t;
        },
        async registerJob(opts) {
            await registry.sendRegisterJob(opts.jobOwner.getSender(), {
                value: opts.funding ?? toNano('2'),
                target: opts.target,
                message: opts.message ?? noopMessageCell(),
                interval: opts.interval ?? 300,
                reward: opts.reward ?? REGISTRY_DEFAULTS.minReward,
                gasLimit: opts.gasLimit ?? toNano('0.02'),
                maxExecutions: opts.maxExecutions ?? 0,
                windowBefore: opts.windowBefore ?? 10,
                windowAfter: opts.windowAfter ?? 600,
                expireAfter: opts.expireAfter ?? 0,
            });
            return (await registry.getJobCount()) - 1n;
        },
        fakeWalletFor(t) {
            return {
                address: t.address,
                mnemonic: [],
                keyPair: {
                    publicKey: Buffer.alloc(0),
                    secretKey: Buffer.alloc(0),
                } as KeyPair,
                walletContract: {} as WalletContractV5R1,
                network: 'testnet',
            };
        },
        submitExecuteVia(t, options) {
            return async (deps, config, jobId, preExecutionCount) => {
                const value = options?.valueOverride ?? config.minGasReserve;
                await deps.registry.sendExecute(t.getSender(), { value, jobId });
                const post = await deps.registry.getJob(jobId);
                if (post === null) {
                    throw new Error(
                        `job ${jobId} vanished post-execute — likely cancelled or swept`,
                    );
                }
                if (post.executionCount <= preExecutionCount) {
                    throw new Error(
                        `executionCount did not advance (pre=${preExecutionCount}, ` +
                            `post=${post.executionCount}) — Execute reverted`,
                    );
                }
            };
        },
        noopMessage: () => noopMessageCell(),
        nowSec() {
            return blockchain.now ?? Math.floor(Date.now() / 1000);
        },
        advanceSeconds(seconds: number) {
            blockchain.now = (blockchain.now ?? Math.floor(Date.now() / 1000)) + seconds;
        },
    };

    if (atlas !== undefined && fortuna !== undefined) {
        const atlasContract = atlas;
        const fortunaContract = fortuna;
        harness.registerBlsShare = async ({ operator, pkShare, pkShareG2 }) => {
            await atlasContract.sendRegisterBlsShare(operator.getSender(), {
                value: toNano('0.05'),
                pkShare,
                pkShareG2,
            });
        };
        harness.publishGroupKey = async ({ groupPk, groupPkG2, threshold, memberCount }) => {
            await atlasContract.sendPublishGroupKey(owner.getSender(), {
                value: toNano('0.1'),
                groupPk,
                groupPkG2,
                threshold,
                memberCount,
            });
        };
        harness.requestRandomness = async ({ consumer, queryId, seed, callbackGas }) => {
            const cfg = await fortunaContract.getConfig();
            const cb = callbackGas ?? toNano('0.05');
            const value =
                cfg.baseRequestFee +
                cfg.submitterReward +
                cb +
                cfg.minForwardReserve +
                toNano('0.05'); // slack for forward-fee variation
            await fortunaContract.sendRequestRandomness(consumer.getSender(), {
                value,
                queryId,
                seed,
                callbackGas: cb,
            });
        };
    }

    return harness;
}

/**
 * Adapter over `Blockchain` that quacks like `FailoverTonClient` for the
 * methods production actually calls through `client.call(fn)` — namely
 * `getTransactions`, `getBalance`, `getMasterchainInfo`. `.open` delegates
 * to `blockchain.openContract()`. Cast to `FailoverTonClient` at the
 * construction site: runtime shape is identical for the production paths
 * we exercise.
 */
class SandboxTonClient {
    readonly network = 'testnet' as const;
    readonly currentEndpoint = FAKE_ENDPOINT;

    constructor(private readonly blockchain: Blockchain) {}

    listEndpoints(): readonly string[] {
        return [FAKE_ENDPOINT];
    }

    async call<T>(fn: (client: FakeTonClient) => Promise<T>): Promise<T> {
        return fn(this.facade());
    }

    open<T extends Contract>(contract: T): OpenedContract<T> {
        return this.blockchain.openContract(contract) as unknown as OpenedContract<T>;
    }

    private facade(): FakeTonClient {
        const bc = this.blockchain;
        return {
            getTransactions: async (
                address: Address,
                opts: { limit: number; lt?: string; hash?: string },
            ): Promise<Transaction[]> => {
                // @ton/sandbox@0.41's getTransactions has THREE incompatibilities
                // with toncenter's semantics:
                //   (1) hash: string is interpreted as hex, but production
                //       encodes as base64 (bigintHashToBase64).
                //   (2) lt+hash lookup uses reference equality on tx.hash()
                //       and the input Buffer — always false even with
                //       matching bytes.
                //   (3) `this.transactions.reverse()` mutates the master
                //       array in place, so ordering FLIPS between successive
                //       calls (first: descending, second: ascending, …).
                // We bypass sandbox's lookup: fetch all, sort by lt
                // descending ourselves, filter by the cursor, then slice.
                //
                // Re-test on @ton/sandbox upgrade: if all three are fixed
                // upstream this whole branch collapses to `bc.getTransactions(
                // address, opts)`.
                const all = await bc.getTransactions(address, {});
                const sorted = all
                    .slice()
                    .sort((a, b) => (a.lt < b.lt ? 1 : a.lt > b.lt ? -1 : 0));
                const filtered =
                    opts.lt !== undefined
                        ? sorted.filter((tx) => tx.lt <= BigInt(opts.lt!))
                        : sorted;
                return filtered.slice(0, opts.limit) as Transaction[];
            },
            getBalance: async (address: Address): Promise<bigint> => {
                const c = await bc.getContract(address);
                return c.balance;
            },
            getMasterchainInfo: async (): Promise<{ latestSeqno: number }> => {
                // Sandbox has no masterchain; a plausible-shaped response
                // is enough for doctor's reachability probe.
                return { latestSeqno: 0 };
            },
        };
    }
}

interface FakeTonClient {
    getTransactions(
        address: Address,
        opts: { limit: number; lt?: string; hash?: string },
    ): Promise<Transaction[]>;
    getBalance(address: Address): Promise<bigint>;
    getMasterchainInfo(): Promise<{ latestSeqno: number }>;
}

function noopMessageCell(): Cell {
    // Matches kronos/tests/Integration.spec.ts noopMessage: opcode 0 + nothing.
    return beginCell().storeUint(0, 32).endCell();
}
