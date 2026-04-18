---
description: Add a new field to the automaton config schema, with env overlay + docs + drift-guard test.
argument-hint: <fieldName>:<type> — e.g. "maxRetries:number" or "webhookTimeoutMs:number"
---

Add a new config field **$ARGUMENTS** to the automaton.

Steps (order matters — the schema is the source of truth):

1. Read `src/config/schema.ts` and `src/config/load.ts`. Note `CONFIG_VERSION`, `ConfigSchema`, `defaultConfig`, and `applyEnvOverlay`'s env-var allow-list.
2. Ask the user (one question if not obvious from $ARGUMENTS):
   - exact type (string / number / boolean / enum / url)
   - default value
   - env-var override needed? If yes, propose `AUTOMATON_<UPPER_SNAKE>`.
   - whether adding the field changes semantics (if yes, bump `CONFIG_VERSION`).
3. Add to `ConfigSchema` with `.optional()` + explicit default in `defaultConfig`. For numbers use `z.number().int().positive()` or tighter; for URLs use `z.string().url()`; for enums use `z.enum([...])`.
4. If runtime-tunable, extend `applyEnvOverlay` in `src/config/load.ts` — re-use the schema's parser on the raw env value so types stay honest (see existing `AUTOMATON_NETWORK` / `AUTOMATON_METRICS_PORT` pattern).
5. Document in `README.md` §"Configuration" table. If env-overridable, extend the env-var sentence below the table.
6. Consume the field where it belongs. Don't plumb it through orchestrator unless it configures daemon behaviour.
7. Extend `tests/config.spec.ts` with round-trip + env-overlay cases. `DocsSurface.spec.ts` will auto-pin the README table against `ConfigSchema.shape` — no extra wiring.
8. `pnpm run verify`.

If you bumped `CONFIG_VERSION`, write a migration note in the commit message describing what the old config needs to become.
