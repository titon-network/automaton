// Resolves the (pool) baseline address for a given network plus every
// address contributed by enabled `ProductModule`s.
//
// All runtime code goes through this indirection so there's one place to
// wire new deployments, chain migrations, or per-operator overrides.
//
// Why not just inline `KRONOS_TESTNET.registry`?
//   - Status / doctor / worker all need the same addresses.
//   - Config-level override (future) lands here.
//   - Mainnet coming online is a one-line change here + one test.
//   - Every product follows the same shape via ProductModule.resolveAddresses,
//     so adding Phoebe / Argus is purely additive.
//
// ForgeTON pool is the only baseline — every operator stakes there
// regardless of which products they enable. Kronos / Fortuna / Phoebe /
// Argus addresses come from their respective ProductModules.

import { Address } from '@ton/core';
import { FORGETON_MAINNET, FORGETON_TESTNET } from '@titon-network/forgeton-sdk';
import type { Config } from '../config/schema';
import { enabledProducts } from '../products';
import type { ProductAddresses } from '../products/types';

export interface Deployment {
    /** ForgeTON pool — baseline. */
    pool: Address;
    /**
     * Per-product addresses — keyed by ProductModule.name, then by the
     * contract identifier that module's `resolveAddresses` returns. Empty
     * `{}` for products that aren't enabled.
     *
     * @example
     * deployment.products.kronos?.registry  // Address | undefined
     * deployment.products.fortuna?.atlas    // Address | undefined
     * deployment.products.fortuna?.fortuna  // Address | undefined
     */
    products: Record<string, ProductAddresses>;
}

export class DeploymentNotAvailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DeploymentNotAvailableError';
    }
}

/** Helper for ProductModule.resolveAddresses — parse a config-override
 *  address string with an actionable error message. */
export function parseAddressOrThrow(raw: string, label: string): Address {
    try {
        return Address.parse(raw);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new DeploymentNotAvailableError(
            `${label} address is not a valid TON address: ${msg}\n` +
                `  value: ${raw}\n` +
                `  check the matching config field or the AUTOMATON_${label.toUpperCase()}_ADDRESS env var.`,
        );
    }
}

/**
 * Resolve the deployment for the given config.
 *
 * Baseline pool address comes from `@titon-network/forgeton-sdk`'s
 * FORGETON_TESTNET / FORGETON_MAINNET. Per-product addresses come from
 * each enabled ProductModule's `resolveAddresses` (which typically prefers
 * a config override, falls back to the SDK constant, and throws
 * DeploymentNotAvailableError when neither is present).
 *
 * Throws {@link DeploymentNotAvailableError} when a product is enabled
 * but its addresses cannot be resolved, or when the network has no
 * baseline deployment yet.
 */
export function resolveDeployment(config: Config): Deployment {
    let pool: Address;
    switch (config.network) {
        case 'testnet':
            pool = FORGETON_TESTNET.forgeton;
            break;
        case 'mainnet':
            pool = FORGETON_MAINNET.forgeton;
            break;
    }

    const products: Record<string, ProductAddresses> = {};
    for (const product of enabledProducts(config)) {
        products[product.name] = product.resolveAddresses(config);
    }

    return { pool, products };
}
