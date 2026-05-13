// Product registry — every ProductModule the daemon knows about.
//
// ForgeTON pool is the only baseline (every operator stakes there).
// Kronos automation, Fortuna VRF, and any future product are all
// `ProductModule` instances registered here. Adding a product is a
// three-line change:
//
//   1. Author the module in src/products/<name>.ts (ProductModule shape).
//   2. Add `<name>: z.boolean()` to ConfigSchema.products (src/config/schema.ts).
//   3. Append the module to PRODUCTS below.
//
// The orchestrator, event drain, deployment resolver, schema check, error
// explainer, doctor, and status all iterate this list — none of them
// hardcode product names.

import type { Config } from '../config/schema';
import type { ProductModule } from './types';
import { kronos } from './kronos';
import { fortuna } from './fortuna';
import { themis } from './themis';

// Re-export the canonical types so `import { ProductModule } from '../products'`
// works without reaching into ./types directly.
export * from './types';
export { kronos, fortuna, themis };

/**
 * Every product the daemon knows about. ORDER MATTERS for the
 * `explainExitCode` priority walk: products listed earlier win on
 * overlapping code ranges. Kronos is registered first because it owns
 * the largest custom-code table among today's products; fortuna second;
 * themis third.
 *
 * ForgeTON pool is the only true baseline (every operator stakes there
 * regardless of which products they enable); its checks live directly
 * in src/chain/{deployment,runtime,schema-check}.ts.
 */
export const PRODUCTS: readonly ProductModule[] = [kronos, fortuna, themis];

/**
 * Filter `PRODUCTS` to the ones the operator opted into via their config.
 * Order is preserved from PRODUCTS so cycle work happens in a stable
 * dependency-friendly sequence.
 */
export function enabledProducts(config: Config): readonly ProductModule[] {
    return PRODUCTS.filter((p) => p.isEnabled(config));
}

/** Look up a product by name. Returns undefined for unknown names. */
export function findProduct(name: string): ProductModule | undefined {
    return PRODUCTS.find((p) => p.name === name);
}
