// Pool message-value calculators: register / increase / request-unstake /
// cancel-unstake / finalize-unstake. Each mirrors an on-chain floor in
// ForgeTON's handlers. Also covers willCrossInactive's drop-below-minStake
// boundary detection.

import { toNano } from '@ton/core';
import type { ForgetonConfigReply } from 'forgeton-sdk';
import {
    cancelUnstakeValue,
    finalizeUnstakeValue,
    increaseStakeValue,
    registerValue,
    requestUnstakeValue,
    willCrossInactive,
    type PoolContext,
} from '../src/chain/stake-cost';

const poolCfg: ForgetonConfigReply = {
    minStake: toNano('10'),
    slashAmount: toNano('0.5'),
    unstakeCooldown: 86_400,
    syncGasCost: toNano('0.02'),
    minStorageReserve: toNano('0.1'),
    minGasForRegister: toNano('0.05'),
    minGasForUnstake: toNano('0.05'),
};

function ctxWith(consumerCount: number): PoolContext {
    return { config: poolCfg, consumerCount };
}

describe('registerValue', () => {
    it('returns stake + minGas + consumerCount × syncGas when consumers = 1', () => {
        const value = registerValue(ctxWith(1), toNano('10'));
        // 10 + 0.05 + 1 * 0.02 = 10.07
        expect(value).toBe(toNano('10.07'));
    });

    it('scales the fan-out portion with consumer count', () => {
        const one = registerValue(ctxWith(1), toNano('10'));
        const ten = registerValue(ctxWith(10), toNano('10'));
        // Delta is exactly 9 × syncGasCost = 9 × 0.02 = 0.18 TON
        expect(ten - one).toBe(toNano('0.18'));
    });

    it('accepts zero consumers (pool pre-admission)', () => {
        const value = registerValue(ctxWith(0), toNano('10'));
        expect(value).toBe(toNano('10.05'));
    });

    it('rejects a stake below the pool minimum', () => {
        expect(() => registerValue(ctxWith(1), toNano('9'))).toThrow(/pool\.minStake/);
    });
});

describe('increaseStakeValue', () => {
    it('returns the delta unchanged — wallet pays tx gas separately', () => {
        expect(increaseStakeValue(toNano('5'))).toBe(toNano('5'));
    });

    it('rejects zero', () => {
        expect(() => increaseStakeValue(0n)).toThrow(/must be > 0/);
    });

    it('rejects negative', () => {
        expect(() => increaseStakeValue(-1n)).toThrow(/must be > 0/);
    });
});

describe('requestUnstakeValue', () => {
    it('returns minGasForUnstake (the pool does not require more)', () => {
        expect(requestUnstakeValue(ctxWith(1))).toBe(poolCfg.minGasForUnstake);
    });
});

describe('finalizeUnstakeValue', () => {
    it('returns minGasForUnstake when the withdrawal stays active', () => {
        expect(finalizeUnstakeValue(ctxWith(5), false)).toBe(poolCfg.minGasForUnstake);
    });

    it('adds fan-out gas when the withdrawal crosses to inactive', () => {
        const inactive = finalizeUnstakeValue(ctxWith(5), true);
        const active = finalizeUnstakeValue(ctxWith(5), false);
        expect(inactive - active).toBe(5n * poolCfg.syncGasCost);
    });
});

describe('cancelUnstakeValue', () => {
    it('returns minGasForUnstake', () => {
        expect(cancelUnstakeValue(ctxWith(1))).toBe(poolCfg.minGasForUnstake);
    });
});

describe('willCrossInactive', () => {
    it('true when remaining < minStake', () => {
        expect(willCrossInactive(ctxWith(1), toNano('10'), toNano('5'))).toBe(true);
    });

    it('false when remaining >= minStake', () => {
        expect(willCrossInactive(ctxWith(1), toNano('20'), toNano('5'))).toBe(false);
    });

    it('true when withdrawing the full stake', () => {
        expect(willCrossInactive(ctxWith(1), toNano('10'), toNano('10'))).toBe(true);
    });
});
