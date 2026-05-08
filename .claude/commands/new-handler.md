---
description: Add a new event handler for the worker event drain (registry + pool events).
argument-hint: <handler-name> — camelCase, e.g. "customerWatchHandler"
---

Add an `EventHandler` named **$ARGUMENTS** to the automaton worker.

Steps:

1. Read `src/worker/handlers.ts` — it has three reference handlers (`mirrorPatchHandler`, `selfSlashHandler`, `consumerWatchHandler`). All three are factories returning `EventHandler`, with optional `onRegistry(event, ctx)` / `onPool(event, ctx)` / `onCycleEnd()` methods.
2. Ask the user (one question) which source(s) of event the handler should subscribe to and what side-effect it should produce (log-only / metric / webhook / state mutation).
3. Implement the factory in `src/worker/handlers.ts`. Discriminate events by `event.kind` — the SDKs export union types (`KronosEvent`, `ForgetonEvent`) with `kind` as the discriminator.
4. **Never throw from a handler.** A thrown handler would abort the drain and block checkpoint advancement. Wrap side-effects in try/catch and log failures at `error`.
5. If the handler wants debounced work (e.g. batching multiple same-tick events into one refresh), use `onCycleEnd()` — see `mirrorPatchHandler` for the pattern.
6. Wire it into `src/daemon/orchestrator.ts::buildHandlers(...)` with any injected dependencies (metrics counter, logger, config).
7. Extend `tests/events.spec.ts` with a dispatch test: craft a minimal event, call `drainEvents` with the handler, assert the side-effect fired exactly once. If the handler uses `onCycleEnd`, assert debouncing.
8. `pnpm run verify`.

If the side-effect is an outbound HTTP call (webhook), it MUST be fire-and-forget with a timeout — see `selfSlashHandler`'s webhook pattern. A blocked POST cannot be allowed to stall the drain.
