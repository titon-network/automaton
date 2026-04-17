// Shared helpers for sending internal messages from the automaton's
// wallet and waiting for chain confirmation. Every stake-lifecycle
// subcommand (and future daemon code) funnels through here so one
// place owns: seqno polling, tx attribution, post-send verification,
// explorer URLs.
//
// Why verification matters
// ------------------------
// Wallet seqno advances whenever the wallet's external message is
// signed + accepted by the chain — not when the pool accepts the
// internal message the wallet forwarded. A reverted internal send
// (E_ALREADY_REGISTERED, E_COOLDOWN_NOT_ELAPSED, …) still bumps the
// wallet seqno. "seqno advanced" is therefore NOT proof of success.
//
// sendAndConfirm accepts a `verify` callback that runs after we've
// located the wallet tx. Callers pass an on-chain state check (e.g.
// "after register, pool.getAutomaton(me) is non-null and active").
// If `verify` throws, we wrap the underlying error in
// PoolRejectedError so the CLI can surface a clear "the pool
// rejected your call" message instead of falsely reporting success.
//
// Tx attribution
// --------------
// `getTransactions(address, {limit: 1})` can return an unrelated
// incoming transfer if one landed between our seqno bump and our
// read. Wallet-initiated txs have `inMessage.info.type === 'external-in'`
// (the operator-signed external message is what triggers them).
// We snapshot the lt of the pre-send topmost tx and pick the first
// post-send tx with `lt > snapshot` AND the external-in signature.
//
// Explorer URL: tonviewer is the canonical web explorer; testnet
// lives at testnet.tonviewer.com.

import { Address, type Sender, type Transaction } from '@ton/core';
import type { Network } from '../config/schema';
import type { AutomatonWallet } from '../wallet';
import { FailoverTonClient } from './ton-client';

export interface SubmissionResult {
    txHash: string;
    lt: string;
    seqnoBefore: number;
    seqnoAfter: number;
    explorerUrl: string;
    walletExplorerUrl: string;
}

export interface SendAndConfirmOptions {
    /** Max time to wait for the seqno to advance before giving up. Default 60s. */
    timeoutMs?: number;
    /** Poll interval between seqno checks. Default 2s. */
    pollIntervalMs?: number;
    /** Injected sleep — tests override with a no-op. */
    sleep?: (ms: number) => Promise<void>;
    /** Injected clock — tests override to drive timeouts deterministically. */
    now?: () => number;
    /**
     * Optional on-chain state verification, run after the wallet tx is located.
     * Throw to signal the pool did NOT apply the expected state change (the
     * wallet's external message was accepted but the forwarded internal send
     * reverted). The caller's thrown error is wrapped in {@link PoolRejectedError}.
     */
    verify?: () => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** How many recent txs to fetch when attributing the wallet-initiated one. */
const TX_LOOKBACK = 4;

export class ConfirmationTimeoutError extends Error {
    constructor(
        public readonly address: Address,
        public readonly seqnoBefore: number,
        public readonly waitedMs: number,
    ) {
        super(
            `wallet ${address.toString()} did not advance seqno (still ${seqnoBefore}) ` +
                `within ${waitedMs}ms. The message may still land later — re-run ` +
                `status to check, or look up the wallet on an explorer.`,
        );
        this.name = 'ConfirmationTimeoutError';
    }
}

export class PoolRejectedError extends Error {
    public readonly reason: Error;
    constructor(reason: Error, public readonly txHash: string) {
        super(
            `the wallet tx landed but the pool rejected the internal message: ${reason.message}\n` +
                `Tx: ${txHash}\n` +
                `Run \`automaton status\` to see current on-chain state.`,
        );
        this.name = 'PoolRejectedError';
        this.reason = reason;
    }
}

export class TxAttributionError extends Error {
    constructor(public readonly address: Address) {
        super(
            `seqno advanced for ${address.toString()} but the wallet-initiated tx could not ` +
                `be located in the last ${TX_LOOKBACK} transactions. The tx almost certainly ` +
                `landed — check the explorer for this address.`,
        );
        this.name = 'TxAttributionError';
    }
}

/**
 * Build a Sender from an unlocked automaton wallet. The returned Sender
 * signs + sends through the FailoverTonClient, so every tx inherits
 * endpoint rotation on transient errors automatically.
 */
export function senderFor(client: FailoverTonClient, wallet: AutomatonWallet): Sender {
    const opened = client.open(wallet.walletContract);
    return opened.sender(Buffer.from(wallet.keyPair.secretKey));
}

/**
 * Poll `readSeqno` until it returns a value greater than `seqnoBefore`
 * or the timeout elapses. Pure: no @ton/ton coupling — the tests
 * exercise this in isolation.
 */
export async function waitForSeqnoAdvance(
    readSeqno: () => Promise<number>,
    seqnoBefore: number,
    options: {
        address: Address;
        timeoutMs: number;
        pollIntervalMs: number;
        sleep: (ms: number) => Promise<void>;
        now: () => number;
    },
): Promise<number> {
    const start = options.now();
    while (true) {
        await options.sleep(options.pollIntervalMs);
        const current = await readSeqno();
        if (current > seqnoBefore) return current;
        if (options.now() - start >= options.timeoutMs) {
            throw new ConfirmationTimeoutError(
                options.address,
                seqnoBefore,
                options.now() - start,
            );
        }
    }
}

/**
 * Pick the wallet-initiated tx out of a batch: the first one newer than
 * `baselineLt` whose inbound message was external (wallet signatures
 * arrive as external-in messages). Exported for testability.
 */
export function pickWalletTx(txs: readonly Transaction[], baselineLt: bigint): Transaction | null {
    for (const tx of txs) {
        if (tx.lt <= baselineLt) continue;
        if (tx.inMessage?.info.type === 'external-in') return tx;
    }
    return null;
}

/**
 * Invoke `send` (which should perform exactly one wallet send), then
 * poll until the wallet's seqno advances. Locate the wallet-initiated
 * tx, run the optional verify callback, and return hash + explorer URL.
 */
export async function sendAndConfirm(
    client: FailoverTonClient,
    wallet: AutomatonWallet,
    send: () => Promise<void>,
    options: SendAndConfirmOptions = {},
): Promise<SubmissionResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = options.now ?? Date.now;

    const opened = client.open(wallet.walletContract);
    const [seqnoBefore, preTxs] = await Promise.all([
        opened.getSeqno(),
        client.call((c) => c.getTransactions(wallet.address, { limit: 1 })),
    ]);
    const baselineLt = preTxs.length > 0 ? preTxs[0]!.lt : 0n;

    await send();

    const seqnoAfter = await waitForSeqnoAdvance(() => opened.getSeqno(), seqnoBefore, {
        address: wallet.address,
        timeoutMs,
        pollIntervalMs: pollMs,
        sleep,
        now,
    });

    const postTxs = await client.call((c) =>
        c.getTransactions(wallet.address, { limit: TX_LOOKBACK }),
    );
    const tx = pickWalletTx(postTxs, baselineLt);
    if (tx === null) throw new TxAttributionError(wallet.address);

    const txHash = tx.hash().toString('hex');
    const lt = tx.lt.toString();

    if (options.verify !== undefined) {
        try {
            await options.verify();
        } catch (err) {
            throw new PoolRejectedError(
                err instanceof Error ? err : new Error(String(err)),
                txHash,
            );
        }
    }

    return {
        txHash,
        lt,
        seqnoBefore,
        seqnoAfter,
        explorerUrl: explorerTxUrl(wallet.network, txHash),
        walletExplorerUrl: explorerAddressUrl(wallet.network, wallet.address),
    };
}

export function explorerTxUrl(network: Network, txHashHex: string): string {
    const host = network === 'mainnet' ? 'tonviewer.com' : 'testnet.tonviewer.com';
    return `https://${host}/transaction/${txHashHex}`;
}

export function explorerAddressUrl(network: Network, address: Address): string {
    const host = network === 'mainnet' ? 'tonviewer.com' : 'testnet.tonviewer.com';
    return `https://${host}/${address.toString()}`;
}
