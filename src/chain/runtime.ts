// Assembles the three objects every on-chain command needs:
//   - FailoverTonClient (endpoint ring + retry)
//   - OpenedContract<KronosRegistry>
//   - OpenedContract<ForgeTON>
//
// Both `status` and `doctor` build the same bundle; extracting it here
// means the "how to go from Config → queryable contracts" recipe lives
// in one place. The worker loop, event drain, and daemon orchestrator
// all consume the same bundle.

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

export function buildChainRuntime(config: Config): ChainRuntime {
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
