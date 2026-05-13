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

import { Address, type Message, type Sender, type Transaction } from '@ton/core';
import type { Network } from '../config/schema';
import type { AutomatonWallet } from '../wallet';
import { defaultSleep } from '../errors/backoff';
import { extractExitCode, type ExplainHint } from '../errors/explain';
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
    /**
     * Which SDK should explain revert exit codes from the destination
     * contract. Passed through to `PoolRejectedError.explainHint` and
     * surfaces via the CLI's top-level explainer so cross-SDK code
     * overlaps (e.g. 120 → kronos / fortuna / atlas with different
     * meanings) resolve correctly.
     *
     * When `verify` throws AND we can't extract a code from its error
     * chain, we ALSO use this hint to do a one-shot inspection of the
     * destination contract's recent txs — recovering the actual exit
     * code for verify-state-mismatch cases (e.g. `automaton bls register`
     * silently failing with Atlas's `OperatorNotFound`).
     *
     * Callers should pass the SDK name matching the contract they're
     * sending to: `'forgeton'` for stake ops, `'kronos'` for Execute,
     * `'atlas'` for BLS register/deregister, `'fortuna'` for fulfill, etc.
     */
    origin?: ExplainHint;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
/**
 * How many recent txs to fetch when attributing the wallet-initiated one.
 *
 * Sized for multi-product operators whose wallet is bursty: a Fortuna
 * fulfillment + a Themis reveal + a Kronos execute can land within the
 * same poll cycle, and we need the lookback window to comfortably span
 * the worst-case interleaving between the seqno bump we observed and
 * the moment we read the wallet's tx history. 4 was too tight (real-
 * world miss in 0.9.1 with Themis + Fortuna + Kronos co-running on
 * the canary — RevealRound got pushed past the 4-tx window by an
 * intervening Fortuna fulfillment). 32 absorbs ~8s of bursty tx
 * production at a few-tx-per-second sustained rate, which is well past
 * anything an operator with all three products would realistically hit.
 *
 * Cost is one toncenter `getTransactions(limit=N)` call — N=32 is a
 * single HTTP round-trip on toncenter (which caps `limit` at 100).
 */
const TX_LOOKBACK = 32;

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
    public readonly txHash: string;
    /**
     * TVM exit code recovered from the chain — either from the inner
     * verify-callback exception (when an SDK method threw with code)
     * or from a one-shot bounce-trace inspection of the destination's
     * recent txs (when verify just observed "state didn't change").
     * `undefined` when no code could be recovered (e.g. RPC blip during
     * inspection, or a genuine non-revert state-mismatch).
     */
    public readonly exitCode: number | undefined;
    /**
     * Which SDK explains `exitCode`. Set from `SendAndConfirmOptions.origin`.
     * The `extractExplainHint` walker reads it off the error chain so the
     * CLI's `explainExitCode(code, hint)` resolves cross-SDK overlaps.
     */
    public readonly explainHint: ExplainHint | undefined;

    constructor(
        reason: Error,
        txHash: string,
        meta: { exitCode?: number; explainHint?: ExplainHint } = {},
    ) {
        super(
            `the wallet tx landed but the pool rejected the internal message: ${reason.message}\n` +
                `Tx: ${txHash}\n` +
                `Run \`automaton status\` to see current on-chain state.`,
        );
        this.name = 'PoolRejectedError';
        this.reason = reason;
        this.txHash = txHash;
        this.exitCode = meta.exitCode;
        this.explainHint = meta.explainHint;
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

/** How many recent destination txs to scan when recovering an exit code. */
const DESTINATION_TX_LOOKBACK = 5;

/**
 * Walk a wallet tx's outbound messages, return the destination address
 * of the first internal-out (the contract our send call targeted).
 * Returns `null` when the tx had no internal outbound — happens when
 * the wallet rejected the external message before issuing any actions
 * (rare; usually surfaces as a seqno that didn't advance).
 */
export function pickInternalDestination(walletTx: Transaction): Address | null {
    for (const [, msg] of walletTx.outMessages) {
        const m = msg as Message;
        if (m.info.type === 'internal') return m.info.dest as Address;
    }
    return null;
}

/**
 * One-shot inspection of a destination contract's recent txs to recover
 * the actual exit code from a revert that `verify()` could only detect
 * indirectly ("state didn't change").
 *
 * Best-effort: any RPC failure / pagination edge / parse mismatch is
 * caught and returns `null`. Never throws — the caller falls back to
 * the original verify-callback error message.
 *
 * Match criteria for the destination tx:
 *   - inMessage is internal (skips external-in / bounces)
 *   - inMessage.info.src === walletAddr (it's OUR submission)
 *   - lt > walletTx.lt (causal ordering)
 *
 * Returns `null` when no match, when description.computePhase isn't of
 * type 'compute' (skipped), or when exit code is 0 (success — verify
 * failure was something else).
 */
export async function findDestinationRevert(
    client: FailoverTonClient,
    destination: Address,
    walletAddr: Address,
    walletLt: bigint,
): Promise<number | null> {
    try {
        const txs = await client.call((c) =>
            c.getTransactions(destination, { limit: DESTINATION_TX_LOOKBACK }),
        );
        for (const tx of txs) {
            if (tx.lt <= walletLt) continue;
            const inMsg = tx.inMessage;
            if (inMsg === undefined || inMsg === null) continue;
            if (inMsg.info.type !== 'internal') continue;
            if (!inMsg.info.src.equals(walletAddr)) continue;
            const desc = tx.description;
            if (desc.type !== 'generic') continue;
            const compute = desc.computePhase;
            if (compute.type !== 'vm') continue;
            if (compute.success) continue;
            // exitCode is non-zero on failure (TVM's contract — 0 = success).
            // Some implementations expose .exitCode, some .exit_code; @ton/core
            // uses .exitCode.
            const code = compute.exitCode;
            if (typeof code === 'number' && Number.isFinite(code) && code !== 0) {
                return code;
            }
        }
        return null;
    } catch {
        // RPC blip, malformed tx, anything — fall through to the
        // verify-error-only path. Surfacing a partial diagnostic is
        // worse than the existing "atlas state didn't change" message.
        return null;
    }
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
    const sleep = options.sleep ?? defaultSleep;
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
            const reason = err instanceof Error ? err : new Error(String(err));
            // Recover an exit code via two paths, in order:
            //   1. From the inner exception (SDKs that throw with .exitCode,
            //      sandbox "exit code N" message strings, wrapped errors via
            //      the .reason / .cause walk in extractExitCode).
            //   2. From the destination contract's recent txs — the
            //      verify-state-mismatch case where the inner exception is
            //      a plain Error with no code. Only attempted when `origin`
            //      was supplied (without it we can't disambiguate the
            //      eventual explainExitCode walk).
            let exitCode = extractExitCode(reason);
            if (exitCode === null && options.origin !== undefined) {
                const destination = pickInternalDestination(tx);
                if (destination !== null) {
                    exitCode = await findDestinationRevert(
                        client,
                        destination,
                        wallet.address,
                        tx.lt,
                    );
                }
            }
            throw new PoolRejectedError(reason, txHash, {
                exitCode: exitCode ?? undefined,
                explainHint: options.origin,
            });
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
    // Defensive: tx hashes come from Buffer.toString('hex') on tx.hash()
    // (32 bytes → 64 hex chars), but future callers could pass operator-
    // supplied input. Reject anything else so a stray `../` or `?` can't
    // produce a confusing tonviewer page.
    if (!/^[0-9a-fA-F]{64}$/.test(txHashHex)) {
        throw new Error(
            `explorerTxUrl: txHashHex must be 64 hex chars (got length ${txHashHex.length})`,
        );
    }
    const host = network === 'mainnet' ? 'tonviewer.com' : 'testnet.tonviewer.com';
    return `https://${host}/transaction/${txHashHex}`;
}

export function explorerAddressUrl(network: Network, address: Address): string {
    const host = network === 'mainnet' ? 'tonviewer.com' : 'testnet.tonviewer.com';
    return `https://${host}/${address.toString()}`;
}
