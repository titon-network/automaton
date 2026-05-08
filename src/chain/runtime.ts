// Assembles the objects every on-chain command needs:
//   - FailoverTonClient (endpoint ring + retry)
//   - OpenedContract<ForgeTON>               — baseline staking pool (every operator)
//   - runtime.products[name]                 — product-contributed contracts
//                                              (e.g. products.kronos.registry,
//                                              products.fortuna.atlas/fortuna).
//
// `status`, `doctor`, worker loop, event drain, daemon orchestrator — all
// consume the same bundle. Extracting the "Config → queryable contracts"
// recipe here keeps every caller in sync.
//
// Universality: every non-baseline product is a `ProductModule` (see
// src/products/types.ts). buildChainRuntime iterates every enabled
// product and calls `openContracts`; the resulting handles land under
// `runtime.products[productName]`. ForgeTON pool is the only true
// baseline — every operator stakes there regardless of which products
// they enable. Adding a new product is purely additive — drop a new
// module in src/products/, register it in the PRODUCTS array, and this
// file picks it up automatically.

import { ForgeTON } from '@titon-network/forgeton-sdk';
import type { OpenedContract } from '@ton/core';
import { FailoverTonClient } from './ton-client';
import { resolveDeployment, type Deployment } from './deployment';
import type { Config } from '../config/schema';
import { PRODUCTS, enabledProducts } from '../products';
import type { ProductContracts } from '../products/types';

export interface ChainRuntime {
    client: FailoverTonClient;
    deployment: Deployment;
    /** ForgeTON pool — baseline (every operator stakes here). */
    pool: OpenedContract<ForgeTON>;
    /**
     * Per-product opened contracts — keyed by ProductModule.name, then by
     * the contract identifier each module returns from `openContracts`.
     * Empty object `{}` for an enabled product means "this module owns no
     * contracts" (purely event-observational).
     *
     * @example
     * runtime.products.kronos?.registry  // OpenedContract<KronosRegistry> | undefined
     * runtime.products.fortuna?.fortuna  // OpenedContract<Fortuna> | undefined
     * runtime.products.fortuna?.atlas    // OpenedContract<Atlas> | undefined
     */
    products: Record<string, ProductContracts>;
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
    const products: Record<string, ProductContracts> = {};
    for (const product of enabledProducts(config)) {
        const addresses = deployment.products[product.name] ?? {};
        // openContracts is the bootstrap step — `contracts` is what it
        // RETURNS, so the input is empty.
        products[product.name] = product.openContracts({ client, addresses, contracts: {} });
    }
    return {
        client,
        deployment,
        pool: client.open(ForgeTON.createFromAddress(deployment.pool)),
        products,
    };
}

/**
 * Sanity-check that every config.products flag corresponds to a registered
 * ProductModule. Otherwise a typo (e.g. `products.phoebee = true`) would
 * silently pass and the operator would think Phoebe was running.
 */
function assertProductsSupported(products: Config['products']): void {
    const knownNames = new Set(PRODUCTS.map((p) => p.name));
    for (const flag of Object.keys(products)) {
        if (!knownNames.has(flag)) {
            throw new ProductsNotSupportedError(
                `config.products.${flag} is set but no ProductModule is registered ` +
                    `for "${flag}". Known: ${[...knownNames].sort().join(', ')}`,
            );
        }
    }
}
