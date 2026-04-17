// Sandbox integration harness.
//
// Bootstraps an isolated Blockchain with both ForgeTON + KronosRegistry
// deployed and wired (SetForgeton + SetConsumer). Returns a bundle that
// conforms to `ChainRuntime` so production code paths (`drainEvents`,
// `runWorkerCycle`, `tickOnce`) run unchanged against the sandbox.
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
} from 'kronos-sdk';
import {
    ForgeTON,
    FORGETON_DEFAULTS,
    loadForgetonCode,
} from 'forgeton-sdk';
import '@ton/test-utils';

import type { ChainRuntime } from '../../src/chain';
import type { FailoverTonClient } from '../../src/chain/ton-client';
import type { AutomatonWallet } from '../../src/wallet';
import type { SubmitExecuteFn } from '../../src/worker/loop';

const FAKE_ENDPOINT = 'https://sandbox.invalid/api/v2/jsonRPC';
const DEPLOY_VALUE = toNano('0.5');
const MIN_GAS = toNano('0.1');
// Stake + gas + sync fan-out to a single admitted consumer (the registry).
// Mirror `REGISTER_VALUE` from kronos/tests/Integration.spec.ts so amount
// semantics match the contract's enforcement.
const REGISTER_VALUE =
    FORGETON_DEFAULTS.minStake +
    FORGETON_DEFAULTS.minGasForRegister +
    FORGETON_DEFAULTS.syncGasCost;

export interface SandboxHarness {
    blockchain: Blockchain;
    owner: SandboxContract<TreasuryContract>;
    treasury: SandboxContract<TreasuryContract>;
    registry: SandboxContract<KronosRegistry>;
    pool: SandboxContract<ForgeTON>;
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
}

/**
 * Create a fresh sandbox with registry + pool deployed and wired.
 *
 * Default wiring:
 *   1. Blockchain.create() (fresh state)
 *   2. Deploy ForgeTON (owner)
 *   3. Deploy KronosRegistry (owner, treasury)
 *   4. registry.sendSetForgeton(pool.address)
 *   5. pool.sendSetConsumer(registry.address, isActive=true)
 *   6. blockchain.now = current wall-clock (seconds)
 */
export async function createSandboxHarness(): Promise<SandboxHarness> {
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

    blockchain.now = Math.floor(Date.now() / 1000);

    const client = new SandboxTonClient(blockchain);
    const runtime: ChainRuntime = {
        client: client as unknown as FailoverTonClient,
        deployment: { registry: registry.address, pool: pool.address },
        registry: registry as unknown as OpenedContract<KronosRegistry>,
        pool: pool as unknown as OpenedContract<ForgeTON>,
    };

    return {
        blockchain,
        owner,
        treasury,
        registry,
        pool,
        runtime,
        registerValue: REGISTER_VALUE,
        async registerAutomaton(seed: string) {
            const t = await blockchain.treasury(seed);
            await pool.sendRegisterAutomaton(t.getSender(), { value: REGISTER_VALUE });
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
                await deps.runtime.registry.sendExecute(t.getSender(), { value, jobId });
                const post = await deps.runtime.registry.getJob(jobId);
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
