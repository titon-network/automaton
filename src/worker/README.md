# src/worker/

The Kronos execution engine. Three layers: pure decision function, single-iteration I/O loop, and pluggable event subscribers.

| File | Purpose |
|---|---|
| `decide.ts` | **Pure** function: `(job, mirror, me, now) → { action, reason, … }`. Every outcome has a bounded `reason` tag — authoritative list for Prom label cardinality. |
| `mirror.ts` | `AutomatonMirror` cache. `ensureFresh()` = tick-path (count-gated); `refresh()` = event-path (unconditional). |
| `loop.ts` | `runWorkerCycle(deps)` — one poll iteration. Single-flight via `Set<bigint>`; `submitExecute` injectable for tests. |
| `events.ts` | `drainEvents(deps)` — pages tx history backward to the checkpoint; decodes via both SDKs; dispatches to handlers. |
| `handlers.ts` | Built-in `EventHandler`s: `mirrorPatchHandler` / `selfSlashHandler` / `consumerWatchHandler`. |
| `checkpoint.ts` | `state.json` zod-validated load/save; `CheckpointState` survives restarts. |

See [`../../CLAUDE.md`](../../CLAUDE.md) §AI navigator and §Key design decisions ("Worker decide is pure; loop is I/O; daemon is a timer", "Event drain + checkpoint survive restarts").
