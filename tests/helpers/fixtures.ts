// Shared fixtures for handler / product-module unit tests. These are
// deliberately MINIMAL — anything more elaborate (e.g. a sandbox wallet
// + sender) goes through `tests/helpers/chain.ts`'s SandboxHarness.

import { Address } from '@ton/core';
import type { KeyPair } from '@ton/crypto';
import type { WalletContractV5R1 } from '@ton/ton';
import type { AutomatonWallet } from '../../src/wallet';
import type { TxContext } from '../../src/worker/events';

/** Produce a stable raw-format address with every byte equal to `byte`.
 *  Avoids checksum-validation failures from hand-typed 0Q strings, and
 *  keeps test addresses immediately distinguishable in failure output. */
export function fakeAddress(byte: number): Address {
    return new Address(0, Buffer.alloc(32, byte));
}

/** A minimal AutomatonWallet — only `address` + `network` are read by the
 *  paths exercised in unit tests. The keyPair/walletContract stubs are
 *  empty placeholders; tests that send real transactions go through the
 *  sandbox harness instead. */
export function fakeWallet(addr: Address): AutomatonWallet {
    return {
        mnemonic: [],
        keyPair: { publicKey: Buffer.alloc(32), secretKey: Buffer.alloc(64) } as unknown as KeyPair,
        walletContract: {} as WalletContractV5R1,
        address: addr,
        network: 'testnet',
    };
}

/** Stable TxContext for tests that don't care about lt/now/txHash values. */
export function fakeTxContext(): TxContext {
    return { txHash: 'tx-hash', lt: 1n, now: 1_000_000 };
}
