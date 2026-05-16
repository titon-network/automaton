# AGENTS.md — @titon-network/automaton

> AI assistants reading this: this is your map of the `automaton` CLI + daemon. Skim the **Quick reference**, then jump to the section the user is asking about. Full architecture + design rationale lives in [CLAUDE.md](CLAUDE.md).

`@titon-network/automaton` is the off-chain operator node for the [Titon](https://github.com/titon-network) protocol suite on TON. One binary (`automaton`) wraps wallet management, on-chain lifecycle, and a long-running daemon that polls the Kronos registry + executes due jobs + tails pool events.

> **Contract logic lives elsewhere.** Registry + pool behaviour, opcode ranges, error codes, gas math — those are in `../kronos/` and `../forgeton/`. This repo owns the off-chain side only.

## Quick reference

<!-- DRIFT GUARD: when adding/removing a subcommand, also update README.md §Subcommands (operator-facing catalogue) and src/cli/index.ts (command registration). -->

**Helping a user deploy?** [`docs/deploy.md`](docs/deploy.md) is the decision tree — "user says X" → path → verbatim commands. Six paths covered (playground, local testnet, **AWS EC2 (mainnet, SSM-backed, multi-op-ready)**, AWS Lightsail (testnet/canary), self-hosted Docker, self-hosted systemd) plus a common-errors table. Read that first if the question is "how do I get this running". Mainnet → EC2 module at [`contrib/aws/ec2/`](contrib/aws/ec2/), team-published image at `public.ecr.aws/b0k9s4w3/automaton:0.8.0` (built from the audited-SDK-pinned codebase).

**Helping a user enable Fortuna VRF?** Two onboarding shapes:
- **Solo-mode (testnet / dev only)** — `t=1, n=1`, single operator, `pkShare == groupPk` invariant, single point of forgery. Atlas's `publishSoloGroupKey:testnet` ceremony script. Mainnet is **deliberately blocked** by the script. Load [`docs/fortuna-solo-mode.md`](docs/fortuna-solo-mode.md) for the operator-first runbook + the two gotchas (Atlas-admission, pkShare==groupPk equality, atlas-owner balance).
- **Multi-op (mainnet)** — `t = n` additive threshold-BLS, ≥ 2 operators sign + exchange partials over peer HTTP, leader (lowest UQ-form addr) aggregates + submits. **No single point of forgery** — the group secret is never assembled anywhere. Atlas's `publishMultiOpGroupKey:mainnet` ceremony script. Daemon-side: `config.fortuna.peers` non-empty → multi-op flow auto-engages. EC2 module's `peer_ips` opens TCP/9091 between operators. Load [`docs/multi-op-fortuna.md`](docs/multi-op-fortuna.md) for the protocol spec; [`docs/multi-op-fortuna.md`](docs/multi-op-fortuna.md) §"Operator setup" for the six-step ceremony — generate share locally, hand pkShare to Atlas owner, owner publishes aggregate `groupPk`, every operator runs `bls register`, configs include `peers` block, EC2 SG opens TCP/9091 between operator EIPs, smoke via `fortuna/scripts/coinFlipMainnetE2E.ts`. (The team also keeps a workspace-local `automaton-mainnet/RUNBOOK.md` next to its terraform state for its own two-region deployment, but that's team-internal — not part of the public docs tree.)

**Helping a user enable Themis (sealed-bid threshold-decryption)?** v1 is **solo-mode only** + **static configured chamber list**. Onboarding: (1) the Fortuna prerequisite chain — `automaton bls keygen` produces a `bls.enc` whose secret IS the Atlas group key in solo-mode (no separate Themis key); the Atlas owner publishes the operator's pkShare as `groupPk`. (2) Themis-specific: the **Themis factory** must be admitted as a ForgeTON consumer + Atlas verifier (one-time, owner-driven) so it receives `AutomatonSync` (mirrors operators) + `GroupKeySync` (caches groupPk) and fans both out to its chambers. (3) Operator side: flip `products.themis: true` and list every chamber the operator wants to serve under `config.themis.chambers: ["EQ…", "EQ…"]`. The factory deploys multiple chambers (one per consumer protocol — sealed AMMs, auctions, governance votes); operators opt into specific chambers explicitly in v1. Per-chamber operator state is mirrored automatically via factory fan-out; the worker confirms via `getOperator(self)`. Once the commit window closes (`now >= commitEta`) and reveal window is open (`now < revealEta`), the worker threshold-decrypts cached bids and submits `RevealRound` with revealer reward → operator. Skip reasons surfaced in logs: `not-mirrored` (factory hasn't fanned out yet — bounded by `cfg.maxFanoutPerSync`; or call factory's permissionless `RebroadcastGroupKey`), `no-group-key` (chamber hasn't received `GroupKeySync` yet), `commit-still-open` (wait for `commitEta`), `reveal-deadline-passed` (`AdvanceRound` will refund bidders). Auto-discovery from the factory's `EvtChamberDeployed` events + multi-op share-exchange (mirrors Fortuna's `:9091` flow on `:9093`) are deferred to v1.1 (themis PLAN §Phase 3c-3e).

**Helping a user enable Phoebe (price oracle)?** Same Fortuna BLS prerequisite chain (one `bls.enc` covers all three products). Onboarding: (1) flip `products.phoebe: true`. (2) Populate `config.phoebe.feeds[]` — two shapes accepted: **static** `{feedId, mantissa, expo, confBps}` (operator hand-sets values; ergonomic for testnet/dev) OR **dynamic** `{feedId, sources: [{name, symbol}, ...], minSources?, maxStaleMs?, expo?}` (production: live aggregation from CEX websockets — currently `binance`, `coinbase`, `kraken` — plus `stonfi-twap` DEX fallback; median across fresh ticks, half-spread → `confBps`). **Combo caveat**: multi-op + dynamic feeds is **best-effort** — operators receive ticks asynchronously, so per-operator median can drift → BLS partials fail to aggregate → leader-grace fallback fires and one operator submits alone (the snapshot still lands, but the threshold-attestation guarantee is lost for that window). For strict t=n attestation in multi-op, use static feeds today; a propose/ratify coordination round is v2.1. The same `sources` list MUST still be configured identically across the multi-op group (a config drift on top of the natural tick-set drift would make divergence worse). Per-source symbols are exchange-native: Binance `TONUSDT`, Coinbase `TON-USD`, Kraken `TON/USD`. (3) Solo-mode (testnet): leave `config.phoebe.peers` empty; the operator's single partial IS the aggregate. Multi-op (mainnet): populate `config.phoebe.peers` with peer addresses + share-exchange endpoints — share-exchange runs on TCP/9092 (avoids fortuna's :9091 collision). The worker rounds `now` to the next `pushIntervalSec` window boundary (default 30s) so all operators independently sign byte-identical `(phoebeAddress, timestamp, root)` triples without out-of-band consensus — requires synchronised clocks (within `maxDriftSec`, default 60s) AND identical `feeds[]` config across operators. Skip reasons in logs: `no-feeds`, `cadence`, `awaiting-shares`, `awaiting-group-epoch`, `non-leader-grace`, `paused`. Dynamic feed missing quorum → `dropping dynamic feed (no quorum)` log + that feed simply isn't included in the snapshot (rather than signing stale data — safer than the alternative).

Prerequisite chain (both shapes): stake at ForgeTON → Atlas admitted as a ForgeTON consumer (one-time, ForgeTON-owner-driven; see `../atlas/sdks/typescript/skills/atlas-deploy.md` §Step 2) → `automaton bls keygen` → Atlas owner publishes `groupPk` → flip `products.fortuna: true` in config → `automaton bls register`. Two error codes operators trip on: `OperatorNotFound (120)` = Atlas not in ForgeTON consumer set; `E_SOLO_PK_SHARE_MISMATCH (161)` = published groupPk ≠ operator's local pkShare (only fires when `memberCount=1`; multi-op groups skip this check).

| User wants to… | Command / entry point |
|----------------|------------------------|
| Try it locally — zero install state, in-process sandbox simulation | `automaton playground [--ticks N]` (also `npx @titon-network/automaton playground`) |
| Scaffold a fresh install (wallet + config) | `automaton init [--network testnet] [--import-mnemonic <f>] [--password-file <f>]` |
| Verify the install | `automaton doctor` — install + config + chain + lockfile layers; add `--format json` for agent parsing |
| See operator state at a glance | `automaton status` — balance, registration, drift, endpoints; add `--format json` for stable machine-readable output |
| Register on-chain with stake | `automaton stake register <amount>` |
| Top up existing stake | `automaton stake increase <amount>` |
| Start the cooldown + withdraw later | `automaton stake request-unstake` → wait → `automaton stake withdraw` |
| Abort a pending unstake | `automaton stake cancel-unstake` |
| Generate the BLS keystore (Fortuna identity) | `automaton bls keygen` (uses wallet password by default) |
| Show the pkShare without unlocking | `automaton bls pubkey` |
| Register the BLS share at Atlas | `automaton bls register` (after `stake register` AND Atlas admitted at ForgeTON) |
| Remove the BLS share from Atlas | `automaton bls deregister` |
| Run the daemon (poll + execute) | `automaton run [--log-level info]` |
| Inspect the effective config + env overlay | `automaton config show [--format json]` |
| Edit the config in $EDITOR with re-validation on save | `automaton config edit [--editor <cmd>]` |
| Dry-run validate a config file | `automaton config validate [path] [--format json]` |
| Install shell completion | `eval "$(automaton completion bash)"` (or `zsh` / `fish`) |
| Do any of the above non-interactively | Every prompt has an equivalent flag; `AUTOMATON_PASSWORD` env bypasses the password prompt |
| Scrape Prometheus metrics | `http://127.0.0.1:9090/metrics` |
| Liveness / readiness probes | `/healthz` (staleness-gated) · `/readyz` (lockfile + wallet + stake + rpc subchecks) |

## File map

```
src/
  cli/
    index.ts                     # commander entry (bin → dist/cli/index.js); top-level error surface + explainExitCode
    commands/{init,doctor,status,stake,run,config,completion,bls,playground,explain}.ts
                                 # bls = Fortuna identity (keygen/pubkey/register/deregister)
                                 # playground = local sandbox demo (full Titon stack in-process)
                                 # explain = TVM exit-code lookup
    prompt.ts                    # readline text/choice/confirm (non-TTY throws NotInteractiveError)
    version.ts                   # reads package.json at runtime
  bls/                           # BLS12-381 identity for Fortuna + Themis (one shared secret)
    keystore.ts                  # bls.enc — scrypt+AES-GCM mirror of wallet.enc; plaintext pkShare for pubkey w/o password
    index.ts                     # barrel; re-exports randomBlsSecret/signAlpha/blsPublicKey from fortuna-sdk
  playground/                    # local sandbox simulation — `automaton playground` + integration-test harness
    sandbox-runtime.ts           # createSandboxHarness({ withFortuna }) — deploys ForgeTON+Kronos always; +Atlas+Fortuna optional
    demo.ts                      # runPlayground — pretty / json TUI; hand-builds Kronos/Fortuna workers against the harness
  config/
    schema.ts                    # zod Config + Network + LogLevel + defaultConfig
    paths.ts                     # every file path lives here (TITON_HOME, ~/.titon)
    load.ts                      # loadConfig/saveConfig + applyEnvOverlay
  wallet/
    mnemonic.ts wallet.ts        # BIP-39 + WalletContractV5R1 (network-aware derivation)
    keystore.ts                  # scrypt + AES-256-GCM, schema-versioned
    prompt.ts                    # hidden-input password prompt + AUTOMATON_PASSWORD env
  products/                      # PRODUCT MODULE REGISTRY — drop-in pluggability
    types.ts                     # ProductModule + EventSource + ProductWorker + SchemaCheckTask interfaces
    kronos.ts                    # ProductModule for Kronos automation + KronosWorker
    fortuna.ts                   # ProductModule for Fortuna VRF
    themis.ts                    # ProductModule for Themis sealed-bid threshold-decryption
    phoebe.ts                    # ProductModule for Phoebe price oracle
    index.ts                     # PRODUCTS = [kronos, fortuna, themis, phoebe] + enabledProducts + findProduct
    # add src/products/argus.ts (indexer), … here
  chain/
    ton-client.ts                # FailoverTonClient — endpoint ring + jittered backoff
    deployment.ts                # resolveDeployment — baseline + iterates PRODUCTS for product addresses
    runtime.ts                   # buildChainRuntime — baseline + iterates PRODUCTS for opened contracts
    schema-check.ts              # startup gate — baseline + iterates PRODUCTS for schema tasks
    submit.ts                    # senderFor + sendAndConfirm (seqno wait + post-state verify)
    stake-cost.ts                # pool message-value calculators
    snapshot.ts                  # collectChainSnapshot — shared by status + daemon
    lockfile.ts                  # acquireLock/releaseLock + describeLock (with liveness probe)
  worker/
    decide.ts                    # pure decision engine (every reason tag bounded)
    mirror.ts                    # AutomatonMirror cache; consumed by KronosWorker
    loop.ts                      # runWorkerCycle (bounded fan-out, single-flight guard); used by KronosWorker
    events.ts                    # drainEvents (data-driven from EventSource[]); EventHandler.on map
    baseline-sources.ts          # baseline pool EventSource wrapper (only always-on stream)
    handlers.ts                  # ForgeTON-baseline handlers: selfSlash / consumerWatch / forgetonAwareness / forgetonHealth
    fortuna.ts                   # FortunaWorker — VRF fulfillment (per-product workers live in src/products/ now)
    themis.ts                    # ThemisWorker — per-chamber round/bid state + reveal submission
                                 #   exports chamberSourceKey, themisChamberAddrKey, isThemisChamberKey helpers
    phoebe.ts                    # PhoebeWorker — heartbeat-pushed Merkle snapshot (solo + multi-op)
    checkpoint.ts                # state.json load/save (zod-validated, atomicWriteFile)
  errors/
    backoff.ts                   # jitteredBackoff + defaultSleep (the two shared retry primitives)
    explain.ts                   # unified SDK exit-code explainer
  daemon/
    logger.ts                    # pino with structural redaction (password/mnemonic/privateKey/seed)
    loop.ts                      # abortableSleep / loopCycles (backoff) / waitForDrain
    metrics.ts                   # prom-client Registry (counters + gauges + histogram)
    http.ts                      # startHealthServer — /metrics /healthz /readyz
    orchestrator.ts              # runDaemon composition — lockfile → unlock → … → loop → graceful shutdown
  util/
    atomic-write.ts              # tmp + chmod + rename (used by config, keystore, state)
contrib/
  automaton.service              # systemd unit (sandbox + EXIT_LOCK_HELD handling)
  automaton.env.example          # /etc/automaton.env template
  aws/lightsail/                 # Terraform module — Kronos baseline + optional Fortuna leg
                                 # via bls_keystore_file. Smoke-tested on the testnet canary.
Dockerfile                       # multi-stage: node:22-alpine builder → distroless nonroot
.dockerignore                    # relative to PARENT build context
scripts/
  release.sh                     # dry-run-by-default release helper
  check-shebang.mjs              # postbuild guard
tests/                           # jest specs (+ DocsSurface.spec.ts drift guard + Integration.spec.ts sandbox)
docs/
  quickstart.md ops.md troubleshooting.md
```

## Common task recipes

### Add a new subcommand

```ts
// src/cli/commands/mycmd.ts
import { Command } from 'commander';
export function registerMyCmdCommand(program: Command): void {
    program.command('mycmd')
        .description('…')
        .action(async () => { /* … */ });
}
// then register in src/cli/index.ts
```

The CLI top-level catch in `src/cli/index.ts` already renders raw `err.message` + attempts `extractExitCode(err)` → `formatExplanation(explainExitCode(code))`. Throw typed errors from `src/chain/submit.ts` / `src/cli/commands/stake.ts` for clean surfaces.

### Add a new metric

```ts
// src/daemon/metrics.ts — add to createDaemonMetrics()
const myCounter = new Counter({
    name: 'automaton_my_thing_total',
    help: 'Short, clear explanation with units.',
    labelNames: ['tagA', 'tagB'] as const,    // must be bounded enums
    registers: [registry],
});
// return it on the `gauges` / `counters` field
```

Every new metric lands in one place; prefix `automaton_`; document the bounded labels.

### Send a tx through `sendAndConfirm`

Every chain submission funnels through `src/chain/submit.ts › sendAndConfirm`. The non-obvious required option is `origin`:

```ts
await sendAndConfirm(client, wallet, send, {
    verify: async () => { /* post-state check; throw to signal pool rejection */ },
    origin: 'atlas',  // ← REQUIRED — names the SDK whose explainError table interprets revert codes
});
```

Why it matters: code 120 means three different things in kronos / fortuna / atlas. Without `origin`, the explainer's priority walk picks the wrong SDK. Also, when `verify` fails without an exit code in its inner exception (the verify-state-mismatch case — Atlas's silent revert is the canonical example), `sendAndConfirm` does a one-shot inspection of the destination contract's recent txs to recover the actual exit code; this only fires when `origin` is set.

`PoolRejectedError` carries `{ exitCode, explainHint }` as fields (NOT in `.message`); the CLI's top-level catch reads them via `extractExitCode` + `extractExplainHint` and renders `formatExplanation(explainExitCode(code, hint))` separately so we don't double-print.

Drift guard: `tests/DocsSurface.spec.ts › sendAndConfirm callers pass origin` greps `src/` and fails on any caller missing the option.

### Add an event handler

```ts
// Baseline (ForgeTON-only) → src/worker/handlers.ts
// Per-product → src/products/<name>.ts (called from buildHandlers)
import type { EventHandler } from '../worker/events';
export function myHandler(…): EventHandler {
    return {
        on: {
            // Source key per stream — 'pool' (ForgeTON), 'registry' (kronos),
            // 'fortuna' (fortuna), THEMIS_FACTORY_SOURCE / chamberSourceKey(addr)
            // for themis. The events drain dispatches `decoded events` keyed by
            // `EventSource.source`; missing keys are silently skipped.
            pool:     (event, ctx) => { /* ForgetonEvent */ },
            registry: (event, ctx) => { /* KronosEvent */ },
            fortuna:  (event, ctx) => { /* FortunaEvent */ },
        },
        onCycleEnd() { /* flush debounced work once per drain */ },
    };
}
// Wire into src/daemon/orchestrator.ts buildHandlers(...) for baseline,
// or contribute via ProductModule.buildHandlers for per-product handlers.
```

Handlers are per-cycle isolated (one throw doesn't abort the batch); use `onCycleEnd` for debounced side-effects (the mirror patcher uses it to collapse a burst into one `refresh()`). For dynamic-source-set products like Themis (one source per configured chamber), iterate the chamber list at handler-build time and register `on[chamberSourceKey(addr)]` explicitly — `src/products/themis.ts` is the reference shape.

### Plumb a new config field

1. Add to `ConfigSchema` in `src/config/schema.ts` (with `.optional()` + default in `defaultConfig`).
2. If runtime-tunable, add env-var overlay in `src/config/load.ts`'s `applyEnvOverlay`.
3. Bump `CONFIG_VERSION` in the same file if the field is required or changes semantics.
4. Update the table in `README.md` §Configuration.

### Read on-chain state off the tick path

```ts
import { buildChainRuntime, collectChainSnapshot } from './chain';
const runtime = buildChainRuntime(config);
const snap = await collectChainSnapshot(runtime, walletAddr, {
    includeSchema: true,        // adds storageVersion reads
    preflightProbe: true,       // getMasterchainInfo bail if unreachable
});
// snap.automaton is AutomatonInfo | null | undefined (null=not registered, undef=RPC failed)
```

## Debugging symptoms → first place to look

| Symptom | Look at |
|---|---|
| `PREFLIGHT FAILED — ../<sdk>/.../node_modules exists` | `rm -rf ../kronos/sdks/typescript/node_modules ../forgeton/sdks/typescript/node_modules` — someone ran `pnpm install` in a sibling SDK, breaking `@ton/core` instanceof |
| `automaton is already running: pid X …` | Check the pid (`ps -p X`); if dead, `rm ~/.titon/automaton/automaton.lock` (EXIT_LOCK_HELD = 75) |
| `automaton bls register` reverts with `OperatorNotFound (120)` | Atlas isn't admitted as a ForgeTON consumer — its operator map for the wallet is empty. Verify with `pool.getConsumer(<atlas-addr>) === null`. Fix: ForgeTON owner runs `forgeton/scripts/admitConsumer.ts` to admit the Atlas address; if operators predate the admission, also run `ForceSync` per operator. See `../atlas/sdks/typescript/skills/atlas-deploy.md` §Step 2 + 2.5. |
| `contract schema mismatch — refusing to start` | `automaton status` tells you which side is ahead; upgrade `@titon-network/automaton` (contract newer) or wait for deploy (SDK newer) |
| `keystore integrity check failed — stored address … does not match derived address …` | Someone edited the plaintext `network` field in `wallet.enc`; restore it — address is deterministic from `(mnemonic, network)` |
| `all N endpoint(s) failed after M attempt(s)` | RPC outage or rate limiting; check network + API keys; add more endpoints |
| `the wallet tx landed but the pool rejected the internal message` | `PoolRejectedError` — explanation printed underneath names the pool error; `automaton status` shows current state |
| `seqno advanced but the wallet-initiated tx could not be located` | `TxAttributionError` — race with an incoming transfer; check the explorer, rerun if needed |
| `cycle threw — continuing loop` | Transient error; the exponential backoff caps flood at 60 s; investigate persistent causes via the `error` field |
| CLI command exits 0 with **no output**, no error, ~1s wall time, even though chain reads are clearly retrying (e.g. against a rate-limited endpoint) | Sleep ref-ness regression — someone added a private `setTimeout(...).unref()` on a retry path. Once the loop has nothing but unref-ed timers, Node exits cleanly mid-await. The repo-wide rule: every retry uses `defaultSleep` from `src/errors/backoff.ts` (plain `setTimeout`, ref-ed). Pinned by `tests/backoff.spec.ts › defaultSleep`. |

## Canonical sources (don't hand-edit)

- `dist/` — **GENERATED** by `tsc`; the `automaton` bin is `dist/cli/index.js`.
- `node_modules/@titon-network/{forgeton,kronos,atlas,fortuna,themis}-sdk/` — **SNAPSHOTS** of `file:` deps at install time. Run `pnpm run sync:sdks` after editing sibling SDK source.

## Which docs to load (priority)

1. This file (`AGENTS.md`) — quick reference. Always.
2. `CLAUDE.md` — full architecture + design decisions. Load before touching any module.
3. [`CONTRIBUTING.md`](CONTRIBUTING.md) — house rules (schema-version bumps, bounded label cardinality, idempotent handlers). Load before writing code.
4. `docs/troubleshooting.md` — operator-facing symptom → fix table. Load on debugging questions.
5. `docs/ops.md` — deployment reference. Load for systemd/Docker questions.
6. `docs/quickstart.md` — end-to-end flow. Load for onboarding questions.
7. `../kronos/CLAUDE.md` + `../forgeton/CLAUDE.md` — contract-side architecture. Load when the question is about job execution, staking, slashing semantics.

Folder-level `src/*/README.md` stubs point back to the CLAUDE.md navigator. Landing cold in `src/chain/submit.ts`? The sibling `src/chain/README.md` names every file in the directory + points up.

## Slash commands (`.claude/commands/`)

Task-shaped recipes invocable from a Claude Code session:

- `/verify` · `/preflight` · `/dev <args>` — build/test/run gates.
- `/navigate <task>` — map intent to a file via CLAUDE.md's navigator.
- `/new-subcommand` · `/new-metric` · `/new-handler` · `/new-config-field` — scaffolders matching the recipes in §Common task recipes above.
- `/explain-error <code-or-message>` — TVM exit codes + typed-error dispatch.
