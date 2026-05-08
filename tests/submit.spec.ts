// sendAndConfirm seams: waitForSeqnoAdvance poll + timeout paths,
// pickWalletTx attribution against mixed tx batches, explorer URL
// rendering for mainnet/testnet, plus a stubbed-client end-to-end of
// `sendAndConfirm` covering happy / verify-throws / no-tx paths and
// the typed-error constructors.

import { Address } from '@ton/core';
import type { Transaction } from '@ton/core';
import {
    ConfirmationTimeoutError,
    PoolRejectedError,
    TxAttributionError,
    explorerAddressUrl,
    explorerTxUrl,
    pickWalletTx,
    sendAndConfirm,
    waitForSeqnoAdvance,
} from '../src/chain/submit';
import type { AutomatonWallet } from '../src/wallet';
import type { FailoverTonClient } from '../src/chain/ton-client';

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
    // 64 hex chars — the shape Buffer.toString('hex') on tx.hash() emits.
    const HASH = 'a'.repeat(64);

    it('mainnet transaction URL uses tonviewer.com', () => {
        expect(explorerTxUrl('mainnet', HASH)).toBe(
            `https://tonviewer.com/transaction/${HASH}`,
        );
    });

    it('testnet transaction URL uses testnet.tonviewer.com', () => {
        expect(explorerTxUrl('testnet', HASH)).toBe(
            `https://testnet.tonviewer.com/transaction/${HASH}`,
        );
    });

    it('rejects malformed tx hashes (not 64 hex chars)', () => {
        expect(() => explorerTxUrl('testnet', 'abcdef')).toThrow(/64 hex chars/);
        expect(() => explorerTxUrl('testnet', '../admin')).toThrow(/64 hex chars/);
        expect(() => explorerTxUrl('testnet', 'g'.repeat(64))).toThrow(/64 hex chars/);
    });

    it('address URLs omit the /transaction/ segment', () => {
        expect(explorerAddressUrl('testnet', ADDR)).toBe(
            `https://testnet.tonviewer.com/${ADDR.toString()}`,
        );
    });
});

describe('typed errors', () => {
    it('PoolRejectedError carries the underlying reason and txHash', () => {
        const reason = new Error('exit code 161 — E_AUTOMATON_NOT_ACTIVE');
        const err = new PoolRejectedError(reason, 'deadbeef');
        expect(err.name).toBe('PoolRejectedError');
        expect(err.reason).toBe(reason);
        expect(err.txHash).toBe('deadbeef');
        expect(err.message).toContain('the pool rejected');
        expect(err.message).toContain('exit code 161');
        expect(err.message).toContain('deadbeef');
        expect(err.message).toMatch(/automaton status/);
        // No metadata passed → exitCode + explainHint stay undefined.
        expect(err.exitCode).toBeUndefined();
        expect(err.explainHint).toBeUndefined();
    });

    it('PoolRejectedError exposes exitCode + explainHint when supplied', () => {
        const reason = new Error('atlas reverted');
        const err = new PoolRejectedError(reason, 'deadbeef', {
            exitCode: 120,
            explainHint: 'atlas',
        });
        expect(err.exitCode).toBe(120);
        expect(err.explainHint).toBe('atlas');
        // Metadata is exposed via fields, NOT injected into the message —
        // CLI top-level catch reads the fields and runs explainExitCode +
        // formatExplanation separately, so we don't double-print.
        expect(err.message).not.toMatch(/exit 120 \(atlas\)/);
    });

    it('TxAttributionError names the wallet address it could not match', () => {
        const err = new TxAttributionError(ADDR);
        expect(err.name).toBe('TxAttributionError');
        expect(err.address.equals(ADDR)).toBe(true);
        expect(err.message).toContain(ADDR.toString());
        expect(err.message).toMatch(/check the explorer/);
    });
});

describe('sendAndConfirm', () => {
    // Build the minimal fakes we need to drive the production code path.
    // The function reads exactly: client.open(walletContract).getSeqno(),
    // client.call(c => c.getTransactions(addr, …)), wallet.address,
    // wallet.network. Anything else is a typed-error path we exercise via
    // the `verify` callback / by returning empty tx batches.
    function fakeTx(lt: bigint, info: 'external-in' | 'internal'): Transaction {
        return {
            lt,
            inMessage:
                info === 'external-in'
                    ? { info: { type: 'external-in' } }
                    : { info: { type: 'internal' } },
            hash: () => Buffer.from('abcd1234'.repeat(8), 'hex'),
        } as unknown as Transaction;
    }

    interface Stubs {
        seqnos: number[];
        preTxs: Transaction[];
        postTxs: Transaction[];
        sendCalled: boolean;
    }

    function buildStubs(overrides: Partial<Stubs> = {}): {
        client: FailoverTonClient;
        wallet: AutomatonWallet;
        stubs: Stubs;
    } {
        const stubs: Stubs = {
            seqnos: overrides.seqnos ?? [10, 11],
            preTxs: overrides.preTxs ?? [fakeTx(100n, 'external-in')],
            postTxs: overrides.postTxs ?? [fakeTx(200n, 'external-in')],
            sendCalled: false,
        };

        const opened = {
            getSeqno: jest.fn(async () => {
                const next = stubs.seqnos.shift();
                if (next === undefined) throw new Error('no more seqnos queued');
                return next;
            }),
        };

        // `getTransactions` calls go through `client.call(c => c.getTransactions(...))`;
        // we fake by returning the pre-batch on the first call and the post-batch
        // on subsequent calls. sendAndConfirm makes exactly two such calls.
        let getTxsCalls = 0;
        const getTxsImpl = async (): Promise<Transaction[]> => {
            getTxsCalls++;
            return getTxsCalls === 1 ? stubs.preTxs : stubs.postTxs;
        };

        const client = {
            open: jest.fn(() => opened),
            call: jest.fn(async (fn: (c: { getTransactions: typeof getTxsImpl }) => Promise<unknown>) =>
                fn({ getTransactions: getTxsImpl }),
            ),
        } as unknown as FailoverTonClient;

        const wallet = {
            address: ADDR,
            network: 'testnet',
            walletContract: {} as unknown,
        } as unknown as AutomatonWallet;

        return { client, wallet, stubs };
    }

    const noopSleep = async (): Promise<void> => {};

    it('returns the tx hash + explorer URLs on the happy path', async () => {
        const { client, wallet } = buildStubs();
        const result = await sendAndConfirm(
            client,
            wallet,
            async () => {},
            { sleep: noopSleep },
        );
        expect(result.seqnoBefore).toBe(10);
        expect(result.seqnoAfter).toBe(11);
        expect(result.lt).toBe('200');
        expect(result.txHash).toMatch(/^[0-9a-f]+$/);
        expect(result.explorerUrl).toContain('testnet.tonviewer.com/transaction/');
        expect(result.walletExplorerUrl).toContain('testnet.tonviewer.com/');
    });

    it('invokes verify exactly once after the tx is located', async () => {
        const { client, wallet } = buildStubs();
        const verify = jest.fn(async () => {});
        await sendAndConfirm(client, wallet, async () => {}, {
            sleep: noopSleep,
            verify,
        });
        expect(verify).toHaveBeenCalledTimes(1);
    });

    it('wraps a verify rejection in PoolRejectedError carrying the txHash', async () => {
        const { client, wallet } = buildStubs();
        const inner = new Error('balance check failed');
        const promise = sendAndConfirm(client, wallet, async () => {}, {
            sleep: noopSleep,
            verify: async () => {
                throw inner;
            },
        });
        await expect(promise).rejects.toBeInstanceOf(PoolRejectedError);
        try {
            await promise;
        } catch (err) {
            const e = err as PoolRejectedError;
            expect(e.reason).toBe(inner);
            expect(e.txHash).toMatch(/^[0-9a-f]+$/);
        }
    });

    it('throws TxAttributionError when no external-in tx is newer than baseline', async () => {
        // post-batch contains only internal txs (incoming transfers) — pickWalletTx
        // returns null and sendAndConfirm surfaces the dedicated error.
        const { client, wallet } = buildStubs({
            postTxs: [fakeTx(200n, 'internal'), fakeTx(150n, 'internal')],
        });
        await expect(
            sendAndConfirm(client, wallet, async () => {}, { sleep: noopSleep }),
        ).rejects.toBeInstanceOf(TxAttributionError);
    });

    it('treats an empty pre-tx batch as baselineLt=0 (first-tx wallets)', async () => {
        const { client, wallet } = buildStubs({ preTxs: [] });
        const result = await sendAndConfirm(client, wallet, async () => {}, {
            sleep: noopSleep,
        });
        // Even with no prior txs, the post-batch's first external-in is picked.
        expect(result.lt).toBe('200');
    });

    it('calls send() exactly once between seqno-before and seqno-after reads', async () => {
        const { client, wallet } = buildStubs();
        const callOrder: string[] = [];
        await sendAndConfirm(
            client,
            wallet,
            async () => {
                callOrder.push('send');
            },
            { sleep: noopSleep },
        );
        expect(callOrder).toEqual(['send']);
    });

    describe('verify-failure exit-code recovery (option C: hint + bounce inspection)', () => {
        const DEST = Address.parse('0QAWrBmdkBq3ba3I9365hKTTwx22r5OvgIt-YP18Vuv6NL0i');

        // Wallet tx with one internal-out → DEST + matching destination tx
        // with a non-zero compute exit code. This is the on-chain shape
        // sendAndConfirm walks to recover the exit code when verify fails
        // without one of its own.
        function fakeWalletTxWithOutbound(lt: bigint): Transaction {
            const internalOut = {
                info: { type: 'internal', dest: DEST, src: ADDR },
            };
            return {
                lt,
                inMessage: { info: { type: 'external-in' } },
                outMessages: new Map([[0, internalOut]]),
                hash: () => Buffer.from('aa'.repeat(32), 'hex'),
            } as unknown as Transaction;
        }

        function fakeDestRevertTx(walletLt: bigint, exitCode: number): Transaction {
            return {
                lt: walletLt + 10n,
                inMessage: { info: { type: 'internal', src: ADDR } },
                outMessages: new Map(),
                description: {
                    type: 'generic',
                    computePhase: { type: 'vm', success: false, exitCode },
                },
                hash: () => Buffer.from('bb'.repeat(32), 'hex'),
            } as unknown as Transaction;
        }

        // Build a client that knows two address worth of getTransactions
        // results: one for the wallet (preTxs / postTxs sequence) and one
        // for the destination contract (revert lookup).
        function buildBounceStubs(opts: {
            walletExitCode?: number; // exit code on the destination's revert tx
            destBatch?: Transaction[]; // override the destination's tx batch
        }): { client: FailoverTonClient; wallet: AutomatonWallet } {
            const walletTx = fakeWalletTxWithOutbound(200n);
            const destBatch =
                opts.destBatch ??
                (opts.walletExitCode !== undefined
                    ? [fakeDestRevertTx(walletTx.lt, opts.walletExitCode)]
                    : []);
            const opened = {
                getSeqno: jest.fn(async () => {
                    // First call returns 10 (pre), second returns 11 (post).
                    return opened.getSeqno.mock.calls.length <= 1 ? 10 : 11;
                }),
            };
            // wallet getTransactions is called twice (pre + post). Then if
            // verify fails + origin is set, the destination's recent txs
            // are pulled. Discriminate by address.
            const getTxsImpl = async (
                addr: Address,
                args: { limit: number },
            ): Promise<Transaction[]> => {
                if (addr.equals(ADDR)) {
                    // pre-batch (limit 1) → empty; post-batch (limit > 1) → walletTx
                    return args.limit === 1 ? [] : [walletTx];
                }
                if (addr.equals(DEST)) return destBatch;
                return [];
            };
            const client = {
                open: jest.fn(() => opened),
                call: jest.fn(async (fn: (c: { getTransactions: typeof getTxsImpl }) => Promise<unknown>) =>
                    fn({ getTransactions: getTxsImpl }),
                ),
            } as unknown as FailoverTonClient;
            const wallet = {
                address: ADDR,
                network: 'testnet',
                walletContract: {} as unknown,
            } as unknown as AutomatonWallet;
            return { client, wallet };
        }

        it('extracts exit code from the destination tx when verify fails without one (origin set)', async () => {
            const { client, wallet } = buildBounceStubs({ walletExitCode: 120 });
            const promise = sendAndConfirm(client, wallet, async () => {}, {
                sleep: noopSleep,
                origin: 'atlas',
                // verify throws a plain Error — the bls-register shape that
                // motivated the H2 → option-C fix in the first place.
                verify: async () => {
                    throw new Error('atlas state didn\'t change');
                },
            });
            await expect(promise).rejects.toBeInstanceOf(PoolRejectedError);
            try {
                await promise;
            } catch (err) {
                const e = err as PoolRejectedError;
                expect(e.exitCode).toBe(120);
                expect(e.explainHint).toBe('atlas');
            }
        });

        it('attaches origin even when no destination revert can be found', async () => {
            // Inspection finds no matching tx → exitCode stays undefined,
            // but origin still propagates so a future inner-error code
            // (if there were one) would resolve correctly.
            const { client, wallet } = buildBounceStubs({ destBatch: [] });
            const promise = sendAndConfirm(client, wallet, async () => {}, {
                sleep: noopSleep,
                origin: 'atlas',
                verify: async () => {
                    throw new Error('state mismatch');
                },
            });
            try {
                await promise;
            } catch (err) {
                const e = err as PoolRejectedError;
                expect(e.exitCode).toBeUndefined();
                expect(e.explainHint).toBe('atlas');
            }
        });

        it('prefers an inner-error exit code over chain inspection', async () => {
            // verify throws an SDK-style error WITH .exitCode → no inspection
            // needed; we use that code directly. Atomicity: if inner has the
            // info, no extra RPC.
            const { client, wallet } = buildBounceStubs({ walletExitCode: 999 });
            const promise = sendAndConfirm(client, wallet, async () => {}, {
                sleep: noopSleep,
                origin: 'forgeton',
                verify: async () => {
                    throw Object.assign(new Error('inner sdk error'), { exitCode: 161 });
                },
            });
            try {
                await promise;
            } catch (err) {
                const e = err as PoolRejectedError;
                // 161 from the inner error — NOT 999 from the destination tx.
                expect(e.exitCode).toBe(161);
                expect(e.explainHint).toBe('forgeton');
            }
        });

        it('falls back gracefully when the chain inspection itself errors', async () => {
            // Construct a client that throws for the destination read.
            const { client: baseClient, wallet } = buildBounceStubs({ walletExitCode: 120 });
            const callOrig = baseClient.call.bind(baseClient);
            let callCount = 0;
            const client = {
                ...baseClient,
                call: jest.fn(async (fn: (c: unknown) => Promise<unknown>) => {
                    callCount++;
                    // 1st = pre tx, 2nd = post tx, 3rd = destination → throw.
                    if (callCount === 3) throw new Error('rpc blew up');
                    return callOrig(fn as never);
                }),
            } as unknown as FailoverTonClient;
            const promise = sendAndConfirm(client, wallet, async () => {}, {
                sleep: noopSleep,
                origin: 'atlas',
                verify: async () => {
                    throw new Error('state mismatch');
                },
            });
            // Inspection failure does NOT propagate — sendAndConfirm still
            // throws PoolRejectedError, just without the recovered code.
            await expect(promise).rejects.toBeInstanceOf(PoolRejectedError);
            try {
                await promise;
            } catch (err) {
                const e = err as PoolRejectedError;
                expect(e.exitCode).toBeUndefined();
                expect(e.explainHint).toBe('atlas');
            }
        });

        it('does NOT inspect when origin is omitted (back-compat with existing callers)', async () => {
            // Pre-option-C call sites without origin should work exactly
            // as before: PoolRejectedError with no exitCode / explainHint.
            // Critically, no destination read should happen — the client's
            // call count stays at 2 (pre + post tx batches only).
            const { client, wallet } = buildBounceStubs({ walletExitCode: 120 });
            const callSpy = client.call as jest.Mock;
            const promise = sendAndConfirm(client, wallet, async () => {}, {
                sleep: noopSleep,
                verify: async () => {
                    throw new Error('state mismatch');
                },
            });
            try {
                await promise;
            } catch (err) {
                const e = err as PoolRejectedError;
                expect(e.exitCode).toBeUndefined();
                expect(e.explainHint).toBeUndefined();
                // Two getTransactions calls: pre + post. No destination read.
                expect(callSpy.mock.calls.length).toBe(2);
            }
        });
    });
});
