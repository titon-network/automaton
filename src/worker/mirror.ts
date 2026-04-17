// Cache of the registry's automaton mirror.
//
// D.8 ships a simple "snapshot once per cycle" implementation: every
// `ensureFresh()` call checks `activeAutomatonCount` and, if the count
// changed, re-snapshots by reading `getAutomatonAt(i)` for every slot.
// That's N+1 RPC calls — acceptable when N is small (mainnet forecast
// is <100 automatons at launch).
//
// D.9 will subscribe to `AutomatonMirrorUpdated` events and patch this
// cache incrementally, eliminating the per-cycle resnapshot. The cache
// exposes a `replace` method so D.9's event tailer can swap the full
// list, and a `pendingActiveCount` getter so the same invariant (dense
// in [0, activeCount)) is preserved.

import type { Address } from '@ton/core';
import type { ChainRuntime } from '../chain';

export class AutomatonMirror {
    private addresses: Address[] = [];
    private lastKnownCount: bigint | null = null;

    constructor(private readonly runtime: ChainRuntime) {}

    /** Current cached snapshot — dense in `[0, length)`. */
    get snapshot(): readonly Address[] {
        return this.addresses;
    }

    /** `activeAutomatonCount` from the last successful refresh. */
    get activeCount(): bigint {
        return this.lastKnownCount ?? 0n;
    }

    /**
     * Refresh if the cached snapshot is out of date. Reads
     * `registry.getActiveAutomatonCount()` (what `decide` actually resolves
     * against — NOT `pool.getAutomatonCount`, which is the pool's
     * zombie-inclusive lifetime counter). If the active count matches the
     * last snapshot size, we skip the per-slot fetch.
     *
     * Swap-and-pop can move addresses between slots without changing the
     * count; we accept that drift for D.8 (stale-slot Execute simply
     * fails the tx and the next cycle fixes it). D.9's event tailer will
     * land exact consistency via `replace()`.
     */
    async ensureFresh(): Promise<void> {
        const count = await this.runtime.registry.getActiveAutomatonCount();
        if (this.lastKnownCount === count && BigInt(this.addresses.length) === count) {
            return;
        }
        await this.refresh(count);
    }

    /**
     * Force a full re-read from the registry's mirror. N+1 RPC calls
     * (1 for the count if `activeCount` not supplied, N for the slots).
     */
    async refresh(activeCount?: bigint): Promise<void> {
        const count =
            activeCount ?? (await this.runtime.registry.getActiveAutomatonCount());
        const next: Address[] = [];
        for (let i = 0; i < Number(count); i++) {
            const addr = await this.runtime.registry.getAutomatonAt(i);
            if (addr === null) {
                throw new Error(
                    `registry mirror inconsistent: getAutomatonAt(${i}) returned null ` +
                        `while activeAutomatonCount=${count}. Re-fetching may clear it; ` +
                        `if persistent, the pool may need ForceSync.`,
                );
            }
            next.push(addr);
        }
        this.addresses = next;
        this.lastKnownCount = count;
    }

    /**
     * Replace the cached mirror wholesale (used by D.9's event tailer).
     * `activeCount` is stored verbatim; no consistency check here — the
     * caller is expected to pass a coherent `(count, addresses)` pair.
     */
    replace(addresses: readonly Address[], activeCount: bigint): void {
        this.addresses = [...addresses];
        this.lastKnownCount = activeCount;
    }
}
