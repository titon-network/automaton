// Baseline event sources — only ForgeTON pool today. Always present
// for every operator (no opt-in).
//
// Each ProductModule contributes additional sources via `eventStreams()`;
// the orchestrator concatenates baseline + product streams into the list
// passed to `drainEvents`. Kronos's registry stream comes from the
// kronos ProductModule (`src/products/kronos.ts` — REGISTRY_SOURCE).

import { decodeEvents as decodeForgetonEvents } from '@titon-network/forgeton-sdk';
import type { ChainRuntime } from '../chain';
import type { EventSource } from './events';

/** Source key for the baseline ForgeTON pool stream. */
export const POOL_SOURCE = 'pool' as const;

/** Build the baseline (always-on) event sources from the chain runtime. */
export function baselineEventSources(runtime: ChainRuntime): readonly EventSource[] {
    return [
        {
            source: POOL_SOURCE,
            address: runtime.deployment.pool,
            decode: (bodies) => decodeForgetonEvents(bodies),
        },
    ];
}
