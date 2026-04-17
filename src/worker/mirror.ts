// Cache of the registry's automaton mirror.
//
// Two public methods, two different use cases:
//
//   `ensureFresh()` — called on every worker tick. Reads
//     `registry.getActiveAutomatonCount()` and SKIPS the N-slot fetch
//     when the count hasn't changed (the common case — most ticks
//     don't see a membership change). N+1 RPC calls on change; 1 on
//     no-change.
//
//   `refresh()` — called by the `mirrorPatchHandler` when an
//     `AutomatonMirrorUpdated` event fires. Unconditional re-read —
//     the event tells us the mirror changed, so we don't rely on the
//     count-comparison heuristic (swap-and-pop moves addresses
//     between slots without changing the count, and the event is
//     authoritative).
//
// Source of truth is `registry.getActiveAutomatonCount()` (what
// `decide` ultimately resolves assignment against), NOT
// `pool.getAutomatonCount` which is the pool's zombie-inclusive
// lifetime counter.

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
     * Refresh if the active count has changed since the last snapshot.
     * The common case (no membership change) is cheap — 1 RPC call
     * for the count, early return. On change, a full re-read runs.
     */
    async ensureFresh(): Promise<void> {
        const count = await this.runtime.registry.getActiveAutomatonCount();
        if (this.lastKnownCount === count && BigInt(this.addresses.length) === count) {
            return;
        }
        await this.refresh(count);
    }

    /**
     * Unconditional full re-read from the registry's mirror. Use from
     * event handlers where the event is authoritative proof that
     * something changed (swap-and-pop can move addresses without
     * changing the count, so `ensureFresh` alone can miss it).
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
}
