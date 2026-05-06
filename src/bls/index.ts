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
