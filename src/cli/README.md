# src/cli/

`automaton` CLI — thin commander wiring in `index.ts`; each subcommand is a self-contained module in `commands/`.

| File | Purpose |
|---|---|
| `index.ts` | Entry (`bin` → `dist/cli/index.js`). Wires commander, renders TVM exit-code explanations on crash. |
| `version.ts` | Reads `package.json` version at runtime. |
| `prompt.ts` | Readline text/choice/confirm prompts; throws `NotInteractiveError` on non-TTY. |
| `commands/init.ts` | First-run scaffold (wallet + config). Idempotent; refuses to clobber. |
| `commands/doctor.ts` | Install + runtime sanity checks. `--format json` for agents. |
| `commands/status.ts` | Operator snapshot. `--format json` for agents. |
| `commands/stake.ts` | Pool lifecycle: register / increase / request-unstake / cancel-unstake / withdraw. |
| `commands/run.ts` | Delegates to `src/daemon/orchestrator.ts::runDaemon`. |

See [`../../CLAUDE.md`](../../CLAUDE.md) §AI navigator for the full task→file mapping. Task recipes (new subcommand, new metric, new handler, new config field) live in [`../../AGENTS.md`](../../AGENTS.md) §Common task recipes.
