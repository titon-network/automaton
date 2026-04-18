# Contributing

Thanks for looking at `@titon/automaton`. This file is the 60-second orientation; detailed context lives in the other docs.

## Where to start

| You are… | Load |
|---|---|
| An AI assistant (Claude Code / similar) | [`AGENTS.md`](AGENTS.md) (compact) → [`CLAUDE.md`](CLAUDE.md) (architecture + navigator table) |
| A human contributor | [`README.md`](README.md) → [`CLAUDE.md`](CLAUDE.md) for architecture → [`docs/ops.md`](docs/ops.md) for deployment context |
| Debugging a symptom | [`docs/troubleshooting.md`](docs/troubleshooting.md) — symptom → fix table |
| Looking for code conventions | Read the existing file near where you're editing; every module has a doc-comment top block + a folder-level `README.md` pointer |

## Local loop

```bash
pnpm install              # installs + runs postinstall preflight (warn-only)
pnpm dev <args>           # ts-node, no build (sub-second iteration)
pnpm run build            # tsc → dist/
pnpm run test             # jest --runInBand (17 s)
pnpm run verify           # build + test + smoke — the single gate CI runs
```

If you edit a sibling SDK (`../kronos/sdk/` or `../forgeton/sdk/`), run `pnpm run sync:sdks` to rebuild + re-snapshot. Never `pnpm install` inside a sibling SDK — the preflight script will refuse to start until you `rm -rf` the nested `node_modules/`.

## Task recipes

Common edits have ready-made slash commands in [`.claude/commands/`](.claude/commands/):

- `/new-subcommand <name>` — scaffold a CLI subcommand end-to-end
- `/new-metric <name>` — add a Prom metric with bounded labels + drift-guard
- `/new-handler <name>` — add a worker `EventHandler`
- `/new-config-field <name>:<type>` — schema + env overlay + docs + test

Each recipe lists the exact files to touch, in order, and what to verify. The authoritative copies also live in [`AGENTS.md`](AGENTS.md) §Common task recipes.

## House rules

- **Bump `CONFIG_VERSION` / `KEYSTORE_VERSION` / `CHECKPOINT_STATE_VERSION`** on any schema change. Loaders refuse to start on mismatch — that's the feature.
- **Every Prom metric label must have a bounded enum.** See `Decision['reason']` in `src/worker/decide.ts` for the pattern.
- **Every handler must be idempotent.** The event drain re-plays from the checkpoint on restart.
- **Every persistent write goes through `src/util/atomic-write.ts`.** Tmp + chmod + rename, with explicit perms (because `writeFileSync`'s `mode` arg is masked by umask).
- **No secrets in logs.** Pino redacts `password` / `mnemonic` / `privateKey` / `seed` / `secretKey` at top-level + one level deep, but don't rely on it — avoid passing secrets into log context in the first place.
- **No `--password` CLI flag.** Shell history is forever. `AUTOMATON_PASSWORD` env is the scripted path; TTY prompt otherwise.

## Commits + PRs

- Conventional commits: `feat(scope): …`, `fix(scope): …`, `docs: …`, `chore: …`, `build: …`.
- Run `pnpm run verify` before opening a PR. CI runs the same gate.
- If you change an operator-facing metric, config field, or exit code, update the docs in the same commit. `tests/DocsSurface.spec.ts` is the drift guard; a docs-only rename that misses the table will fail CI.
- License: MIT. By contributing you agree your work is licensed under the same terms.
