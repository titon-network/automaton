// BLS12-381 identity module — parallel to src/wallet.
//
// The automaton holds two independent identities:
//   - Wallet (BIP-39 mnemonic → WalletV5R1) — signs TON transactions.
//   - BLS secret (32-byte scalar → G1 pkShare) — signs Fortuna VRF alphas.
//
// The two are deliberately decoupled so operators can (later) park their
// BLS material on an HSM / remote signer separately from the TON wallet.
// v1 keeps them side-by-side on disk, both at rest under the same password.

export {
    BLS_KEYSTORE_VERSION,
    BlsKeystoreSchema,
    BlsKeystoreNotFoundError,
    BlsKeystoreValidationError,
    WrongBlsPasswordError,
    blsKeystoreExists,
    loadBlsKeystore,
    lockBlsKeystore,
    saveBlsKeystore,
    unlockBlsKeystore,
    type BlsKeystore,
    type BlsLockOptions,
} from './keystore';

export { randomBlsSecret, blsPublicKey, signAlpha, computeAlpha } from '@titon-network/fortuna-sdk';

// Multi-op aggregation (phase 1 surface; FortunaWorker rewires onto this in
// phase 2). For the additive `t = n` scheme, the on-chain BLS_VERIFY against
// `groupPk = aggregateGroupPublicKey(pkShares)` succeeds iff
// `aggregate = aggregateSignatures(partials)` was produced from ALL n
// partials of the same alpha. fortuna-sdk owns the math; we re-export with
// a typed wrapper so the daemon doesn't reach into fortuna-sdk internals.
import { aggregateSignatures } from '@titon-network/fortuna-sdk';

/**
 * Combine N partial G2 signatures (96 bytes each) into one G2 aggregate
 * (96 bytes). Caller MUST supply all N partials of an additive `t = n`
 * group — Lagrange interpolation for proper threshold (`t < n`) is phase 4.
 *
 * The order of `partials` does not matter (G2 addition commutes).
 */
export function aggregateFortunaPartials(partials: readonly Buffer[]): Buffer {
    if (partials.length === 0) {
        throw new Error('aggregateFortunaPartials: at least one partial required');
    }
    return aggregateSignatures(partials);
}

export { aggregateGroupPublicKey } from '@titon-network/fortuna-sdk';
