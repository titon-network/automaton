# Automaton — AI Development Guide

## AI navigator — "I want to X, where do I look?"

**Doing things:**

| Task | Primary file(s) | Supporting |
|------|-----------------|------------|
| Add a new CLI subcommand | `src/cli/commands/<name>.ts` | Register via `registerXCommand(program)` in `src/cli/index.ts`; follow the stub pattern (each file is one command tree) |
| Add an interactive prompt | `src/cli/prompt.ts` | `promptText` / `promptChoice` / `promptConfirm` — all throw `NotInteractiveError` on non-TTY; use a flag escape hatch for CI |
| Add a new config field | `src/config/schema.ts` | If runtime-tunable, add env override in `src/config/load.ts` (`applyEnvOverlay`); default goes in `defaultConfig()`; bump `CONFIG_VERSION` if semantics change |
| Add an env var override | `src/config/load.ts` | Narrow allow-list — `applyEnvOverlay` re-uses schema validators so types stay honest |
| Change where a file lives | `src/config/paths.ts` | Every filesystem path lives here as a pure function (re-reads env per call) |
| Add a `doctor` check | `src/cli/commands/doctor.ts` | Install-scoped? push into `buildInstallChecks`. Config-scoped? `buildConfigChecks`. On-chain? `buildChainChecks`. Each `Check.run()` returns `{ status, detail }` where status is `ok` / `warn` / `fail` / `skip`; failures gate exit, warnings don't. |
| Surface on-chain field in `status` | `src/cli/commands/status.ts` | Add a field to `ChainSnapshot`, read it in `collectChainSnapshot` via a `tryAsync` wrapper (never crashes the status output), and print in `renderStatus` |
| Add a new deployment (e.g. mainnet) | `src/chain/deployment.ts` | Add the `case` and pull addresses from whatever SDK constant lands; `deployment.spec.ts` has the matching case |
| Send a tx from the automaton wallet | `src/chain/submit.ts` | `senderFor(client, wallet)` builds the Sender; `sendAndConfirm(...)` wraps the send with seqno-advance polling + explorer URL; `waitForSeqnoAdvance` is the reusable core |
| Size a pool message | `src/chain/stake-cost.ts` | `registerValue` / `increaseStakeValue` / `requestUnstakeValue` / `finalizeUnstakeValue` / `cancelUnstakeValue` match the on-chain floors |
| Add a stake subcommand | `src/cli/commands/stake.ts` | Thread it through the shared `loadContext` → pre-state validation → `submit()` helper so the progress output + error handling stays uniform |
| Change the Kronos decide tree | `src/worker/decide.ts` | Pure function `decide(input) → { action, reason, ... }`; add a `DecisionReason` tag and update the test matrix in `decide.spec.ts` |
| Touch the worker poll loop | `src/worker/loop.ts` | `runWorkerCycle(deps)` does one iteration — ensure mirror freshness, iterate jobs, decide, submit. `submitExecute` is injectable for tests |
| Change mirror caching | `src/worker/mirror.ts` | `AutomatonMirror.ensureFresh()` refreshes on count change; `replace()` is the hook for D.9's event-driven incremental updates |
| Add an event handler | `src/worker/handlers.ts` | Write a factory returning `EventHandler`; `onRegistry` / `onPool` callbacks receive decoded SDK events + `TxContext`. `drainEvents` orchestrates dispatch |
| Change event polling / checkpoint | `src/worker/events.ts` + `src/worker/checkpoint.ts` | `drainEvents(deps)` walks transactions backward to the stored checkpoint; state lives in `~/.titon/automaton/state.json` (zod-validated) |
| Change daemon startup order | `src/daemon/orchestrator.ts` | `runDaemon()` composes lockfile → keystore unlock → runtime → schema check → event handlers → main loop → graceful shutdown. Order matters and is documented at the top of the file |
| Tune daemon timers | `src/daemon/loop.ts` | `abortableSleep`, `loopCycles`, `waitForDrain` — all AbortSignal-driven, cleanly cancellable |
| Change daemon log format | `src/daemon/logger.ts` | `createPinoLogger({ level })` is the production default (with redacted paths). `createConsoleLogger` is a simpler alternative for tests |
| Add a new metric | `src/daemon/metrics.ts` | Add to the one returned `DaemonMetrics` bundle; document in the `help` string; use bounded labels only |
| Change health/readiness semantics | `src/daemon/http.ts` | `/healthz` reads `liveness()` (staleness-gated), `/readyz` reads `readiness()` (array of subchecks). Both called fresh per request |
| Add a retry-with-backoff to any async op | `src/errors/backoff.ts` | `abortableRetry(fn, { maxAttempts, baseBackoffMs, maxBackoffMs, signal, shouldRetry })` — AbortSignal-aware so shutdown cancels retries immediately |
| Explain a TVM exit code to an operator | `src/errors/explain.ts` | `explainExitCode(n)` returns `{code, origin, name, message, hint?}` — picks the right SDK (kronos 100-119 / forgeton 160-182 / tvm 1-100); `extractExitCode(err)` pulls it off SDK errors or parses `exit code N` out of sandbox error strings |
| Cut a release | `scripts/release.sh <bump>` | Dry-run by default; prints the mutating plan (tests + version bump + build + tag + commit) and the next-steps for `npm publish` + `docker buildx`. Pass `--apply` to execute |
| Build the Docker image | `Dockerfile` + `.dockerignore` | Build context is the parent dir (so sibling SDKs are visible). `docker buildx build --platform linux/amd64,linux/arm64 -t titon/automaton:X -f automaton/Dockerfile .` |
| Install the systemd unit | `contrib/automaton.service` | Copy to `/etc/systemd/system/`, install `automaton.env.example` at `/etc/automaton.env`, fill in `AUTOMATON_PASSWORD`, `systemctl daemon-reload && systemctl enable --now automaton` |
| Change keystore format | `src/wallet/keystore.ts` | Bump `KEYSTORE_VERSION`; store migration path in the same file |
| Change wallet derivation | `src/wallet/wallet.ts` | V5R1 is network-aware — mainnet/testnet produce different addresses from the same mnemonic; keystore must continue to carry the network |
| Persist a new file atomically | `src/util/atomic-write.ts` | `atomicWriteFile(path, data, mode)` — used by both config and keystore; use it for any other persistent file |
| Call a TON RPC with retry/failover | `src/chain/ton-client.ts` | `new FailoverTonClient({ endpoints, … }).call(fn)` — rotates endpoints on transient errors (timeout, 429, 5xx) with jittered exponential backoff |
| Open a contract wrapper (registry/pool) | `src/chain/ton-client.ts` | `failover.open(KronosRegistry.createFromAddress(addr))` — every `.get*()` / `.send*()` goes through the failover machinery automatically |
| Acquire single-instance lock | `src/chain/lockfile.ts` | `acquireLock()` at startup / `releaseLock()` at shutdown; handles live-pid contention + stale cleanup automatically |
| Verify on-chain schema matches SDK | `src/chain/schema-check.ts` | `checkSchemaVersions({ client, registry, pool })`; refuse to start on mismatch with an upgrade-path message |
| Write a test | `tests/*.spec.ts` | `jest --runInBand`, 1 GB per worker; `tests/preflight.ts` fails fast on SDK snapshot issues — see §Tests |

**Debugging symptoms:**

| Symptom | Most likely cause | First place to look |
|---------|-------------------|---------------------|
| `PREFLIGHT FAILED — node_modules/<sdk>/dist/index.js is missing` | the `file:` dep snapshot is empty | `pnpm run sync:sdks` (rebuilds both SDKs then force-reinstalls) |
| `PREFLIGHT FAILED — ../<kronos\|forgeton>/sdk/node_modules exists` | someone ran `pnpm install` inside a sibling SDK | `rm -rf ../<sdk>/sdk/node_modules` — that nested install creates a duplicate `@ton/core` which breaks `Address instanceof` across package boundaries |
| `keystore decryption failed — wrong password or corrupt data` | wrong password OR a tampered ciphertext/tag/salt/nonce | AES-GCM auth tag — can't tell the cases apart by design; try the password again |
| `keystore integrity check failed — stored address … does not match derived address …` | plaintext `network` field was hand-edited in `wallet.enc` | Restore the original `network` in the keystore JSON; address is deterministic from (mnemonic, network) |
| `cannot prompt for password: stdin is not a TTY` | running in Docker / systemd without a TTY | Set `AUTOMATON_PASSWORD` env var |
| `config not found at …` | no `config.json` yet | `automaton init` (lands in D.5) |
| `AUTOMATON_NETWORK must be one of testnet \| mainnet` | unknown env value | Fix the shell export; overlay validates through the same zod schema as the file |
| dist/ missing at runtime | forgot to build | `pnpm run build` |
| `automaton is already running: pid X…` | prior `run` still holds the lock, or it crashed without cleanup | Check the pid (`ps -p X`); if dead, `rm ~/.titon/automaton/automaton.lock` |
| `lock file at … is corrupt` | hand-edit / partial write / older version | Confirm no automaton is running, then `rm` the file |
| `all N endpoint(s) failed after M attempt(s)` | upstream outage or all endpoints blocked (rate limit) | Check network; consider adding more endpoints to `config.endpoints`; confirm API keys are valid |
| `contract schema mismatch — refusing to start` | deployed contract schema ≠ SDK's expected version | Upgrade `@titon/automaton` (contract newer) or wait for deploy to land (SDK newer); see message for direction |

**Canonical sources (don't hand-edit):**

- `dist/` — **GENERATED** by `tsc -p tsconfig.json`. The `automaton` bin points at `dist/cli/index.js`.
- `node_modules/forgeton-sdk/`, `node_modules/kronos-sdk/` — **SNAPSHOT COPIES** from the `file:` deps. pnpm copies at install time; they do NOT live-link. Run `pnpm run sync:sdks` after editing sibling SDK source.
- `pnpm-lock.yaml` — committed, managed by pnpm.

**Which docs to load (in priority order):**

1. **This file (`CLAUDE.md`)** — architecture + the navigator above. Always load.
2. **`../kronos/progress.md` §Phase D** — the task-by-task plan for this repo (D.1–D.15). Load for "what's next" questions.
3. **`../kronos/CLAUDE.md`** — Kronos registry architecture. Load when working on Kronos job execution (D.8 worker).
4. **`../forgeton/CLAUDE.md`** — ForgeTON pool architecture. Load when working on stake lifecycle (D.7) or slash handling (D.9).

---

## What is this project?

`@titon/automaton` is the off-chain operator node for the Titon protocol suite on TON. It's the binary an operator installs and runs to:

1. **Stake once with ForgeTON** (shared-security staking pool). One stake, multiple consumer products.
2. **Poll the Kronos registry** for due jobs it's been assigned to execute.
3. **Sign + send `Execute`** messages, earning per-job rewards.
4. **Consume `AutomatonSync` pushes** to keep the mirror fresh.
5. **React to slash events** informationally — slashes don't stop further work; they just reduce stake.

The design goal (per the user brief) is: *super easy to launch, hassle-free, production-ready*. `automaton init` → `automaton stake register` → `automaton run` should be the entire onboarding flow, with `automaton doctor` / `automaton status` for diagnostics.

Kronos is the first admitted consumer. Fortuna (VRF) and other consumers will be added as they're built — the binary gates each via `config.products.<name>` so operators can opt in incrementally.

## Tech stack

- **Runtime:** Node.js ≥ 22 (strict; preflight fails below).
- **Language:** TypeScript 5.5+, strict + `isolatedModules`, NodeNext resolution (CommonJS output — matches kronos-sdk / forgeton-sdk).
- **CLI framework:** `commander` v12.
- **Config:** `zod` for schema validation.
- **Logger:** `pino` (wired in D.11).
- **Metrics:** `prom-client` (wired in D.11).
- **Crypto:** Node's built-in `crypto` module (scrypt + AES-256-GCM for the keystore); `@ton/crypto` for BIP-39 mnemonics.
- **TON:** `@ton/core` (primitives), `@ton/ton` (TonClient, WalletContractV5R1).
- **SDKs:** `forgeton-sdk` + `kronos-sdk` from the sibling repos via `file:` deps (see §SDK snapshots below).
- **Tests:** Jest + `ts-jest`, `--runInBand`, 1 GB per-worker heap cap (same discipline as kronos — parallel jest OOMs on heavy crypto).

## Commands

```bash
pnpm install                       # resolves all deps incl. file: SDK snapshots
pnpm run build                     # tsc → dist/
pnpm run clean                     # rm -rf dist
pnpm run test                      # jest --runInBand, runs preflight first
pnpm run cli -- <args>             # shortcut for node dist/cli/index.js <args>
pnpm run sync:sdks                 # rebuild ../forgeton/sdk + ../kronos/sdk + force reinstall
```

After `pnpm run build`:

```bash
./dist/cli/index.js --help          # lists subcommands
./dist/cli/index.js doctor          # runs install + config + keystore sanity
```

> ⚠️ **SDK snapshot staleness.** Both `forgeton-sdk` and `kronos-sdk` are `file:` deps. pnpm **copies** them at install time; it does NOT live-symlink. If you edit `../forgeton/sdk/src/` or `../kronos/sdk/src/`, this repo is instantly stale. Run `pnpm run sync:sdks` to rebuild + re-snapshot. The `tests/preflight.ts` script catches the most common failure mode (missing `dist/`) at the start of every test run.

## Repository layout

```
src/
  cli/
    index.ts                 # commander entry point — wires every subcommand
    version.ts               # reads package.json at runtime
    prompt.ts                # readline-based text/choice/confirm prompts — all throw on non-TTY
    commands/
      doctor.ts              # environment + config + keystore checks
      init.ts                # interactive + flag-driven first-run setup (network, new/import wallet, password, write config+keystore)
      status.ts              # read-only operator snapshot (balance + automaton info + drift counters + lockfile)
      stake.ts               # register / increase / request-unstake / cancel-unstake / withdraw — each unlocks the wallet, pre-checks state, submits + waits for seqno advance
      run.ts                 # thin wrapper → src/daemon/orchestrator.ts runDaemon; --log-level override
  worker/
    decide.ts                # pure decision engine: job state × window × assignment → execute|skip + reason tag
    mirror.ts                # AutomatonMirror cache (refresh on count change; replace hook for event-driven patching)
    loop.ts                  # runWorkerCycle(deps) — one poll iteration; single-flight via Set<bigint>; submitExecute injectable for tests
    checkpoint.ts            # state.json persistence — zod-validated (lt, hash) per address; atomicWriteFile
    events.ts                # drainEvents(deps) — pages txs backward to checkpoint; decodes external-out bodies via both SDKs; dispatches
    handlers.ts              # built-in event handlers: mirrorPatchHandler / selfSlashHandler (w/ webhook + onSelfSlash hook) / consumerWatchHandler
    index.ts                 # barrel
  errors/
    backoff.ts               # jitteredBackoff + abortableRetry — AbortSignal-aware; shared by any async op that wants bounded retry
    explain.ts               # explainExitCode + extractExitCode + formatExplanation — unified TVM-exit-code → human text
    index.ts                 # barrel
contrib/                     # distribution artefacts bundled in the published npm tarball
  automaton.service          # systemd unit — opinionated sandbox, User=automaton, Restart=on-failure, EXIT_LOCK_HELD preventer
  automaton.env.example      # stub for /etc/automaton.env — AUTOMATON_PASSWORD + optional log-level / port / network overrides
Dockerfile                   # multi-stage build: node:22-alpine builder → distroless/nodejs22-debian12 runtime; non-root user; ENTRYPOINT node dist/cli/index.js
.dockerignore                # relative to the PARENT build context; trims node_modules, build/, .git, sibling SDK build artefacts
scripts/
  release.sh                 # dry-run by default: test + version-bump + prepublishOnly + smoke + tag; prints next steps for npm publish + docker push
  daemon/
    logger.ts                # createPinoLogger (redacted: password/mnemonic/privateKey/seed/secretKey) + createConsoleLogger (tests)
    loop.ts                  # abortableSleep / loopCycles (with exponential backoff) / waitForDrain — cancellable primitives
    metrics.ts               # createDaemonMetrics → prom-client Registry + counters (WorkerCounters) + gauges + cycleDuration histogram
    http.ts                  # startHealthServer — /metrics /healthz /readyz on 127.0.0.1:metricsPort
    orchestrator.ts          # runDaemon: lockfile + unlock + runtime + schema-check + handlers + health server + main loop + gauges + graceful shutdown
    index.ts                 # barrel
      status.ts              # stub until D.6
      stake.ts               # stub until D.7 (register / increase / unstake / cancel / withdraw)
      run.ts                 # stub until D.10 (daemon)
  config/
    schema.ts                # zod Config schema + Network + LogLevel + defaultConfig(network)
    paths.ts                 # titonHome/automatonDir/configPath/walletPath/statePath/lockPath/logsDir
    load.ts                  # loadConfig / saveConfig / applyEnvOverlay + typed errors
    index.ts                 # barrel
  wallet/
    mnemonic.ts              # @ton/crypto wrapper — 24 words, validate, toKeys
    wallet.ts                # walletFromMnemonic(mnemonic, network) — V5R1 derivation
    keystore.ts              # scrypt+AES-GCM lock/unlock, atomic save, zod schema
    prompt.ts                # raw-mode hidden password prompt + AUTOMATON_PASSWORD fallback
    index.ts                 # barrel
  chain/
    ton-client.ts            # FailoverTonClient — endpoint rotation + jittered backoff on transient errors; .call(fn) + .open(contract)
    lockfile.ts              # PID-based single-instance lock; live/stale detection via process.kill(pid, 0)
    schema-check.ts          # compare on-chain storageVersion getters vs REGISTRY_STORAGE_VERSION + FORGETON_STORAGE_VERSION; refuse on mismatch
    deployment.ts            # resolve (registry, pool) addresses per network — testnet via kronos-sdk's KRONOS_TESTNET; mainnet throws until it ships
    runtime.ts               # buildChainRuntime(config) → { client, deployment, registry, pool } — the canonical "start talking to chain" entry point
    submit.ts                # senderFor() + sendAndConfirm() (seqno-advance polling) + explorer URL helpers; waitForSeqnoAdvance is the testable core
    stake-cost.ts            # pool message-value calculators — mirror of the on-chain floors in handleRegisterAutomaton / handleIncreaseStake / handleUnstake
    index.ts                 # barrel
  util/
    atomic-write.ts          # tmp + chmod + rename (used by config + keystore)
tests/
  preflight.ts               # jest globalSetup — fails fast on missing SDK dist / stray sibling node_modules
  cli.spec.ts                # CLI smoke — help, version, doctor, stub exits
  config.spec.ts             # round-trip, env overlay, schema rejection, path resolution
  wallet.spec.ts             # mnemonic, derivation, keystore round-trip + 6 tamper vectors, prompt env fallback
  ton-client.spec.ts         # isTransientError taxonomy; retry/rotate/backoff; AllEndpointsFailedError
  lockfile.spec.ts           # acquire/release/inspect; live pid / stale pid / corrupt / missing
  schema-check.spec.ts       # ok case; either-side mismatch; error message content; propagates fetcher errors
  init.spec.ts               # non-interactive end-to-end, idempotence, flag validation, mnemonic + password file parsing
  deployment.spec.ts         # testnet resolves to KRONOS_TESTNET; mainnet throws DeploymentNotAvailableError
  status.spec.ts             # renderStatus pure-rendering cases + runStatus "no install" rejection + mainnet no-chain path
  stake-cost.spec.ts         # pure math for all five value calculators + willCrossInactive edge cases
  submit.spec.ts             # waitForSeqnoAdvance poll/advance/timeout + pickWalletTx attribution + explorer URLs
  decide.spec.ts             # decision-tree coverage: every execute and skip reason, across primary/fallback/too-early/too-late/expired/inactive/underfunded
  worker-loop.spec.ts        # runWorkerCycle with injected runtime + submit stub; single-flight, failure recovery, counters, pause gate, cardinality
  checkpoint.spec.ts         # state.json round-trip, schema-version reject, malformed JSON, null-entry preservation, 0600 perms
  events.spec.ts             # extractExternalOutBodies filters; bigintHashToBase64 conversion; handler dispatch (slash / consumer / mirror patch)
  daemon-loop.spec.ts        # abortableSleep cancellation + timer cleanup; loopCycles error-resilience + onStart + backoff growth + cap + reset; waitForDrain timeout path
  logger.spec.ts             # pino redaction (top-level + nested secret paths); level filter; timestamp/level emission
  metrics.spec.ts             # prom-client registry exports every declared name; counter-label propagation; per-instance isolation
  http.spec.ts               # /metrics content-type + body; /healthz fresh/stale/unstarted; /readyz all-ok + any-fail; 404/405/querystring routing
  backoff.spec.ts            # jitteredBackoff growth/cap/bounds; abortableRetry happy/fail/shouldRetry/onRetry/abort-signal/injected-sleep
  explain.spec.ts            # explainExitCode picks kronos vs forgeton vs tvm vs unknown; formatExplanation hint rendering; extractExitCode shapes
package.json                 # bin: automaton; file: deps on ../kronos/sdk and ../forgeton/sdk
tsconfig.json                # strict + isolatedModules + NodeNext + ES2022, outDir dist/
jest.config.ts               # --runInBand, 1 GB heap, 30s timeout, globalSetup=preflight
LICENSE                      # MIT
```

## Key design decisions

### CLI-only package, not a library

`package.json` declares only `bin` (no `main`, no `types`). If someone needs programmatic access, they should import from `kronos-sdk` + `forgeton-sdk` directly — the automaton binary is user-facing plumbing, not a reusable API. Keeps the surface tight.

### Atomic writes for every persistent file

Any file the automaton persists (config, keystore, state, lockfile) goes through `src/util/atomic-write.ts`: write to a `.<pid>.tmp` sibling, chmod explicitly (because `writeFileSync`'s `mode` arg is masked by umask), rename. A crash mid-write leaves the old file intact. Both `saveConfig` and `saveKeystore` call it.

### Paths module is the single source of truth for filesystem locations

Every file the automaton touches — config, wallet, state, lockfile, logs — has exactly one path resolver in `src/config/paths.ts`. They're functions (not constants) so tests can mutate `TITON_HOME` / `AUTOMATON_CONFIG` mid-run without restarting the module system.

**Env overrides:** `TITON_HOME` moves the entire root (`~/.titon/` by default); `AUTOMATON_CONFIG` overrides only the config file path. For operators running multiple instances (mainnet + testnet), use distinct `TITON_HOME` values: `TITON_HOME=~/.titon-mainnet automaton run` vs `TITON_HOME=~/.titon-testnet automaton run`.

### Config + Keystore both schema-versioned

`CONFIG_VERSION` (currently 1) and `KEYSTORE_VERSION` (currently 1) are `z.literal(N)` fields. Loaders reject mismatched versions; migration logic lives next to the bump. Same discipline as the on-chain `REGISTRY_STORAGE_VERSION` / `FORGETON_STORAGE_VERSION`.

### Keystore is network-aware

`WalletContractV5R1` bakes the network global ID (`-239` mainnet / `-3` testnet) into the walletId, which affects the state init and therefore the contract address. The same mnemonic yields **different addresses** per network. The keystore records `network` plaintext alongside the encrypted mnemonic; on unlock we re-derive and verify against the stored address.

Defense-in-depth on unlock:
1. AES-GCM tag check catches ciphertext/tag/salt/nonce tampering.
2. Re-validate the decrypted mnemonic against BIP-39.
3. Re-derive the address and compare against the stored one (catches `network` tampering, which is plaintext).

### Password flow: env-first, then TTY prompt

`getPassword` reads `AUTOMATON_PASSWORD` when set, otherwise raw-mode TTY. The env path is for Docker secrets / systemd credentials. We deliberately do NOT accept `--password` as a CLI flag because it would land in shell history.

### Doctor exits on fails, ignores warns, skips gracefully

`automaton doctor` builds its check list at runtime based on what's available on disk. Layers, in order:

1. **Install-scoped** (always) — node version, SDK resolvability, pkg version.
2. **Config-scoped** (skipped cleanly when config or keystore is absent) — loads both, cross-checks their `network` fields.
3. **Chain-scoped** (skipped when deployment isn't known for the network) — RPC reachable, wallet balance vs `config.minFreeBalance`, schema versions match via `checkSchemaVersions`, registry admitted as a consumer on the pool.
4. **Runtime-scoped** (always) — lockfile: absent / held-by-pid-X / stale.

Each check returns `{ status, detail }` where status is one of `ok` / `warn` / `fail` / `skip`. Only `fail` gates the exit code. `warn` is for "technically works but you probably want to fix this" (e.g. balance below `minFreeBalance`). `skip` is for "prerequisite missing, intentionally not run."

Output is colour-coded on a TTY (green/yellow/red/dim) and plain text otherwise (so logs stay readable).

### Status is best-effort — chain errors never crash it

`automaton status` builds the same `ChainRuntime` as doctor and queries seven pieces of state in parallel: wallet balance, automaton info, active-automaton-count, both drift counters, and both schema versions. Each call is wrapped in a `tryAsync` helper that pushes failure messages onto a per-run `errors: string[]` array. A dead RPC surfaces as "balance: ECONNRESET" in a footer — the operator still sees everything else, which is the whole point of running `status` during an outage.

The pool's `getAutomaton(walletAddr)` returns `null` for "not registered" and the full struct otherwise — we branch on that to show either "not registered — run `automaton stake register`" or the active/inactive + stake + slashCount triple.

### Worker decide is pure; loop is I/O; daemon is a timer

D.8 splits the execution logic into three layers:

1. **`decide(input)` (`src/worker/decide.ts`)** — pure function. Given a job's state + registry config + mirror snapshot + "me" + `now`, returns `{ action: 'execute' | 'skip', reason, detail, window, assigned }`. Every decision path has a machine-readable `reason` tag so metrics (D.11) and logs can slice by it without parsing strings.

2. **`runWorkerCycle(deps)` (`src/worker/loop.ts`)** — one poll iteration. Refreshes the mirror, fetches registry config + jobCount in parallel, iterates `[0, jobCount)`, runs `decide`, and submits `Execute` for every "execute" decision. Single-flight via a `Set<bigint>` keyed on jobId ensures a slow RPC doesn't let the next tick race into a double-submit. Every RPC call is wrapped so a per-job fetch failure doesn't abort the whole cycle.

3. **Daemon (D.10, not yet landed)** — wraps `runWorkerCycle` in `setInterval(pollIntervalMs)` + lockfile acquisition + SIGINT/SIGTERM handlers.

`submitExecute` on `WorkerDeps` is injectable specifically so tests can exercise the decision path without a live sandbox — production passes `defaultSubmitExecute` (the real `sendAndConfirm` + post-state verify); tests pass a no-op or a controlled-failure stub.

### Distribution

Three targets, each with their own sharp edges:

- **npm** (`pnpm publish --access=public`). `prepublishOnly` cleans, rebuilds, chmod's `dist/cli/index.js`, and verifies the shebang survived — the common footguns for CLI packages. **Known limitation**: `kronos-sdk` + `forgeton-sdk` are `file:` deps pointing at sibling repos; npm publish expects them to be real npm packages. Publishing automaton end-to-end requires publishing both SDKs first (not yet scoped). The `prepublishOnly` pipeline still works locally; public `npm install` would currently fail until SDK publication lands.

- **Docker** (`docker buildx build -f automaton/Dockerfile .`). **Build context = parent directory** so the Dockerfile can copy sibling SDK sources. Multi-stage: `node:22-alpine` builds both SDKs (sequentially — their dist/ must be populated before automaton's `pnpm install` snapshots them) + automaton itself, then `gcr.io/distroless/nodejs22-debian12:nonroot` is the runtime (UID 65532, no shell, ~90 MB). Multi-arch via `--platform linux/amd64,linux/arm64`. No `automaton init` happens at container build; operators mount a pre-initialised `TITON_HOME` volume.

- **systemd** (`contrib/automaton.service`). Opinionated defaults: `User=automaton`, `Restart=on-failure`, `RestartPreventExitStatus=75` (so `EXIT_LOCK_HELD` doesn't loop), a full sandbox (`ProtectSystem=strict`, `NoNewPrivileges`, `RestrictNamespaces`, `MemoryDenyWriteExecute`), and 60s `TimeoutStopSec` to give the graceful-shutdown path its 30s drain window plus headroom. `EnvironmentFile=-/etc/automaton.env` is optional (leading `-`) so first-boot `systemctl start` doesn't fail before the operator has written the file.

Release cuts go through `scripts/release.sh <bump>`, which is **dry-run by default**. It runs the test suite, bumps `package.json`, runs the real `prepublishOnly` pipeline, tags git, and prints (not executes) the `pnpm publish` / `docker buildx` / `git push --tags` next steps. Pass `--apply` to actually mutate. The dry-run-by-default posture is deliberate: releases land on muscle-memory days and we want the plan reviewed every time.

### Errors surface human text — not stack traces

- **TVM exit codes** (contract reverts) translate to `{origin, name, message, hint?}` via `explainExitCode(n)` (`src/errors/explain.ts`). The CLI top-level catch prints the raw `error: <message>` line AND the explanation when it can extract a code from the error (SDK-style `exitCode`, numeric `code`, or `exit code N` substring). `kronos-sdk` owns codes 100-119, `forgeton-sdk` owns 160-182, both know TVM 1-100 — the helper tries both SDKs in order.
- **Typed errors** (`PoolRejectedError`, `LockHeldError`, `InsufficientWalletBalanceError`, `CheckpointStateError`, etc.) are already self-describing via their `.message` — the CLI surface prefers those strings over the explanation (exit code is additive context).
- **Uncaught exceptions / unhandled rejections** inside the daemon log at `error` level (via the redacted pino) and trigger graceful shutdown by aborting the main `AbortController`. systemd's `Restart=on-failure` picks up the exit code and respawns. We never let the process die silently — every crash leaves a logline naming it.

### Backoff / retry is a shared primitive

`src/errors/backoff.ts` exposes `jitteredBackoff` (equal-jitter exponential — same formula `FailoverTonClient` uses) and `abortableRetry(fn, { maxAttempts, baseBackoffMs, maxBackoffMs, signal, shouldRetry, onRetry, sleep, random })`. Not yet consumed by a hot path (FailoverTonClient has its own inline retry; stake commands fail loud by design), but future background ops (deferred webhook POSTs, stuck-tx recovery, third-party alerters) get one reusable pattern instead of hand-rolled while-loops.

### Metrics + logs + health: one source of truth each

- **Logs (`src/daemon/logger.ts`)**: `createPinoLogger` is production default; structural redaction on `password` / `mnemonic` / `privateKey` / `seed` / `secretKey` at top-level AND one level deep — `logger.info('x', { password: 'hunter2' })` becomes `{"password":"[Redacted]", …}` regardless of call-site discipline. `createConsoleLogger` stays for tests (lighter runtime; same `WorkerLogger` interface).
- **Metrics (`src/daemon/metrics.ts`)**: every counter / gauge / histogram declared in one file with a `help` string. Returned bundle has `counters` (implements `WorkerCounters` — `runWorkerCycle` calls it unchanged), `gauges` (updated out-of-band in the orchestrator's `snapshotGauges`), `cycleDuration` histogram (wraps every tick in the orchestrator), and `registry` (passed to the HTTP server). Each `createDaemonMetrics()` returns a fresh Registry — no global state leaks between test runs.
- **Health (`src/daemon/http.ts`)**: three endpoints on `127.0.0.1:metricsPort` (local-only by default; operators put a reverse proxy in front for remote scrape). `/metrics` serves prom-client exposition. `/healthz` returns 200 iff the last cycle completed within `2×pollIntervalMs` (floor 10s) — Kubernetes / systemd liveness probes tie to this. `/readyz` returns 200 iff every sub-check passes (lockfile held, wallet unlocked, stake active, RPC reachable); the response body lists per-check status so `curl /readyz` tells operators exactly what's red.

### Daemon orchestration is layered, signal-safe, crash-clean

`runDaemon` (`src/daemon/orchestrator.ts`) is the single entry point for `automaton run`. It composes every prior-phase primitive in a strict order:

1. Load config + keystore (fail fast on absent).
2. Acquire lockfile — second daemon exits here with `LockHeldError`.
3. Unlock wallet (password prompt or `AUTOMATON_PASSWORD`).
4. Build chain runtime (`FailoverTonClient` + opened contracts).
5. Startup schema-check via `checkSchemaVersions` — refuses to start on drift.
6. Load checkpoint (`state.json`) — resume from last-processed `(lt, hash)`.
7. Wire handlers (mirror patcher, self-slash alert, consumer watcher).
8. Install SIGTERM/SIGINT/SIGHUP handlers (single shared `AbortController`).
9. Run `loopCycles`: per tick drain events → save checkpoint → `runWorkerCycle` → sleep.
10. On abort: `waitForDrain(inFlight.size === 0, 30s)` → final `saveCheckpointState` → exit 0.
11. `finally { releaseLock() }` — lockfile release survives crashes, uncaught aborts, signal storms.

All cancellation goes through one `AbortController`. `abortableSleep` clears its timer on abort (no leaked handles). `loopCycles` never lets a tick throw abort the loop — errors log at `error` and the next tick fires. SIGHUP is deliberately a warn-and-ignore today; config reload without restart is D.11+ scope.

Tests inject `externalAbort: AbortSignal` so sandbox tests (D.15) can drive shutdown deterministically instead of signaling the host process.

### Event drain + checkpoint survive restarts

`drainEvents(deps)` pages `getTransactions` backward for both registry and pool until it hits the last-processed `(lt, hash)` stored in `~/.titon/automaton/state.json`. Once caught up, it reverses the list (oldest-first) and dispatches every external-out body through `tryDecodeEvent` from whichever SDK owns that address. Unknown opcodes return `null` and are silently skipped — the decoder seam makes forward-compat safe (new event types from a registry upgrade don't crash the daemon, they just don't fire handlers until we teach the SDK about them).

Handlers are pluggable via the `EventHandler` interface (`onRegistry` / `onPool` optional). Built-ins live in `handlers.ts`:
- **`mirrorPatchHandler`** — `await mirror.refresh()` on every `AutomatonMirrorUpdated`. Incremental patch would duplicate the registry's swap-and-pop logic; `refresh()` is a full re-read which has the same steady-state cost when events are sparse.
- **`selfSlashHandler`** — filters `AutomatonSlashed` for `automaton == me`, logs at warn, POSTs to `config.alertWebhookUrl` if set, calls the injected `onSelfSlash` hook (D.11 wires it to a prom-client counter). **Never throws** — a self-slash cannot be allowed to crash the daemon; we catch webhook failures and log them.
- **`consumerWatchHandler`** — logs `ConsumerUpdated` for observability; no in-memory state to patch (stake subcommands read pool config fresh each invocation).

Checkpoint is advanced ONLY after dispatch. A mid-drain crash re-reads the same events next run — handlers must be idempotent. For stake changes the handlers are naturally idempotent (refresh is idempotent, webhook POSTs to the same URL are also idempotent from the receiver's perspective with the `txHash` key).

### Mirror cache: refresh on count, replace on event

`AutomatonMirror.ensureFresh()` reads `pool.getAutomatonCount()` first and skips the per-slot re-fetch if the count matches the last snapshot. The assumption is: swap-and-pop operations on the registry's dense mirror DO preserve the count but CAN move addresses between slots, which would leave our cached mirror slightly stale. D.8 accepts that drift (wrong-slot Execute just fails the tx; the next cycle fixes it); D.9 will tail `AutomatonMirrorUpdated` events and patch via `mirror.replace(...)` for exact consistency.

### Stake subcommands pre-check on-chain state before sending

Every `automaton stake *` subcommand loads the pool config + consumer count + this automaton's current record, then refuses early if the pre-state is wrong — "already registered" / "not registered" / "unstake already pending" / "cooldown not elapsed". The pool enforces the same invariants on-chain, but eating a 500 ms RPC round-trip to find out is worse UX than a one-line error before the wallet even unlocks.

Message values are computed from the pool's published config, not constants: `registerValue` = `stake + minGasForRegister + consumerCount × syncGasCost`, mirroring the floor in `handleRegisterAutomaton`. If the pool owner bumps `syncGasCost` or admits a new consumer, automaton tx sizing follows automatically on the next invocation. The calculators live in `src/chain/stake-cost.ts` with a comment pointing to the source-of-truth Tolk handler.

Wallet balance is checked with a `WALLET_GAS_BUFFER = 0.1 TON` headroom above the attached value, so operator-visible errors mention the exact shortfall instead of surfacing as a cryptic seqno timeout after the wallet tried and failed to sign.

### Failover is a property of the client, not the caller

`FailoverTonClient` wraps `@ton/ton`'s `TonClient`. It takes an array of endpoints, keeps one `TonClient` per endpoint, and exposes two surfaces:

- **`.call(fn)`** — run any `(TonClient) => Promise<T>` through the retry/rotate logic. Used for ad-hoc ops (getBalance, sendFile, …).
- **`.open(contract)`** — wrap a contract with `@ton/core`'s `openContract` and a custom `ContractProvider` whose every method delegates through `.call`. Every `registry.getStorageVersion()` or `pool.sendRegisterAutomaton()` call transparently inherits retry/rotate.

**Transient error classification:**
- Node network codes: `ECONNRESET`, `ECONNREFUSED`, `ECONNABORTED`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `EPIPE`, `ERR_NETWORK`.
- HTTP 429 (rate limit) + 5xx.
- Everything else (4xx non-429, malformed response, exit-code throws) is permanent — re-throw immediately.

**Backoff:** equal-jitter exponential — `sleep = base·2^(n−1)/2 + rand[0, base·2^(n−1)/2)`, capped at `maxBackoffMs`. Prevents N automatons retrying the same upstream in lockstep.

On `maxAttempts` exhaustion, the last transient error gets wrapped in `AllEndpointsFailedError` with attempt count + endpoint list attached, so logs show the full picture.

### Single-instance lock via PID

`~/.titon/automaton/automaton.lock` holds `{ version, pid, startedAt }`. Acquire:
1. `open(path, 'wx')` — atomic "create-only"; EEXIST if contended.
2. On EEXIST, read the existing lock. If `process.kill(pid, 0)` says the PID is alive → throw `LockHeldError`. If dead → unlink and retry (once).
3. Second EEXIST after unlink = race with another stale-cleaner → throw loudly.

Release is idempotent and checks the stored PID matches ours before unlinking. Corrupt locks are never auto-removed; the error text tells the operator how to clean up.

One inherent limitation: PID reuse. If the OS recycled the recorded PID onto an unrelated process, we refuse to start. That's safer than the inverse (two automatons racing), and the `startedAt` timestamp gives operators the signal to `rm` stale locks manually.

### Schema check gates startup

Before the daemon does anything useful, `checkSchemaVersions` reads `storageVersion` from both registry + pool and compares against the `REGISTRY_STORAGE_VERSION` + `FORGETON_STORAGE_VERSION` constants exported by the bundled SDKs. Mismatch → `SchemaMismatchError` with guidance ("SDK newer than contract" vs "contract newer than SDK"). We would rather refuse to start than silently misinterpret on-chain state after a contract upgrade has propagated without a matching SDK bump.

The check takes an optional `fetcher` so tests exercise the comparison logic without standing up a sandbox. Production wires the default fetcher, which `client.open(...)` the SDK contract classes and calls `getStorageVersion()`.

### `init` is idempotent, TTY-aware, and CI-friendly

`automaton init` covers both the interactive operator flow and the non-interactive CI flow with the same code path. Three flags (`--network`, `--import-mnemonic <file>`, `--password-file <file>`) turn each prompt off individually; pass all three and no prompt fires. Partial sets narrow the flow (e.g. `--network=testnet` alone skips only step 1).

Idempotence: if `config.json` OR `wallet.enc` already exists, `init` refuses with a message listing every path that would be overwritten. Operators re-run after `rm`ing both, or point at a clean `TITON_HOME`.

Write ordering: keystore first, config second. If the keystore write fails mid-run, no config file points at a missing wallet.

The "generate a new mnemonic" branch is **interactive-only by design.** The 24 words land on stdout once, then a Y/N confirmation gates whether we continue. Operators who need generation in a scripted context should mint the mnemonic out-of-band (e.g. `ton-cli`, hardware wallet export) and use `--import-mnemonic`. Printing fresh mnemonics in CI logs is the kind of footgun we will not ship by default.

### Tests use a lowered scrypt work factor

Production uses `DEFAULT_KDF_N = 131072` (matches ethers.js v6 wallet default, ~300–500 ms per unlock). Tests pass `{ kdfN: 2048 }` via `LockOptions` to keep the suite fast (~4 s total). The crypto primitives exercised are identical — only the work factor differs — so tamper-vector tests still validate the security properties honestly.

## Current status

- **D.1 (scaffold)** — done. `11574c9`.
- **D.2 (config + paths)** — done. `bdde95f`. 30 tests.
- **D.3 (wallet keystore)** — done. `8989253`. 23 tests, 6 tamper vectors.
- **D.4 (TON client layer)** — done. `FailoverTonClient` with retry/rotate on transient errors; `lockfile.ts` PID-based single-instance lock; `schema-check.ts` on-chain version reconciliation. 47 additional tests.
- **D.5 (init command)** — done. Interactive + flag-driven first-run setup: network + new/import wallet + password + keystore + config, all idempotent. 17 additional tests (plus a non-TTY CLI smoke test).
- **D.6 (status + doctor expansion)** — done. Chain runtime builder + deployment resolver; doctor gains RPC-reachable / balance / schema-match / consumer-admitted / lockfile checks (colour-coded, skip-aware); `automaton status` renders a full operator snapshot with best-effort chain reads. 13 additional tests.
- **D.7 (stake lifecycle)** — done. Five subcommands (register / increase / request-unstake / cancel-unstake / withdraw) sharing one `submit()` helper: unlock wallet, pre-check on-chain state, size the pool message, send + wait for seqno advance, print tx hash + explorer URL. 22 additional tests (stake-cost math + waitForSeqnoAdvance with injected sleep/now).
- **D.8 (Kronos worker)** — done. Pure `decide()` + `AutomatonMirror` cache + `runWorkerCycle(deps)` single-iteration loop with single-flight guard and injectable `submitExecute`. 26 additional tests (all 6 decide statuses × execute/skip paths + mirror refresh/replace + loop orchestration).
- **D.9 (event subscriber)** — done. `drainEvents(deps)` tails registry + pool tx history, decodes external-out bodies via both SDKs, dispatches to pluggable handlers; `~/.titon/automaton/state.json` checkpoint survives restarts. Built-ins: mirror refresh on `AutomatonMirrorUpdated`, self-slash alerter (log + webhook + hook), consumer watcher. 28 additional tests.
- **D.10 (daemon)** — done. `runDaemon` composes lockfile + unlock + runtime + schema-check + handlers + timer loop + graceful shutdown. `abortableSleep` / `loopCycles` / `waitForDrain` primitives are cancellable and tested. SIGHUP reload deferred with a loud warn. 14 additional tests.
- **D.11 (logs + metrics + health)** — done. Pino logger with structural redaction, prom-client `DaemonMetrics` bundle (counters + gauges + cycle histogram), `startHealthServer` exposes `/metrics`/`/healthz`/`/readyz` on `config.metricsHost:metricsPort`. Gauges snapshot every Nth cycle (configurable via `gaugeSnapshotEveryNTicks`). Shared `collectChainSnapshot` used by status + daemon. 28 additional tests.
- **D.12 (error handling + backoff)** — done. `abortableRetry` + `jitteredBackoff` primitives; `explainExitCode` unifies kronos/forgeton/tvm SDK error tables; CLI top-level catch surfaces explanation under the raw error. Daemon installs `uncaughtException` + `unhandledRejection` handlers that log + trigger graceful shutdown. 25 additional tests.
- **D.13 (distribution)** — done. `prepublishOnly` + `smoke` npm scripts; multi-stage `Dockerfile` (alpine builder → distroless nonroot runtime, multi-arch); `contrib/automaton.service` systemd unit with full sandbox + `automaton.env.example`; `scripts/release.sh` dry-run-by-default release helper. Known limitation: `file:` SDK deps block actual `npm publish` until the SDKs are independently published.
- **Up next (D.14)** — Documentation: README, quickstart, ops, troubleshooting.
- **D.15** — see `../kronos/progress.md`.

Total: **292 tests** across 22 suites. Full build + test runs in ~9 s.

## Security hardening — summary

- scrypt N=131072 (matches ethers.js v6); maxmem=256 MB so the parameters actually run.
- AES-256-GCM with a random 96-bit nonce per lock + 128-bit auth tag. Re-locks produce fresh salt + nonce.
- Atomic writes + 0600 perms on all operator-owned files.
- `AUTOMATON_PASSWORD` env path validates min length on entry; CLI flag is unsupported.
- Keystore plaintext metadata (network, address, publicKey) cross-checked via re-derivation on every unlock.
- Preflight gate catches the `file:` dep snapshot traps that cost hours to diagnose as runtime errors.
