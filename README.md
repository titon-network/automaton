# @titon-network/automaton

[![verify](https://github.com/titon-network/automaton/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/titon-network/automaton/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](https://nodejs.org)

> **AI assistants / LLM-driven development — start here:** read [`AGENTS.md`](AGENTS.md) (compact quick reference) or [`CLAUDE.md`](CLAUDE.md) (full architecture + navigator tables). Task recipes live in [`.claude/commands/`](.claude/commands/). Every DX surface is catalogued on one page at [`docs/dx.md`](docs/dx.md). Single-command gate: `pnpm run verify`. Machine-readable CLI: `automaton doctor --format json` · `automaton status --format json`.

The off-chain operator node for the [Titon](https://github.com/titon-network) protocol suite on TON.

Stake once with [ForgeTON](https://github.com/titon-network/forgeton) (shared-security staking pool) and earn from every admitted consumer product — Kronos automation (always-on baseline) and Fortuna VRF (opt-in via `products.fortuna`); future products (oracles, functions) plug into the same `ProductModule` registry.

> 🛡️ **Built on TSA-audited contracts — zero findings each.** Every protocol the automaton talks to has cleared symbolic-execution audit: [ForgeTON](https://github.com/titon-network/forgeton/blob/main/tsa-analysis/AUDIT_REPORT.md), [Atlas](https://github.com/titon-network/atlas/blob/main/tsa-analysis/AUDIT_REPORT.md), [Kronos](https://github.com/titon-network/kronos/blob/main/tsa-analysis/AUDIT-REPORT.md), [Fortuna](https://github.com/titon-network/fortuna/blob/main/AUDIT_REPORT.md). Pinned SDKs: `forgeton-sdk@0.8.1` · `atlas-sdk@0.2.0` · `kronos-sdk@0.8.2` · `fortuna-sdk@0.3.1`.

> **Enabling Fortuna?** There's a one-time prerequisite operators don't control: Atlas (Fortuna's BLS group-key substrate) must be admitted as a ForgeTON consumer by the pool owner. Without that step, `automaton bls register` reverts with `OperatorNotFound (120)`. See [`docs/deploy.md` §Enabling Fortuna VRF](docs/deploy.md#enabling-fortuna-vrf) for the full chain.

**Need to deploy?** Jump to [`docs/deploy.md`](docs/deploy.md) — five-path decision tree (playground / local testnet / AWS Lightsail / self-hosted Docker / self-hosted systemd) with verbatim commands and a common-errors table. AI assistants helping a user: that's the canonical entry point.

**Try it on your laptop in 30 seconds — no testnet, no faucet, no wallet:**

```bash
npx @titon-network/automaton playground --ticks 5
```

This boots an in-process sandbox blockchain, deploys the **full** Titon stack (ForgeTON + Kronos + Atlas + Fortuna), registers a single demo automaton, and runs the real daemon code path against it — so you can watch the same operator earn from BOTH Kronos automation jobs AND Fortuna VRF fulfillments before staking anything real. Pass `--no-fortuna` for a Kronos-only run (~3s faster boot).

When you're ready to run against testnet:

```
automaton init          # first-run setup: wallet, network, config
automaton stake register 10   # register on-chain with 10 TON stake
automaton run           # start the daemon
```

That's the happy path. The rest of this README covers installation, configuration, and operations.

---

## Install

Four ways to get the `automaton` binary. Pick one.

### npm (Node.js ≥ 22)

```bash
npm install -g @titon-network/automaton
automaton --version
```

### Docker

```bash
docker run --rm titon/automaton:latest --version
```

A full daemon run (assuming you've run `automaton init` on the host and mounted the resulting directory):

```bash
docker run -d \
  --name automaton \
  --restart unless-stopped \
  -v ~/.titon:/home/nonroot/.titon:rw \
  -e AUTOMATON_PASSWORD=...your-keystore-password... \
  -p 127.0.0.1:9090:9090 \
  titon/automaton:latest run
```

The image is built from [distroless/nodejs22](https://github.com/GoogleContainerTools/distroless), runs as UID 65532 (`nonroot`), and ships multi-arch (amd64 + arm64). Full details in [docs/ops.md](docs/ops.md).

### AWS via Terraform

[`contrib/aws/lightsail/`](contrib/aws/lightsail/) ships a ready-to-apply Lightsail module (~$3.50/mo `nano_3_0`, ~$5/mo `micro_3_0` for the Fortuna leg). Keystore-mode bootstrap — operator runs `automaton init` locally first, mnemonic never enters AWS. Optional `bls_keystore_file` knob enables Fortuna VRF alongside Kronos. End-to-end in ~3 minutes for `terraform apply` plus the testnet faucet wait. See [`contrib/aws/lightsail/README.md`](contrib/aws/lightsail/README.md) for the full quickstart, sizing guide, and security trade-offs.

For larger mainnet positions where the keystore should NOT ride in Terraform state, prefer self-hosted systemd or Docker with a managed-secrets backend of your choice — see [`docs/deploy.md`](docs/deploy.md) for the full path matrix.

### From source

```bash
# Clone all five sibling repos — automaton's package.json uses
# `file:../<repo>/sdk` for in-repo dev, so they need to live as
# siblings.
mkdir titon && cd titon
for repo in forgeton atlas kronos fortuna automaton; do
    git clone "https://github.com/titon-network/$repo.git"
done

# Build SDKs in dep order, then automaton.
for sdk in forgeton/sdk atlas/sdk kronos/sdk fortuna/sdk; do
    (cd "$sdk" && pnpm install && pnpm run build)
done
cd automaton
pnpm install
pnpm run build
./dist/cli/index.js --version
```

pnpm resolves sibling SDK dependencies via `file:` links and copies their built `dist/` at install time — that's why the SDKs need to be built first (their `dist/` is what automaton's install snapshots).

---

## Quickstart

**Goal:** first execution reward on testnet, in under 5 minutes.

See [docs/quickstart.md](docs/quickstart.md) for the full walk-through. The short version:

```bash
# 1. Scaffold ~/.titon/automaton/ (wallet + config)
automaton init --network testnet

# 2. Fund the wallet printed at the end of init — you need ≥ 11 TON
#    (10 stake minimum + 1 for gas). Testnet faucet:
#    https://t.me/testgiver_ton_bot
automaton doctor  # verify the install

# 3. Register as an automaton on-chain
automaton stake register 10

# 4. Start the daemon — executes due jobs, tails slash events
automaton run
```

The daemon prints one JSON line per event to stdout and exposes Prometheus metrics + health probes at `http://127.0.0.1:9090/metrics` · `/healthz` · `/readyz`.

---

## Subcommands

<!-- DRIFT GUARD: when adding/removing a subcommand, also update AGENTS.md §Quick reference (task→command lookup) and src/cli/index.ts (command registration). -->

| Command | What it does |
|---|---|
| `automaton playground` | Local simulation. Boots an in-process sandbox, deploys the full Titon stack (ForgeTON + Kronos + Atlas + Fortuna), registers a demo automaton, and runs the real daemon tick path so the same operator earns from both Kronos jobs and Fortuna VRF fulfillments. Pure local — no internet, faucet, or wallet required. Flags: `--ticks N`, `--tick-interval <ms>`, `--job-interval <s>`, `--jobs N`, `--no-fortuna`, `--json`. |
| `automaton init` | First-run setup. Creates `~/.titon/automaton/{config.json, wallet.enc}`. Interactive by default; pass `--network`, `--import-mnemonic <file>`, `--password-file <file>`, `--rpc-url <url>`, `--rpc-api-key <key>` for fully non-interactive CI runs. See [docs/ops.md §Choosing an RPC](docs/ops.md#choosing-an-rpc) for endpoint trade-offs. |
| `automaton doctor` | Install + runtime preflight — Node version, SDK resolvability, config/keystore presence, RPC reachability, balance vs `minFreeBalance`, schema-version match, lockfile status. Exits non-zero on any failure; skips chain-dependent checks when no deployment is live (mainnet today). `--format json` for agent-parseable output. |
| `automaton status` | Read-only operator snapshot — network, wallet balance, automaton registration (stake / slashCount / registered-at), pool active-count, drift counters, endpoint ring, lockfile. Best-effort chain reads; transient errors land in a footer. `--format json` emits a stable machine-readable payload (bigints encoded as `{nano, ton}` pairs; endpoint apiKeys stripped). |
| `automaton stake register <amount>` | First-time registration with `<amount>` TON collateral. Pool minimum is 10 TON; operator-wallet must additionally hold ~0.07 TON for gas + consumer-fan-out. |
| `automaton stake increase <amount>` | Top up the staked collateral. Refuses if not registered, inactive, or unstake pending. |
| `automaton stake request-unstake` | Start the cooldown (default 24 h on ForgeTON). Stake stays locked until `withdraw`. |
| `automaton stake cancel-unstake` | Abort a pending unstake and stay active. |
| `automaton stake withdraw` | Finalize after the cooldown — returns the full stake to the wallet. |
| `automaton bls keygen [--force]` | Generate a fresh BLS12-381 secret for Fortuna VRF, encrypt to `~/.titon/automaton/bls.enc` under the same password as the wallet (v1 same-password model). `--force` overwrites without confirmation. Required only when `products.fortuna` is enabled. |
| `automaton bls pubkey` | Print the 48-byte G1 pkShare from `bls.enc`. No password required (plaintext header). |
| `automaton bls register [--group-id <id>]` | Submit `RegisterBlsShare` to Atlas. Pre-checks ForgeTON-active state. Reverts with `OperatorNotFound (120)` if Atlas isn't yet admitted as a ForgeTON consumer — see [docs/troubleshooting.md](docs/troubleshooting.md). |
| `automaton bls deregister [--group-id <id>]` | Submit `DeregisterBlsShare` to Atlas. Removes the pkShare from the active group. |
| `automaton run` | Start the daemon. Foreground; use systemd or Docker to daemonize. Signals: `SIGTERM`/`SIGINT` = graceful shutdown (drains in-flight txs, flushes state); `SIGHUP` = warn-and-ignore (restart to reload config). `--log-level` overrides `config.logLevel`. |
| `automaton config show` | Inspect the effective config (file + env overlay), with env overrides surfaced as a delta block. `--format json` dumps a stable payload (apiKeys redacted). Read-only. |
| `automaton config edit` | Open the config in `$EDITOR` (or `--editor=<cmd>`), then re-run the zod validator on save. Offers to re-open on validation failure. |
| `automaton config validate [path]` | Dry-run validate a config file against the zod schema. Useful before restarting the daemon with a hand-edited config. `--format json` available. |
| `automaton completion <shell>` | Print a bash / zsh / fish completion script. Install with `eval "$(automaton completion bash)"` or dump to your shell's fpath. |

Every subcommand accepts `--help`.

---

## Configuration

Config lives at `~/.titon/automaton/config.json` (or `$AUTOMATON_CONFIG`, or under `$TITON_HOME/automaton/`). Generated by `automaton init`; hand-editable afterwards.

| Field | Type | Default | Purpose |
|---|---|---|---|
| `configVersion` | 1 | — | Schema-version; loaders reject mismatch. Bump on any field change. |
| `network` | `'testnet'` \| `'mainnet'` | — | Which chain to run against. Wallets are network-aware (different address per network for the same mnemonic); set this correctly at `init` time. |
| `endpoints` | array of `{url, apiKey?}` | toncenter | Failover ring. Daemon rotates on transient errors (timeouts, 429, 5xx). Public toncenter is rate-limited without an API key (~1 req/s) — fine for testnet, swap in a paid endpoint or self-hosted `ton-http-api` for mainnet. Set at `init` time via `--rpc-url`/`--rpc-api-key`, or hand-edit. See [docs/ops.md §Choosing an RPC](docs/ops.md#choosing-an-rpc). |
| `walletVersion` | `'v5r1'` | `'v5r1'` | TON wallet contract version. Only V5R1 is supported today. |
| `metricsPort` | number | `9090` | Bind port for `/metrics` · `/healthz` · `/readyz`. |
| `metricsHost` | string | `'127.0.0.1'` | Bind host. Keep local for systemd installs; flip to `'0.0.0.0'` for Docker publishes. |
| `pollIntervalMs` | number | `10_000` | Main-loop poll interval. Also the staleness threshold for `/healthz` (= 2× this value, floor 10 s). |
| `gaugeSnapshotEveryNTicks` | number | `6` | Refresh Prometheus gauges (balance / stake / drift) every Nth tick. Default ~60 s at the default tick. Lower for faster dashboards; higher to reduce RPC quota. |
| `alertWebhookUrl` | url | (unset) | Webhook POSTed on self-slash (fire-and-forget, 5 s timeout). JSON body includes `txHash`; consumers should dedupe on it. |
| `maxGasPerExecute` | TON | `'0.5'` | Per-execute gas ceiling. |
| `minFreeBalance` | TON | `'2.0'` | `automaton doctor` warns below this. |
| `logLevel` | `trace` \| `debug` \| `info` \| `warn` \| `error` | `info` | Pino log level. `--log-level` flag overrides. |
| `products.kronos` / `products.fortuna` | bool | `true` / `false` | Enable per-consumer workers. Flipping `products.fortuna: true` requires a `bls.enc` keystore on disk (`automaton bls keygen`) and the BLS share to be registered at Atlas (`automaton bls register` after `stake register`). |

Env-var overrides for the common toggles: `AUTOMATON_NETWORK`, `AUTOMATON_METRICS_PORT`, `AUTOMATON_LOG_LEVEL`, `AUTOMATON_PASSWORD`, `TITON_HOME`, `AUTOMATON_CONFIG`.

---

## Operations

**Metrics.** The daemon exposes Prometheus metrics at `http://<metricsHost>:<metricsPort>/metrics`. Every counter/gauge/histogram is declared in one place ([`src/daemon/metrics.ts`](src/daemon/metrics.ts)) with a `help` string; the names follow `automaton_<subsystem>_<metric>[_unit]`. See [docs/ops.md](docs/ops.md#metrics) for Grafana pointers.

**Health probes.**
- `/healthz` → 200 iff the last poll cycle completed within `2 × pollIntervalMs` (floor 10 s). Use as a Kubernetes liveness probe or systemd watchdog.
- `/readyz` → 200 iff lockfile held + wallet unlocked + stake active + RPC reachable. Body lists per-check detail. Use as a Kubernetes readiness probe.

**Logs.** JSON lines on stdout via [pino](https://getpino.io). `warn` + `error` go to stderr. Redacted fields: `password`, `mnemonic`, `privateKey`, `seed`, `secretKey` (top-level + one level deep). Stream via `journalctl -u automaton -f` under systemd, or `docker logs -f` under Docker.

**Shutdown.** `SIGTERM` or `SIGINT` triggers graceful shutdown: stop accepting new work, wait up to 30 s for in-flight Execute txs to confirm, flush event checkpoint, release lockfile, exit 0. A second signal hard-exits with code 130 (for operators hammering Ctrl-C). systemd units should give ≥ 45 s `TimeoutStopSec`.

**Exit codes.** `0` = clean shutdown. `1` = crash. `75` = lockfile held by another instance (`EXIT_LOCK_HELD`; systemd uses `RestartPreventExitStatus=75` to avoid respawn loops). `130` = force-exit on double signal.

Full operational reference: [docs/ops.md](docs/ops.md).
Troubleshooting: [docs/troubleshooting.md](docs/troubleshooting.md).

---

## Architecture

The daemon is a composition of small, independently testable pieces:

```
automaton run
  ├── lockfile (single-instance)
  ├── keystore unlock (scrypt + AES-256-GCM)
  ├── chain runtime  (FailoverTonClient + opened Kronos registry + ForgeTON pool)
  ├── schema check   (refuses to start on SDK/contract version drift)
  ├── event drain    (tails registry + pool tx history; dispatches to handlers)
  ├── worker loop    (decide → submit Execute → verify via executionCount delta)
  ├── metrics + pino (prom-client /metrics + redacted JSON logs)
  └── health server  (/healthz + /readyz + /metrics on config.metricsHost:metricsPort)
```

Design decisions are documented at the top of each module. [CLAUDE.md](CLAUDE.md) is the navigator — start there if you want to contribute.

---

## License

[MIT](LICENSE).

## Contributing

Issues + PRs welcome at [github.com/titon-network/automaton](https://github.com/titon-network/automaton). New to the codebase? [CLAUDE.md](CLAUDE.md) has the AI + human navigator tables; [AGENTS.md](AGENTS.md) is the compact version for scripted tools.
