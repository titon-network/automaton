// Gas calculators for ForgeTON stake lifecycle messages.
//
// Each helper takes the pool's on-chain config + consumer count and
// returns the `value` (in nanoton) that the corresponding `send*` call
// must attach. The pool enforces these floors on-chain; we pre-compute
// them off-chain so the CLI can (a) refuse early with a helpful error
// when a request would obviously fail, and (b) attach just enough
// value instead of over-paying.
//
// Source-of-truth for the formulas: forgeton/contracts/forgeton.tolk,
// handleRegisterAutomaton / handleIncreaseStake / handleRequestUnstake /
// handleUnstake / handleCancelUnstake.

import type { ForgetonConfigReply } from 'forgeton-sdk';

export interface PoolContext {
    config: ForgetonConfigReply;
    consumerCount: number;
}

function fanoutGas(ctx: PoolContext): bigint {
    return BigInt(ctx.consumerCount) * ctx.config.syncGasCost;
}

/**
 * Register a new automaton with `stake` nanoton of collateral. The pool
 * computes `actualStake = value - minGasForRegister - fanout`; we invert
 * that so the operator's intended stake amount lands on-chain intact.
 */
export function registerValue(ctx: PoolContext, stake: bigint): bigint {
    if (stake < ctx.config.minStake) {
        throw new Error(
            `requested stake ${stake} < pool.minStake ${ctx.config.minStake}. ` +
                `The pool would reject the register message.`,
        );
    }
    return stake + ctx.config.minGasForRegister + fanoutGas(ctx);
}

/**
 * Top up an already-registered automaton by `delta` nanoton. The wallet
 * pays tx gas separately (sendMode=PAY_GAS_SEPARATELY), so `msgValue`
 * arrives intact at the pool and becomes the full stake increment.
 */
export function increaseStakeValue(delta: bigint): bigint {
    if (delta <= 0n) {
        throw new Error(`stake increase amount must be > 0, got ${delta}`);
    }
    return delta;
}

/**
 * Start the unstake timer. Pool ignores msgValue (no on-chain floor
 * beyond the contract storage reserve), but the wallet still needs
 * enough TON attached for the inbound message to land. Use the
 * pool's published minGasForUnstake as a conservative floor.
 */
export function requestUnstakeValue(ctx: PoolContext): bigint {
    return ctx.config.minGasForUnstake;
}

/**
 * Finalize an unstake after the cooldown. Pool requires
 * `msgValue >= minGasForUnstake + (willCrossInactive ? fanoutGas : 0)`.
 * Callers pass `willCrossInactive = true` when the post-withdrawal
 * stake would drop below `minStake` (the pool then fires pushSync
 * to every consumer, which is what the fan-out gas covers).
 */
export function finalizeUnstakeValue(ctx: PoolContext, willCrossInactive: boolean): bigint {
    const base = ctx.config.minGasForUnstake;
    return willCrossInactive ? base + fanoutGas(ctx) : base;
}

/** Cancel a pending unstake. No pool-side floor; conservative gas only. */
export function cancelUnstakeValue(ctx: PoolContext): bigint {
    return ctx.config.minGasForUnstake;
}

/**
 * Given a current stake and an unstake `amount`, does the withdrawal
 * cross the active→inactive threshold (post-stake < minStake)?
 * Used to size the finalize-unstake gas.
 */
export function willCrossInactive(
    ctx: PoolContext,
    currentStake: bigint,
    withdrawAmount: bigint,
): boolean {
    const remaining = currentStake - withdrawAmount;
    return remaining < ctx.config.minStake;
}
