# Phase history — @titon/automaton

The automaton was built in 15 ordered phases (D.1 → D.15). This page preserves the per-phase summaries so `CLAUDE.md` stays focused on the *current* architecture rather than how we got here. Nothing here is operationally load-bearing — code + tests are the source of truth.

If you're here to understand the codebase, read [`../CLAUDE.md`](../CLAUDE.md) first; this file is context for "why is it like this?" questions.

## Phase summaries

- **D.1 (scaffold)** — done. `11574c9`.
- **D.2 (config + paths)** — done. `bdde95f`.
- **D.3 (wallet keystore)** — done. `8989253`. 6 tamper vectors.
- **D.4 (TON client layer)** — done. `FailoverTonClient` with retry/rotate on transient errors; `lockfile.ts` PID-based single-instance lock; `schema-check.ts` on-chain version reconciliation.
- **D.5 (init command)** — done. Interactive + flag-driven first-run setup: network + new/import wallet + password + keystore + config, all idempotent.
- **D.6 (status + doctor expansion)** — done. Chain runtime builder + deployment resolver; doctor gains RPC-reachable / balance / schema-match / consumer-admitted / lockfile checks (colour-coded, skip-aware); `automaton status` renders a full operator snapshot with best-effort chain reads.
- **D.7 (stake lifecycle)** — done. Five subcommands (register / increase / request-unstake / cancel-unstake / withdraw) sharing one `submit()` helper: unlock wallet, pre-check on-chain state, size the pool message, send + wait for seqno advance, print tx hash + explorer URL.
- **D.8 (Kronos worker)** — done. Pure `decide()` + `AutomatonMirror` cache + `runWorkerCycle(deps)` single-iteration loop with single-flight guard and injectable `submitExecute`.
- **D.9 (event subscriber)** — done. `drainEvents(deps)` tails registry + pool tx history, decodes external-out bodies via both SDKs, dispatches to pluggable handlers; `~/.titon/automaton/state.json` checkpoint survives restarts. Built-ins: mirror refresh on `AutomatonMirrorUpdated`, self-slash alerter (log + webhook + hook), consumer watcher.
- **D.10 (daemon)** — done. `runDaemon` composes lockfile + unlock + runtime + schema-check + handlers + timer loop + graceful shutdown. `abortableSleep` / `loopCycles` / `waitForDrain` primitives are cancellable and tested. SIGHUP reload deferred with a loud warn.
- **D.11 (logs + metrics + health)** — done. Pino logger with structural redaction, prom-client `DaemonMetrics` bundle (counters + gauges + cycle histogram), `startHealthServer` exposes `/metrics`/`/healthz`/`/readyz` on `config.metricsHost:metricsPort`. Gauges snapshot every Nth cycle (configurable via `gaugeSnapshotEveryNTicks`). Shared `collectChainSnapshot` used by status + daemon.
- **D.12 (error handling + backoff)** — done. `abortableRetry` + `jitteredBackoff` primitives; `explainExitCode` unifies kronos/forgeton/tvm SDK error tables; CLI top-level catch surfaces explanation under the raw error. Daemon installs `uncaughtException` + `unhandledRejection` handlers that log + trigger graceful shutdown.
- **D.13 (distribution)** — done. `prepublishOnly` + `smoke` npm scripts; multi-stage `Dockerfile` (alpine builder → distroless nonroot runtime, multi-arch); `contrib/automaton.service` systemd unit with full sandbox + `automaton.env.example`; `scripts/release.sh` dry-run-by-default release helper. Known limitation: `file:` SDK deps block actual `npm publish` until the SDKs are independently published.
- **D.14 (documentation)** — done. Operator-focused `README.md`; `docs/quickstart.md` (5-min testnet walk-through); `docs/ops.md` (systemd + Docker + key rotation + upgrade + backup + multi-region); `docs/troubleshooting.md` (every exit code + every common init/stake/run/preflight failure); `AGENTS.md` (AI-navigable quick reference matching kronos-sdk pattern).
- **D.15 (testing + testnet rehearsal)** — sandbox integration suite via `tests/helpers/chain.ts` + `tests/Integration.spec.ts` (end-to-end scenarios: never-executed happy path, 2-automaton rotation, fallback claim + slash, mirror handler, self-slash webhook, consumer watch, paused registry, multi-job, cancelled-job hole, checkpoint resume idempotence, handler-throw checkpoint guard, in-flight collision, expired, underfunded, execute-revert verify-failed). `tests/DocsSurface.spec.ts` pins operator-facing docs' metric names + config fields against runtime surfaces. `TickDeps` extended with optional `submitExecute` + `nowSec` for sandbox wiring. Manual 24 h testnet burn-in is a human-only task and remains outside the automated suite.

## DX hardening (post-D.15)

Ongoing: elite-level LLM navigation + developer velocity improvements.

- `--format json` on `doctor` + `status` for agent-driven verification.
- `pnpm run verify` / `pnpm run dev` / `pnpm run preflight` as single-command gates.
- Standalone `scripts/preflight.mjs` wired into `postinstall` + `tests/preflight.ts` (catches sibling-SDK landmines at install time, not just test time).
- `.claude/commands/` slash-command recipes for common tasks (`/new-subcommand`, `/new-metric`, `/new-handler`, `/new-config-field`, `/verify`, `/navigate`).
- Folder-level `README.md` stubs at `src/*/` pointing back to the CLAUDE.md navigator — bottom-up explorers never have to climb two levels to find the map.
- Phase history relocated here so `CLAUDE.md` stays lean and top-loadable.
