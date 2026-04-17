// Assembles the objects every on-chain command needs:
//   - FailoverTonClient (endpoint ring + retry)
//   - OpenedContract<ForgeTON>               — shared staking pool
//   - OpenedContract<KronosRegistry>         — Phase-D product (automation)
//   - OpenedContract<FortunaRegistry>        — Phase-E product (VRF), reserved
//
// Both `status` and `doctor` build the same bundle; extracting it here
// means the "how to go from Config → queryable contracts" recipe lives
// in one place. The worker loop, event drain, and daemon orchestrator
// all consume the same bundle.
//
// Phase-E extension plan: when fortuna-sdk ships, add `fortuna?: OpenedContract<FortunaRegistry>`
// to ChainRuntime, light up `config.products.fortuna=true`, and wire a
// parallel cycle in the daemon. The `ProductsNotSupportedError` guard
// below keeps stale configs from silently skipping Kronos in the meantime.

import { ForgeTON } from 'forgeton-sdk';
import { KronosRegistry } from 'kronos-sdk';
import type { OpenedContract } from '@ton/core';
import { FailoverTonClient } from './ton-client';
import { resolveDeployment, type Deployment } from './deployment';
import type { Config } from '../config/schema';

export interface ChainRuntime {
    client: FailoverTonClient;
    deployment: Deployment;
    registry: OpenedContract<KronosRegistry>;
    pool: OpenedContract<ForgeTON>;
}

export class ProductsNotSupportedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ProductsNotSupportedError';
    }
}

export function buildChainRuntime(config: Config): ChainRuntime {
    assertProductsSupported(config.products);
    const deployment = resolveDeployment(config);
    const client = new FailoverTonClient({
        network: config.network,
        endpoints: config.endpoints,
    });
    return {
        client,
        deployment,
        registry: client.open(KronosRegistry.createFromAddress(deployment.registry)),
        pool: client.open(ForgeTON.createFromAddress(deployment.pool)),
    };
}

/**
 * Gate on `config.products.*` so stale configs don't silently skip Kronos
 * (if `kronos=false`) or attempt to enable Fortuna before the code path
 * exists (if `fortuna=true`). When Phase E ships, relax the second check.
 */
function assertProductsSupported(products: Config['products']): void {
    if (!products.kronos) {
        throw new ProductsNotSupportedError(
            'config.products.kronos is false but Kronos is the only live product today. ' +
                'Set it to true or upgrade to a release that supports disabling it.',
        );
    }
    if (products.fortuna) {
        throw new ProductsNotSupportedError(
            'config.products.fortuna is true but Fortuna (VRF) support has not shipped. ' +
                'Set it to false; this flag is reserved for Phase E.',
        );
    }
}
