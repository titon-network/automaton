// sendAndConfirm seams: waitForSeqnoAdvance poll + timeout paths,
// pickWalletTx attribution against mixed tx batches, explorer URL
// rendering for mainnet/testnet.

import { Address } from '@ton/core';
import type { Transaction } from '@ton/core';
import {
    ConfirmationTimeoutError,
    explorerAddressUrl,
    explorerTxUrl,
    pickWalletTx,
    waitForSeqnoAdvance,
} from '../src/chain/submit';

const ADDR = Address.parse('0QC52I0pIiF_041o-njvpvjc3UzrnzhMCW3T41IoVhllyHhA');

function fakeNow(initial: number) {
    let time = initial;
    return {
        now: () => time,
        advance: (ms: number) => {
            time += ms;
        },
    };
}

describe('waitForSeqnoAdvance', () => {
    it('returns the new seqno as soon as it advances', async () => {
        let seqno = 5;
        let polls = 0;
        const sleeps: number[] = [];

        const result = await waitForSeqnoAdvance(
            async () => {
                polls++;
                if (polls === 2) seqno = 6;
                return seqno;
            },
            5,
            {
                address: ADDR,
                timeoutMs: 10_000,
                pollIntervalMs: 1_000,
                sleep: async (ms) => {
                    sleeps.push(ms);
                },
                now: () => 0,
            },
        );

        expect(result).toBe(6);
        expect(polls).toBe(2);
        expect(sleeps).toEqual([1_000, 1_000]);
    });

    it('throws ConfirmationTimeoutError when the seqno never advances', async () => {
        const clock = fakeNow(0);
        const probe = waitForSeqnoAdvance(
            async () => 5,
            5,
            {
                address: ADDR,
                timeoutMs: 5_000,
                pollIntervalMs: 1_000,
                sleep: async () => {
                    clock.advance(1_000);
                },
                now: clock.now,
            },
        );

        await expect(probe).rejects.toBeInstanceOf(ConfirmationTimeoutError);
    });

    it('timeout error carries address, seqnoBefore, and waited time', async () => {
        const clock = fakeNow(0);
        try {
            await waitForSeqnoAdvance(
                async () => 42,
                42,
                {
                    address: ADDR,
                    timeoutMs: 3_000,
                    pollIntervalMs: 1_000,
                    sleep: async () => {
                        clock.advance(1_000);
                    },
                    now: clock.now,
                },
            );
            fail('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(ConfirmationTimeoutError);
            const timeout = err as ConfirmationTimeoutError;
            expect(timeout.address.equals(ADDR)).toBe(true);
            expect(timeout.seqnoBefore).toBe(42);
            expect(timeout.waitedMs).toBeGreaterThanOrEqual(3_000);
        }
    });

    it('succeeds at the last possible poll before timeout', async () => {
        const clock = fakeNow(0);
        let seqno = 10;
        let polls = 0;

        const result = await waitForSeqnoAdvance(
            async () => {
                polls++;
                if (polls === 3) seqno = 11;
                return seqno;
            },
            10,
            {
                address: ADDR,
                timeoutMs: 5_000,
                pollIntervalMs: 1_500,
                sleep: async (ms) => {
                    clock.advance(ms);
                },
                now: clock.now,
            },
        );

        expect(result).toBe(11);
        expect(polls).toBe(3);
    });

    it('reads seqno every poll (no skipped reads)', async () => {
        const seen: number[] = [];
        const clock = fakeNow(0);

        const probe = waitForSeqnoAdvance(
            async () => {
                seen.push(clock.now());
                return 1;
            },
            1,
            {
                address: ADDR,
                timeoutMs: 4_000,
                pollIntervalMs: 1_000,
                sleep: async (ms) => {
                    clock.advance(ms);
                },
                now: clock.now,
            },
        );

        await expect(probe).rejects.toBeInstanceOf(ConfirmationTimeoutError);
        expect(seen).toEqual([1_000, 2_000, 3_000, 4_000]);
    });
});

describe('pickWalletTx', () => {
    // Helper: fabricate a minimal Transaction shape; we only exercise the
    // fields pickWalletTx actually reads.
    function fakeTx(lt: bigint, info: 'external-in' | 'internal'): Transaction {
        return {
            lt,
            inMessage:
                info === 'external-in'
                    ? { info: { type: 'external-in' } }
                    : { info: { type: 'internal' } },
        } as unknown as Transaction;
    }

    it('returns the first external-in tx newer than the baseline', () => {
        const txs = [
            fakeTx(500n, 'external-in'), // newest — our wallet tx
            fakeTx(400n, 'internal'), // incoming transfer AFTER our send
            fakeTx(300n, 'external-in'), // older wallet tx (pre-baseline)
        ];
        const picked = pickWalletTx(txs, 350n);
        expect(picked).not.toBeNull();
        expect(picked!.lt).toBe(500n);
    });

    it('ignores internal inMessages (incoming transfers)', () => {
        const txs = [fakeTx(500n, 'internal'), fakeTx(400n, 'external-in')];
        const picked = pickWalletTx(txs, 350n);
        expect(picked!.lt).toBe(400n);
    });

    it('returns null when no tx is newer than the baseline', () => {
        const txs = [fakeTx(300n, 'external-in'), fakeTx(200n, 'external-in')];
        expect(pickWalletTx(txs, 500n)).toBeNull();
    });

    it('returns null when only internal txs are newer than baseline', () => {
        const txs = [fakeTx(500n, 'internal'), fakeTx(400n, 'internal')];
        expect(pickWalletTx(txs, 300n)).toBeNull();
    });

    it('treats baselineLt=0n as "no prior tx" and accepts any external-in', () => {
        const txs = [fakeTx(100n, 'external-in')];
        expect(pickWalletTx(txs, 0n)!.lt).toBe(100n);
    });
});

describe('explorer URL builders', () => {
    it('mainnet transaction URL uses tonviewer.com', () => {
        expect(explorerTxUrl('mainnet', 'abcdef')).toBe(
            'https://tonviewer.com/transaction/abcdef',
        );
    });

    it('testnet transaction URL uses testnet.tonviewer.com', () => {
        expect(explorerTxUrl('testnet', 'abcdef')).toBe(
            'https://testnet.tonviewer.com/transaction/abcdef',
        );
    });

    it('address URLs omit the /transaction/ segment', () => {
        expect(explorerAddressUrl('testnet', ADDR)).toBe(
            `https://testnet.tonviewer.com/${ADDR.toString()}`,
        );
    });
});
