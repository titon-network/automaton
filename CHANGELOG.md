# Changelog

All notable changes to `@titon/automaton` land here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **DX: machine-readable CLI.** `automaton doctor --format json` and `automaton status --format json` emit stable payloads (bigints as `{nano, ton}` pairs, endpoint apiKeys stripped, snapshot errors in a top-level array). Exit codes preserved.
- **DX: single-command gates.** `pnpm run verify` (build + test + smoke), `pnpm dev` (ts-node, no build), `pnpm run preflight` (ad-hoc landmine scan).
- **DX: `scripts/preflight.mjs`** — single source of truth for sibling-SDK snapshot checks. Runs on `postinstall` (warn-only; no-ops outside monorepo), at jest `globalSetup`, and on demand. Catches landmines at install time, not test time.
- **DX: `.claude/commands/`** — 9 slash commands mapped to AGENTS.md recipes: `/verify`, `/preflight`, `/dev`, `/navigate`, `/new-subcommand`, `/new-metric`, `/new-handler`, `/new-config-field`, `/explain-error`.
- **DX: folder-level navigator stubs** at `src/{cli,chain,worker,daemon,config,wallet,errors,util}/README.md`. Bottom-up explorers land on the file map without climbing two levels to `CLAUDE.md`.
- **CI: GitHub Actions workflow** (`.github/workflows/ci.yml`) runs `pnpm run verify` on every push to `main` and every PR (checks out automaton + sibling SDKs, builds both SDKs via `sync:sdks`, then gates the full suite).
- **Ops: `CONTRIBUTING.md` + `.editorconfig`** for contributor + IDE consistency.

### Changed

- **CLAUDE.md** shrunk ~30%: D.1–D.15 phase history relocated to `docs/phases.md`. The always-loaded navigator + architecture stay; archaeology moves one hop away.
- **`DocsSurface.spec.ts`** now excludes `src/`, `scripts/`, `contrib/` from the walkMarkdown so dev-tree stubs don't trigger operator-surface drift guards.
- **Test-count drift** removed from `README.md` + `AGENTS.md` (was `292` in two places, `342` in a third). `DocsSurface.spec.ts` remains the pinned invariant for metric names + config field names + `EXIT_LOCK_HELD`.

### Fixed

- **SDK realignment:** `KronosDeployment.pool` → `.forgeton`, `executionCost(x)` → `executionEconomics(x).totalCost`, `decodeEvents` (dropped by `kronos-sdk`) replaced with `decodeEvent` + map/filter. Three source sites + three test sites.

---

## [0.1.0] — 2026-04-18

First published release. Feature-complete for the Kronos consumer; Fortuna deferred.

### Added

Phases D.1 → D.15, in ship order. Full per-phase narratives live in [`docs/phases.md`](docs/phases.md).

- **D.1** (`11574c9`) — scaffold: pnpm workspace, tsconfig strict + NodeNext, commander entry, jest preflight.
- **D.2** (`bdde95f`) — config: zod `ConfigSchema`, `paths.ts` as the single resolver, atomic file writes, env overlay with a narrow allow-list.
- **D.3** (`8989253`) — wallet: BIP-39 mnemonic, V5R1 (network-aware), scrypt + AES-256-GCM keystore, 6 tamper vectors.
- **D.4** (`e7cb8b9`) — chain transport: `FailoverTonClient` (endpoint ring + jittered backoff on transient errors), PID-based lockfile, startup schema check against SDK `STORAGE_VERSION` constants.
- **D.5** (`3fbeab7`) — `automaton init`: interactive + flag-driven first-run setup; idempotent (refuses to clobber).
- **D.6** (`25f673e`) — `automaton status` + `doctor` expansion: chain-aware doctor checks (colour-coded, skip-aware), best-effort status snapshot.
- **D.7** (`2cae898`) — `automaton stake <register|increase|request-unstake|cancel-unstake|withdraw>`: pre-state validation, seqno-advance confirm, post-state verify.
- **D.8** (`e62cd55`) — worker: pure `decide()` engine, `AutomatonMirror` cache, `runWorkerCycle(deps)` with single-flight guard and injectable `submitExecute`.
- **D.9** (`49f54d3`) — event subscriber: `drainEvents(deps)` + checkpoint (`state.json`) that survives restarts; built-in handlers (mirror patch, self-slash alert + webhook, consumer watch).
- **D.10** (`dd2a02b`) — daemon: `runDaemon` composes every primitive (lockfile → unlock → runtime → schema-check → handlers → loop → graceful shutdown), AbortSignal-driven timers, single-flight checkpoint flush.
- **D.11** (`ee3709e`) — observability: pino logger with structural redaction, prom-client bundle (counters + gauges + cycle histogram), `/metrics` + `/healthz` + `/readyz` HTTP server.
- **D.12** (`283b85c`) — error handling: `abortableRetry` + `jitteredBackoff`, `explainExitCode` unifying kronos/forgeton/tvm SDK tables, CLI top-level catch with raw error + explanation.
- **D.13** (`8418b3c`) — distribution: `prepublishOnly` pipeline, multi-arch distroless Docker image, `contrib/automaton.service` systemd unit + env template, dry-run-by-default `scripts/release.sh`.
- **D.14** (`b754054`) — operator docs: `README.md`, `docs/quickstart.md`, `docs/ops.md`, `docs/troubleshooting.md`, `AGENTS.md`.
- **D.15** (`73b1f0f`) — sandbox integration suite via `tests/helpers/chain.ts` + `tests/Integration.spec.ts`; `tests/DocsSurface.spec.ts` pins operator-facing docs against runtime surfaces.

### Known limitations

- **npm publish gated** on sibling SDK publication (`kronos-sdk` + `forgeton-sdk` are `file:` deps today). Docker + from-source work in the meantime.
- **Mainnet deployment** not yet live; `automaton` runs testnet-only today. Mainnet lands behind a one-line switch in `src/chain/deployment.ts`.
- **24 h testnet burn-in** remains a human-only task, outside the automated suite.

---

[Unreleased]: https://github.com/titon-network/automaton/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/titon-network/automaton/releases/tag/v0.1.0
