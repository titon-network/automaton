// Mnemonic → WalletContractV5R1 derivation.
//
// V5R1 is network-aware — the walletId bakes the network global ID into the
// state init, so the same mnemonic yields DIFFERENT contract addresses on
// mainnet vs testnet. Callers must pass the network; there is no "neutral"
// address.
//
// We fix workchain=0 and subwalletNumber=0. Multi-workchain / multi-subwallet
// use cases aren't on the automaton's roadmap — if a future version needs
// them, bump KEYSTORE_VERSION and add fields.

import type { Address } from '@ton/core';
import type { KeyPair } from '@ton/crypto';
import { WalletContractV5R1 } from '@ton/ton';
import type { Network } from '../config/schema';
import { mnemonicToKeys } from './mnemonic';

export interface AutomatonWallet {
    mnemonic: string[];
    keyPair: KeyPair;
    walletContract: WalletContractV5R1;
    address: Address;
    network: Network;
}

// Per @ton/ton source: mainnet = -239, testnet = -3. Matches the masterchain
// config param 18 on each network.
const NETWORK_GLOBAL_IDS: Record<Network, number> = {
    mainnet: -239,
    testnet: -3,
};

export async function walletFromMnemonic(
    mnemonic: string[],
    network: Network,
): Promise<AutomatonWallet> {
    const keyPair = await mnemonicToKeys(mnemonic);
    const walletContract = WalletContractV5R1.create({
        publicKey: keyPair.publicKey,
        // walletId carries workchain internally; top-level workchain is mutually
        // exclusive with walletId in @ton/ton's typings.
        walletId: {
            networkGlobalId: NETWORK_GLOBAL_IDS[network],
            context: { workchain: 0, walletVersion: 'v5r1', subwalletNumber: 0 },
        },
    });
    return { mnemonic, keyPair, walletContract, address: walletContract.address, network };
}
