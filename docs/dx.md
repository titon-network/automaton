# Developer experience — one-page catalogue

Every DX surface the repo ships, in one place. Written for both humans and LLMs — if you're an agent landing cold, this is the top-loaded shortcut index.

If you're about to make a change, start with `/navigate <your task>` in a Claude Code session. If you're about to debug a symptom, start with [`docs/troubleshooting.md`](troubleshooting.md).

---

## Commands (humans)

### Binary subcommands

| Command | Purpose |
|---|---|
| `automaton playground [--ticks N] [--tick-interval <ms>] [--job-interval <s>] [--jobs N] [--no-fortuna] [--json]` | Fully-local simulation. Boots `@ton/sandbox` in-process, deploys the full stack (ForgeTON + Kronos + Atlas + Fortuna by default — `--no-fortuna` for Kronos-only), registers a demo automaton, runs real production tick path. Same operator earns from both protocols. The "30-second test on your laptop" entry point. |
| `automaton init` | First-run scaffold (wallet + config). Idempotent. |
| `automaton doctor [--format json]` | Install + runtime sanity checks. Exits non-zero on any `fail`. |
| `automaton status [--format json]` | Read-only operator snapshot. Best-effort chain reads; never crashes on RPC blips. |
| `automaton stake <register\|increase\|request-unstake\|cancel-unstake\|withdraw>` | Pool lifecycle. Pre-state validation + seqno-advance confirm + post-state verify. |
| `automaton bls <keygen\|pubkey\|register\|deregister> [--force\|--group-id <id>]` | BLS12-381 identity for Fortuna VRF. `keygen` produces `~/.titon/automaton/bls.enc` (same password as wallet by default); `pubkey` reads the plaintext G1 pkShare without unlocking; `register` / `deregister` submit `RegisterBlsShare` / `DeregisterBlsShare` to Atlas. `register` reverts with `OperatorNotFound (120)` if Atlas isn't yet admitted as a ForgeTON consumer. |
| `automaton run [--log-level <level>] [--log-format <pretty\|json\|auto>]` | Start the daemon. `auto` = pretty on TTY, json otherwise. |
| `automaton config show [--format json]` | Effective config (file + env overlay) with `envOverrides` delta block. apiKeys redacted in JSON. |
| `automaton config validate [path] [--format json]` | Dry-run validate a config file against the zod schema. Exits 0 OK, 1 on issues. |
| `automaton completion <bash\|zsh\|fish>` | Emit a shell-completion script. Install with `eval "$(automaton completion bash)"` or dump to fpath. |
| `automaton explain-exit-code <N-or-message> [--format json]` | Look up a TVM exit code or parse one out of an error string. Exit codes: 0 known, 1 no code, 2 code out of every SDK range. |

### `pnpm` scripts (repo-level)

| Script | Runs | Use when… |
|---|---|---|
| `pnpm install` | deps + `postinstall` (preflight --warn-only) | Cloning or after `sync:sdks` |
| `pnpm run build` | `tsc` → `dist/` | Before shipping or running the compiled bin |
| `pnpm run typecheck` | `tsc --noEmit` | Type-only iteration (no JS emit) |
| `pnpm run typecheck:watch` | `tsc --noEmit --watch` | Live type-feedback during large refactors |
| `pnpm run test` | `jest --runInBand` | Full suite before a commit |
| `pnpm run test:watch` | `jest --watch` | Active development on a single module |
| `pnpm run dev -- <args>` | `ts-node --transpile-only src/cli/index.ts` | Sub-second CLI iteration (no build). **Use `pnpm dev <args>` — the `--` separator breaks commander.** |
| `pnpm run preflight` | `scripts/preflight.mjs` | Ad-hoc landmine scan (same checks as postinstall + jest) |
| `pnpm run smoke` | `automaton --version && automaton doctor && automaton playground --ticks 1 --tick-interval 0 --no-fortuna --json` | After build, before ship — verifies the bin runs, doctor passes, and the Kronos demo path is unbroken (Fortuna leg is exercised in tests/cli-playground.spec.ts to keep the smoke gate fast) |
| `pnpm run verify` | build + test + smoke | **The gate CI runs** — run it before opening a PR |
| `pnpm run sync:sdks` | rebuild sibling SDKs + `pnpm install --force` | After editing `../kronos/sdks/typescript/` or `../forgeton/sdks/typescript/` source |
| `pnpm run clean` | `rm -rf dist` | Rarely needed; `build` is idempotent |
| `pnpm run clean:all` | `rm -rf dist node_modules coverage` | Full nuke before rebootstrap |

## Slash commands (`.claude/commands/`)

Invocable from a Claude Code session. Each resolves to a concrete, reviewable edit.

| Slash command | What it does |
|---|---|
| `/verify` | Run `pnpm run verify` + summarise |
| `/preflight` | Run `scripts/preflight.mjs` + report |
| `/dev <args>` | Run CLI via ts-node (no build) |
| `/test-one <spec-or-pattern>` | Run jest scoped to a single file or `-t <name>` filter |
| `/navigate <task>` | Map "I want to X" → exact file via CLAUDE.md's navigator |
| `/new-subcommand <name>` | Scaffold a CLI subcommand end-to-end |
| `/new-metric <name>` | Add a Prom metric with bounded labels + docs + drift-guard |
| `/new-handler <name>` | Add a worker `EventHandler` with debounced side-effects |
| `/new-config-field <name>:<type>` | Schema + env overlay + docs + test |
| `/explain-error <code-or-message>` | Look up a TVM exit code or typed error |

## JSON output shapes (agents)

All machine-readable outputs have exported TS types. Consumers can import them directly.

| Command | Payload type | Exported from |
|---|---|---|
| `doctor --format json` | `DoctorJsonPayload` (`{ version, summary, checks[] }`) | `src/cli/commands/doctor.ts` |
| `status --format json` | `StatusJsonPayload` (TON amounts as `{nano, ton}` pairs) | `src/cli/commands/status.ts` |
| `config show --format json` | `{ path, effective, envOverrides[] }` | `src/cli/commands/config.ts` |
| `config validate --format json` | `ValidateResult` | `src/cli/commands/config.ts` |
| `explain-exit-code --format json` | `Explanation` (`{ code, origin, name, message, hint? }`) | `src/errors/explain.ts` |

**Stability guarantee:** `tests/json-output-shape.spec.ts` inline-snapshots the payloads so any accidental rename / removal / silent-field-add breaks CI.

## Health, metrics, logs (daemon)

| Surface | Where | Shape |
|---|---|---|
| `/metrics` | `http://<metricsHost>:<metricsPort>/metrics` | Prometheus exposition. Names prefixed `automaton_`; labels pinned to bounded enums (see `docs/ops.md` §"Label domains"). |
| `/healthz` | same host | 200 iff last cycle completed within `2 × pollIntervalMs` (staleness-gated). Kubernetes liveness. |
| `/readyz` | same host | 200 iff lockfile held + wallet unlocked + stake active + RPC reachable. Body lists per-check detail. Kubernetes readiness. |
| Logs | stdout | pino JSON in prod / systemd / Docker; pino-pretty on TTY for interactive `automaton run`. Redacts `password` / `mnemonic` / `privateKey` / `seed` / `secretKey` at top-level + one level deep. |

## Drift guards (tests)

| File | Pins |
|---|---|
| `tests/DocsSurface.spec.ts` | Every operator-facing metric name + config field + `EXIT_LOCK_HELD` constant, against runtime surfaces. |
| `tests/json-output-shape.spec.ts` | Every `--format json` payload shape via inline snapshots. |
| `tests/preflight.ts` | Sibling-SDK snapshot sanity at jest globalSetup (delegates to `scripts/preflight.mjs`). |

## Where architecture + design lives

- [`CLAUDE.md`](../CLAUDE.md) — full architecture, navigator tables, design-decision prose. **Primary map.**
- [`AGENTS.md`](../AGENTS.md) — compact LLM-friendly version of the above + task recipes.
- Folder-level `src/*/README.md` — one-liner per file + pointer to the CLAUDE.md section that covers the module.

## Contributor + operator docs

- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — 60-second orientation.
- [`SECURITY.md`](../SECURITY.md) — disclosure policy + hardening expectations.
- [`docs/deploy.md`](deploy.md) — **decision-tree deploy guide for AI assistants + humans**. Top-of-file 30-second routing table → five self-contained paths (playground, local testnet, AWS Lightsail, self-hosted Docker, self-hosted systemd) → common errors table → `Enabling Fortuna VRF` section with the Atlas-admission prereq. Use this when helping a user pick + execute a deployment path.
- [`docs/quickstart.md`](quickstart.md) — 5-min testnet walk-through (subset of `deploy.md` §2 with more prose).
- [`docs/ops.md`](ops.md) — systemd + Docker + key rotation + upgrade + backup + multi-region.
- [`docs/troubleshooting.md`](troubleshooting.md) — symptom → fix table, every exit code, every typed error class.

## CI + automation

- `.github/workflows/ci.yml` — `pnpm run verify` on push to `main` + every PR. Checks out automaton + sibling SDKs at `titon-network/{kronos,forgeton}@main`.
- `.github/dependabot.yml` — weekly grouped pnpm + github-actions bumps.
- `.github/ISSUE_TEMPLATE/{bug,feature,config}.yml` — structured issue intake with pre-wired `automaton doctor` / `status --format json` fields.
- `.github/PULL_REQUEST_TEMPLATE.md` — drift-guard + schema-version-bump checklist.
- `.github/CODEOWNERS` — routes PRs (wallet / submit / lockfile get extra `@security` review hops).

## Dotfiles

| File | Purpose |
|---|---|
| `.nvmrc` | Node 22 for version managers (nvm / asdf / fnm). |
| `.editorconfig` | 4-space TS/JS, 2-space YAML/MD, tabs for Makefiles. LF everywhere. |
| `.gitattributes` | `text=auto eol=lf` + binary markers for images + archives. |
| `.dockerignore` | Parent-context-aware (see `Dockerfile` top-of-file note). |

---

## Elevator pitch for agents

1. **I want to do X** → `/navigate X` or [`CLAUDE.md`](../CLAUDE.md) §AI navigator table.
2. **I want to verify** → `pnpm run verify` (or `/verify`).
3. **I want machine-readable output** → add `--format json` to `doctor` / `status` / `config show` / `config validate` / `explain-exit-code`. Types exported.
4. **I want to iterate fast** → `pnpm dev <args>` (or `/dev <args>`) for ts-node source runs. No build. Sub-second.
5. **I want to know what changed** → `git log` (no separate changelog kept).
6. **I want to understand an error** → `automaton explain-exit-code <N>` or `docs/troubleshooting.md` §"Typed error reference".
