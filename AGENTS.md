# AGENTS.md — @titon/automaton

> AI assistants reading this: this is your map of the `automaton` CLI + daemon. Skim the **Quick reference**, then jump to the section the user is asking about. Full architecture + design rationale lives in [CLAUDE.md](CLAUDE.md).

`@titon/automaton` is the off-chain operator node for the [Titon](https://github.com/titon) protocol suite on TON. One binary (`automaton`) wraps wallet management, on-chain lifecycle, and a long-running daemon that polls the Kronos registry + executes due jobs + tails pool events.

> **Contract logic lives elsewhere.** Registry + pool behaviour, opcode ranges, error codes, gas math — those are in `../kronos/` and `../forgeton/`. This repo owns the off-chain side only.

## Quick reference

| User wants to… | Command / entry point |
|----------------|------------------------|
| Scaffold a fresh install (wallet + config) | `automaton init [--network testnet] [--import-mnemonic <f>] [--password-file <f>]` |
| Verify the install | `automaton doctor` — install + config + chain + lockfile layers; add `--format json` for agent parsing |
| See operator state at a glance | `automaton status` — balance, registration, drift, endpoints; add `--format json` for stable machine-readable output |
| Register on-chain with stake | `automaton stake register <amount>` |
| Top up existing stake | `automaton stake increase <amount>` |
| Start the cooldown + withdraw later | `automaton stake request-unstake` → wait → `automaton stake withdraw` |
| Abort a pending unstake | `automaton stake cancel-unstake` |
| Run the daemon (poll + execute) | `automaton run [--log-level info]` |
| Inspect the effective config + env overlay | `automaton config show [--format json]` |
| Install shell completion | `eval "$(automaton completion bash)"` (or `zsh` / `fish`) |
| Do any of the above non-interactively | Every prompt has an equivalent flag; `AUTOMATON_PASSWORD` env bypasses the password prompt |
| Scrape Prometheus metrics | `http://127.0.0.1:9090/metrics` |
| Liveness / readiness probes | `/healthz` (staleness-gated) · `/readyz` (lockfile + wallet + stake + rpc subchecks) |

## File map

```
src/
  cli/
    index.ts                     # commander entry (bin → dist/cli/index.js); top-level error surface + explainExitCode
    commands/{init,doctor,status,stake,run,config,completion}.ts
    prompt.ts                    # readline text/choice/confirm (non-TTY throws NotInteractiveError)
    version.ts                   # reads package.json at runtime
  config/
    schema.ts                    # zod Config + Network + LogLevel + defaultConfig
    paths.ts                     # every file path lives here (TITON_HOME, ~/.titon)
    load.ts                      # loadConfig/saveConfig + applyEnvOverlay
  wallet/
    mnemonic.ts wallet.ts        # BIP-39 + WalletContractV5R1 (network-aware derivation)
    keystore.ts                  # scrypt + AES-256-GCM, schema-versioned
    prompt.ts                    # hidden-input password prompt + AUTOMATON_PASSWORD env
  chain/
    ton-client.ts                # FailoverTonClient — endpoint ring + jittered backoff
    deployment.ts                # resolveDeployment(config) → KRONOS_TESTNET etc.
    runtime.ts                   # buildChainRuntime → {client, deployment, registry, pool}
    schema-check.ts              # startup gate against SDK storageVersion constants
    submit.ts                    # senderFor + sendAndConfirm (seqno wait + post-state verify)
    stake-cost.ts                # pool message-value calculators
    snapshot.ts                  # collectChainSnapshot — shared by status + daemon
    lockfile.ts                  # acquireLock/releaseLock + describeLock (with liveness probe)
  worker/
    decide.ts                    # pure decision engine (every reason tag bounded)
    mirror.ts                    # AutomatonMirror cache; refresh-on-count + replace-on-event
    loop.ts                      # runWorkerCycle (bounded fan-out, single-flight guard)
    events.ts                    # drainEvents (paginated backward walk, hash-verified checkpoint)
    handlers.ts                  # mirrorPatch / selfSlashAlert (fire-and-forget webhook) / consumerWatch
    checkpoint.ts                # state.json load/save (zod-validated, atomicWriteFile)
  errors/
    backoff.ts                   # jitteredBackoff + abortableRetry (AbortSignal-aware)
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

### Add an event handler

```ts
// src/worker/handlers.ts
export function myHandler(…): EventHandler {
    return {
        onRegistry(event, ctx) { /* KronosEvent discriminated by event.kind */ },
        onPool(event, ctx)     { /* ForgetonEvent */ },
        onCycleEnd()           { /* flush debounced work once per drain */ },
    };
}
// Wire into src/daemon/orchestrator.ts buildHandlers(...)
```

Handlers are per-cycle isolated (one throw doesn't abort the batch); use `onCycleEnd` for debounced side-effects (the mirror patcher uses it to collapse a burst into one `refresh()`).

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
| `PREFLIGHT FAILED — ../<sdk>/sdk/node_modules exists` | `rm -rf ../kronos/sdk/node_modules ../forgeton/sdk/node_modules` — someone ran `pnpm install` in a sibling SDK, breaking `@ton/core` instanceof |
| `automaton is already running: pid X …` | Check the pid (`ps -p X`); if dead, `rm ~/.titon/automaton/automaton.lock` (EXIT_LOCK_HELD = 75) |
| `contract schema mismatch — refusing to start` | `automaton status` tells you which side is ahead; upgrade `@titon/automaton` (contract newer) or wait for deploy (SDK newer) |
| `keystore integrity check failed — stored address … does not match derived address …` | Someone edited the plaintext `network` field in `wallet.enc`; restore it — address is deterministic from `(mnemonic, network)` |
| `all N endpoint(s) failed after M attempt(s)` | RPC outage or rate limiting; check network + API keys; add more endpoints |
| `the wallet tx landed but the pool rejected the internal message` | `PoolRejectedError` — explanation printed underneath names the pool error; `automaton status` shows current state |
| `seqno advanced but the wallet-initiated tx could not be located` | `TxAttributionError` — race with an incoming transfer; check the explorer, rerun if needed |
| `cycle threw — continuing loop` | Transient error; the exponential backoff caps flood at 60 s; investigate persistent causes via the `error` field |

## Canonical sources (don't hand-edit)

- `dist/` — **GENERATED** by `tsc`; the `automaton` bin is `dist/cli/index.js`.
- `node_modules/forgeton-sdk/`, `node_modules/kronos-sdk/` — **SNAPSHOTS** of `file:` deps at install time. Run `pnpm run sync:sdks` after editing sibling SDK source.

## Which docs to load (priority)

1. This file (`AGENTS.md`) — quick reference. Always.
2. `CLAUDE.md` — full architecture + design decisions. Load before touching any module.
3. `docs/troubleshooting.md` — operator-facing symptom → fix table. Load on debugging questions.
4. `docs/ops.md` — deployment reference. Load for systemd/Docker questions.
5. `docs/quickstart.md` — end-to-end flow. Load for onboarding questions.
6. `docs/phases.md` — past-tense phase history (D.1 → D.15). Load only for "why is it like this?" archaeology.
7. `../kronos/CLAUDE.md` + `../forgeton/CLAUDE.md` — contract-side architecture. Load when the question is about job execution, staking, slashing semantics.

Folder-level `src/*/README.md` stubs point back to the CLAUDE.md navigator. Landing cold in `src/chain/submit.ts`? The sibling `src/chain/README.md` names every file in the directory + points up.

## Slash commands (`.claude/commands/`)

Task-shaped recipes invocable from a Claude Code session:

- `/verify` · `/preflight` · `/dev <args>` — build/test/run gates.
- `/navigate <task>` — map intent to a file via CLAUDE.md's navigator.
- `/new-subcommand` · `/new-metric` · `/new-handler` · `/new-config-field` — scaffolders matching the recipes in §Common task recipes above.
- `/explain-error <code-or-message>` — TVM exit codes + typed-error dispatch.
