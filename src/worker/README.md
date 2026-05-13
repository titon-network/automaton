# src/worker/

Per-product execution engines + shared event-drain infrastructure. Workers live here (one file per product); the `ProductModule` glue (resolveAddresses / openContracts / buildHandlers / etc.) lives in `../products/`.

| File | Purpose |
|---|---|
| `decide.ts` | **Pure** decision function for Kronos: `(job, mirror, me, now) → { action, reason, … }`. Every outcome has a bounded `reason` tag — authoritative list for Prom label cardinality. |
| `mirror.ts` | `AutomatonMirror` cache (Kronos). `ensureFresh()` = tick-path (count-gated); `refresh()` = event-path (unconditional). |
| `loop.ts` | `runWorkerCycle(deps)` — one Kronos poll iteration. Single-flight via `Set<bigint>`; `submitExecute` injectable for tests. |
| `fortuna.ts` | `FortunaWorker` — event-driven VRF fulfillment. Solo-mode + multi-op (peer share-exchange via `:9091`). |
| `themis.ts` | `ThemisWorker` — per-chamber round + bid state machine; submits `RevealRound` once the commit window closes. Solo-mode v1 (multi-op deferred to v1.1). Exports `chamberSourceKey()` / `themisChamberAddrKey()` / `isThemisChamberKey()` helpers + `THEMIS_FACTORY_SOURCE` / `THEMIS_CHAMBER_SOURCE_PREFIX` / `THEMIS_CHAMBER_ADDR_KEY_PREFIX` constants used by `../products/themis.ts`. |
| `events.ts` | `drainEvents(deps)` — pages tx history backward to the checkpoint; decodes via every product's SDK; dispatches to handlers. |
| `baseline-sources.ts` | Baseline pool `EventSource` (always-on; ForgeTON pool events). Per-product event sources come from `ProductModule.eventStreams`. |
| `handlers.ts` | Built-in ForgeTON-baseline `EventHandler`s: `selfSlashHandler` / `consumerWatchHandler` / `forgetonAwarenessHandler` / `forgetonHealthHandler`. |
| `checkpoint.ts` | `state.json` zod-validated load/save; `CheckpointState` survives restarts. |

See [`../../CLAUDE.md`](../../CLAUDE.md) §AI navigator and §Key design decisions ("Worker decide is pure; loop is I/O; daemon is a timer", "Event drain + checkpoint survive restarts", "FortunaWorker: in-memory pending queue, event-driven fulfillment").
