// Thin wrapper around @ton/crypto's mnemonic primitives. Kept as its own
// module so (a) the wallet + keystore layers don't need to know they're
// ultimately calling @ton/crypto, and (b) tests can mock this single surface
// if we ever need deterministic mnemonics.

import { mnemonicNew, mnemonicToPrivateKey, mnemonicValidate, type KeyPair } from '@ton/crypto';

// TON ecosystem standard is 24 words. The default in @ton/crypto is also 24;
// we make it explicit so future changes to the upstream default can't silently
// shrink the entropy of new keystores.
const MNEMONIC_WORDS = 24;

export async function generateMnemonic(): Promise<string[]> {
    return mnemonicNew(MNEMONIC_WORDS);
}

export async function validateMnemonic(mnemonic: string[]): Promise<boolean> {
    if (mnemonic.length !== MNEMONIC_WORDS) return false;
    return mnemonicValidate(mnemonic);
}

export async function mnemonicToKeys(mnemonic: string[]): Promise<KeyPair> {
    return mnemonicToPrivateKey(mnemonic);
}
