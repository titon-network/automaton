// `automaton stake ...` — ForgeTON stake lifecycle.
//
// Subcommands:
//   register         — first-time registration with initial collateral
//   increase         — top up an already-registered automaton
//   request-unstake  — start the cooldown timer (stake remains locked)
//   cancel-unstake   — abort a pending request and stay active
//   withdraw         — finalize after cooldown; returns full stake
//
// Every command follows the same flow: load config + keystore, prompt
// for the wallet password, read the pool's current config + consumer
// count + this automaton's state, compute the exact `value` the pool
// will accept, refuse early if the pre-state is wrong (e.g. "already
// registered"), send, wait for seqno advance, then verify that the pool
// actually applied the expected state change (not just that the wallet
// signed — see submit.ts top-of-file on why seqno-advance is insufficient).
//
// Password handling defers to `src/wallet/prompt.ts`, which honours
// AUTOMATON_PASSWORD for Docker / systemd paths. We do NOT re-prompt
// on transient chain errors — FailoverTonClient retries internally.
// Subcommands re-auth independently; batching txs through one session
// is intentionally not supported.

import { toNano, fromNano, type OpenedContract, type Sender } from '@ton/core';
import type { AutomatonInfo, ForgeTON } from '@titon-network/forgeton-sdk';
import { Command } from 'commander';
import { loadConfig } from '../../config';
import type { Config } from '../../config/schema';
import { getPassword, loadKeystore, unlockKeystore } from '../../wallet';
import type { AutomatonWallet } from '../../wallet';
import {
    buildChainRuntime,
    cancelUnstakeValue,
    finalizeUnstakeValue,
    increaseStakeValue,
    registerValue,
    requestUnstakeValue,
    sendAndConfirm,
    senderFor,
    willCrossInactive,
    type ChainRuntime,
    type PoolContext,
} from '../../chain';

// Buffer above the pool-side `value` floor so the wallet can still cover
// its own seqno-bump tx gas without driving balance into the dust zone.
// 0.1 TON is roughly 2× the observed worst case (fwd + compute + rent)
// on testnet — intentional headroom since this is one-shot UX, not a
// hot path.
const WALLET_GAS_BUFFER = toNano('0.1');

// Stake pre-state errors use plain `Error` — the CLI top-level catch
// surfaces `err.message` verbatim, and no code elsewhere differentiates
// "already registered" from "not registered" programmatically (every
// check happens in this file's `require*` predicates). Typed error
// classes across the module boundary earn their keep only for errors
// the daemon needs to `instanceof`-classify (PoolRejectedError,
// ConfirmationTimeoutError, TxAttributionError, AllEndpointsFailedError,
// LockHeldError, DeploymentNotAvailableError, SchemaMismatchError).

interface StakeContext {
    config: Config;
    runtime: ChainRuntime;
    wallet: AutomatonWallet;
    poolCtx: PoolContext;
    automaton: AutomatonInfo | null;
}

async function loadContext(): Promise<StakeContext> {
    const config = loadConfig();
    const keystore = loadKeystore();
    const runtime = buildChainRuntime(config);
    const password = await getPassword({ prompt: 'Keystore password: ' });
    const wallet = await unlockKeystore(keystore, password);

    const [poolCfg, consumerCount, automaton] = await Promise.all([
        runtime.pool.getConfig(),
        runtime.pool.getConsumerCount(),
        runtime.pool.getAutomaton(wallet.address),
    ]);

    return {
        config,
        runtime,
        wallet,
        poolCtx: { config: poolCfg, consumerCount },
        automaton,
    };
}

// Pre-state predicates — narrow the `automaton` type so callers don't
// need `!` assertions after these return. Any daemon-side retry code
// should use the same helpers for a consistent error surface.

function requireRegistered(ctx: StakeContext, what: string): AutomatonInfo {
    if (ctx.automaton === null) {
        throw new Error(
            `not registered — nothing to ${what}. Run \`automaton stake register <amount>\` first.`,
        );
    }
    return ctx.automaton;
}

function requireNoPendingUnstake(info: AutomatonInfo, ctx: StakeContext): void {
    if (info.unstakeRequestedAt !== 0) {
        const availableAt = info.unstakeRequestedAt + ctx.poolCtx.config.unstakeCooldown;
        const iso = new Date(availableAt * 1000).toISOString();
        throw new Error(
            `unstake is already pending (available at ${iso}). ` +
                `Run \`automaton stake withdraw\` once the cooldown elapses, or ` +
                `\`automaton stake cancel-unstake\` to abort.`,
        );
    }
}

function requirePendingUnstake(info: AutomatonInfo): void {
    if (info.unstakeRequestedAt === 0) {
        throw new Error('no pending unstake.');
    }
}

async function assertWalletFunded(ctx: StakeContext, value: bigint): Promise<void> {
    const required = value + WALLET_GAS_BUFFER;
    const balance = await ctx.runtime.client.getBalance(ctx.wallet.address);
    if (balance < required) {
        const addr = ctx.wallet.address.toString({
            bounceable: false,
            testOnly: ctx.config.network === 'testnet',
        });
        throw new Error(
            `wallet balance ${fromNano(balance)} TON is below required ${fromNano(required)} TON. ` +
                `Fund ${addr} first.`,
        );
    }
}

async function submit(
    ctx: StakeContext,
    label: string,
    attachedValue: bigint,
    send: (pool: OpenedContract<ForgeTON>, sender: Sender) => Promise<void>,
    verify: () => Promise<void>,
): Promise<void> {
    process.stdout.write(`  Submitting ${label} (value=${fromNano(attachedValue)} TON)...\n`);
    const sender = senderFor(ctx.runtime.client, ctx.wallet);
    const result = await sendAndConfirm(
        ctx.runtime.client,
        ctx.wallet,
        () => send(ctx.runtime.pool, sender),
        { verify, origin: 'forgeton' },
    );
    process.stdout.write(
        `  Verified (seqno ${result.seqnoBefore} → ${result.seqnoAfter}, pool state updated).\n` +
            `  Tx:   ${result.txHash}\n` +
            `  View: ${result.explorerUrl}\n`,
    );
}

async function handleRegister(amountTon: string): Promise<void> {
    const ctx = await loadContext();
    if (ctx.automaton !== null) {
        throw new Error(
            `already registered (stake=${fromNano(ctx.automaton.stake)} TON, ` +
                `active=${ctx.automaton.isActive}). Use \`automaton stake increase <amount>\` instead.`,
        );
    }

    const stake = toNano(amountTon);
    const value = registerValue(ctx.poolCtx, stake);
    await assertWalletFunded(ctx, value);

    await submit(
        ctx,
        'register',
        value,
        (pool, sender) => pool.sendRegisterAutomaton(sender, { value }),
        async () => {
            const post = await ctx.runtime.pool.getAutomaton(ctx.wallet.address);
            if (post === null || !post.isActive) {
                throw new Error('pool.getAutomaton(me) did not return an active record');
            }
        },
    );
}

async function handleIncrease(amountTon: string): Promise<void> {
    const ctx = await loadContext();
    const info = requireRegistered(ctx, 'top up');
    if (!info.isActive) {
        throw new Error(
            'automaton is inactive; pool rejects IncreaseStake on inactive slots.',
        );
    }
    requireNoPendingUnstake(info, ctx);

    const delta = toNano(amountTon);
    const value = increaseStakeValue(delta);
    const stakeBefore = info.stake;
    await assertWalletFunded(ctx, value);

    await submit(
        ctx,
        `stake increase (+${amountTon} TON)`,
        value,
        (pool, sender) => pool.sendIncreaseStake(sender, { value }),
        async () => {
            const post = await ctx.runtime.pool.getAutomaton(ctx.wallet.address);
            if (post === null) throw new Error('pool.getAutomaton(me) returned null post-increase');
            if (post.stake <= stakeBefore) {
                throw new Error(
                    `stake did not grow: before=${stakeBefore}, after=${post.stake}`,
                );
            }
        },
    );
}

async function handleRequestUnstake(): Promise<void> {
    const ctx = await loadContext();
    const info = requireRegistered(ctx, 'unstake');
    requireNoPendingUnstake(info, ctx);

    const value = requestUnstakeValue(ctx.poolCtx);
    await assertWalletFunded(ctx, value);

    await submit(
        ctx,
        'request-unstake',
        value,
        (pool, sender) => pool.sendRequestUnstake(sender, { value }),
        async () => {
            const post = await ctx.runtime.pool.getAutomaton(ctx.wallet.address);
            if (post === null) throw new Error('pool.getAutomaton(me) returned null post-request');
            if (post.unstakeRequestedAt === 0) {
                throw new Error('unstakeRequestedAt still 0 after request-unstake');
            }
        },
    );

    const availableAt = Math.floor(Date.now() / 1000) + ctx.poolCtx.config.unstakeCooldown;
    process.stdout.write(
        `  Cooldown: ${ctx.poolCtx.config.unstakeCooldown}s — available at ` +
            `${new Date(availableAt * 1000).toISOString()}.\n` +
            `  After that, run: automaton stake withdraw\n`,
    );
}

async function handleCancelUnstake(): Promise<void> {
    const ctx = await loadContext();
    const info = requireRegistered(ctx, 'cancel unstake');
    requirePendingUnstake(info);

    const value = cancelUnstakeValue(ctx.poolCtx);
    await assertWalletFunded(ctx, value);

    await submit(
        ctx,
        'cancel-unstake',
        value,
        (pool, sender) => pool.sendCancelUnstake(sender, { value }),
        async () => {
            const post = await ctx.runtime.pool.getAutomaton(ctx.wallet.address);
            if (post === null) throw new Error('pool.getAutomaton(me) returned null post-cancel');
            if (post.unstakeRequestedAt !== 0) {
                throw new Error('unstakeRequestedAt still non-zero after cancel');
            }
        },
    );
}

async function handleWithdraw(): Promise<void> {
    const ctx = await loadContext();
    const info = requireRegistered(ctx, 'withdraw');
    requirePendingUnstake(info);

    const availableAt = info.unstakeRequestedAt + ctx.poolCtx.config.unstakeCooldown;
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec < availableAt) {
        const iso = new Date(availableAt * 1000).toISOString();
        throw new Error(
            `cooldown not elapsed — stake available at ${iso} ` +
                `(${availableAt - nowSec}s remaining).`,
        );
    }

    const amount = info.stake;
    const crossesInactive = willCrossInactive(ctx.poolCtx, info.stake, amount);
    const value = finalizeUnstakeValue(ctx.poolCtx, crossesInactive);
    await assertWalletFunded(ctx, value);

    await submit(
        ctx,
        `withdraw ${fromNano(amount)} TON`,
        value,
        (pool, sender) => pool.sendUnstake(sender, { value, amount }),
        async () => {
            // Full-stake withdraw: the pool removes the record entirely.
            const post = await ctx.runtime.pool.getAutomaton(ctx.wallet.address);
            if (post !== null && post.stake > 0n) {
                throw new Error(
                    `stake still ${post.stake} post-withdraw (expected record removed or zero)`,
                );
            }
        },
    );
}

export function registerStakeCommand(program: Command): void {
    const stake = program
        .command('stake')
        .description('ForgeTON stake lifecycle — register, increase, request-unstake, cancel, withdraw.');

    stake
        .command('register <amount>')
        .description('Register + stake <amount> TON for the first time.')
        .action(async (amount: string) => {
            await handleRegister(amount);
        });

    stake
        .command('increase <amount>')
        .description('Add <amount> TON more stake to an already-registered automaton.')
        .action(async (amount: string) => {
            await handleIncrease(amount);
        });

    stake
        .command('request-unstake')
        .description('Start the unstake cooldown. Stake remains locked until `withdraw`.')
        .action(async () => {
            await handleRequestUnstake();
        });

    stake
        .command('cancel-unstake')
        .description('Abort a pending unstake and resume as active.')
        .action(async () => {
            await handleCancelUnstake();
        });

    stake
        .command('withdraw')
        .description('Withdraw the full stake after the unstake cooldown has elapsed.')
        .action(async () => {
            await handleWithdraw();
        });
}
