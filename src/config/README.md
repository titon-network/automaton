# src/config/

Config schema + path resolution + env overlay. Every filesystem path the automaton touches has exactly one resolver here.

| File | Purpose |
|---|---|
| `schema.ts` | Zod `ConfigSchema` + `Network` + `LogLevel` + `defaultConfig(network)`. `CONFIG_VERSION` bumped on any semantic change. |
| `paths.ts` | `titonHome` / `automatonDir` / `configPath` / `walletPath` / `statePath` / `lockPath` / `logsDir`. Functions (not constants) so tests can mutate env mid-run. |
| `load.ts` | `loadConfig` / `saveConfig` + `applyEnvOverlay` (narrow allow-list; re-uses schema validators). Typed errors: `ConfigNotFoundError`, `ConfigValidationError`, `ConfigEnvOverlayError`. |
| `index.ts` | Barrel. |

See [`../../CLAUDE.md`](../../CLAUDE.md) §AI navigator ("Add a new config field", "Add an env var override") and §Key design decisions ("Paths module is the single source of truth").
