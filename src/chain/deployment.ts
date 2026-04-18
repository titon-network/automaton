// Resolves the (registry, pool) address pair to talk to for a given
// network. Today this is a two-liner — testnet is live, mainnet isn't —
// but all runtime code goes through this indirection so there's one place
// to wire new deployments, chain migrations, or per-operator overrides.
//
// Why not just inline `KRONOS_TESTNET.registry`?
//   - Status / doctor / worker all need the same addresses. A single
//     resolver keeps them consistent.
//   - Config-level override (future) lands here. Operators running a
//     private fork or a staging deploy drop addresses into config.json
//     and the rest of the code doesn't need to know.
//   - Mainnet coming online is a one-line change here + one test.

import { Address } from '@ton/core';
import { KRONOS_TESTNET } from 'kronos-sdk';
import type { Config } from '../config/schema';

export interface Deployment {
    registry: Address;
    pool: Address;
}

export class DeploymentNotAvailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DeploymentNotAvailableError';
    }
}

/**
 * Resolve the deployment for the given config. Honours `config.deployment`
 * (future — not yet in schema); otherwise falls back to the SDK constants.
 * Throws {@link DeploymentNotAvailableError} when no deployment exists yet
 * for the network (i.e. mainnet, today).
 */
export function resolveDeployment(config: Config): Deployment {
    switch (config.network) {
        case 'testnet':
            return { registry: KRONOS_TESTNET.registry, pool: KRONOS_TESTNET.forgeton };
        case 'mainnet':
            throw new DeploymentNotAvailableError(
                'Kronos mainnet deployment is not yet live. Testnet addresses are in ' +
                    'kronos-sdk as KRONOS_TESTNET; when mainnet lands a KRONOS_MAINNET ' +
                    'constant will ship in the same place.',
            );
    }
}
