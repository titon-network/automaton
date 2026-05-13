# Automaton — AI Development Guide

> **Fast jump:** writing code → §AI navigator · debugging → §Debugging symptoms · architecture → §Key design decisions. House rules in [`CONTRIBUTING.md`](CONTRIBUTING.md); operator-facing surface in [`README.md`](README.md).

> **Helping a user deploy?** Skip to [`docs/deploy.md`](docs/deploy.md) — opens with a 30-second decision table mapping "user says X" → exact command sequence for that path (playground / local testnet / Lightsail / self-hosted Docker / systemd). Common errors + faucet/RPC notes at the bottom of that file.

> **Helping a user enable Fortuna?** The full prerequisite chain is: stake at ForgeTON → Atlas admitted as a ForgeTON consumer (one-time, ForgeTON-owner-driven) → operators force-synced into Atlas's map (only if they predate the admission) → `automaton bls keygen` (or import) → `automaton bls register`. The Atlas-admission step is one operators trip on — `RegisterBlsShare` reverts with `OperatorNotFound (120)` until ForgeTON is fanning out `AutomatonSync` to Atlas. See `../atlas/sdks/typescript/skills/atlas-deploy.md` §Step 2.
>
> **Solo-mode caveat.** In Atlas solo-mode (memberCount=1, threshold=1, dev/testnet only), the operator's `pkShare` MUST equal `groupPk` — Atlas enforces this on-chain at register time (`E_SOLO_PK_SHARE_MISMATCH = 161`). The right onboarding flow is operator-first: (1) `automaton bls keygen` → operator owns the BLS secret locally; (2) `automaton bls pubkey` → operator hands the public 48-byte pkShare hex to the Atlas owner; (3) Atlas owner runs `pnpm run publish:groupkey:testnet -- --pkshare <hex>` — that pkShare IS the published groupPk; (4) operator flips `products.fortuna: true` in config, then runs `automaton bls register`. **No `GROUP_SK_TESTNET` shared-secret exists**; the operator never receives a key. **`automaton bls register` pre-flights the equality** as defense-in-depth so the operator gets a clear local error before broadcasting a guaranteed-revert tx. **Atlas-owner balance gotcha**: if the owner wallet has < ~0.16 TON, the publish silently fails — V5R1 advances seqno + eats fees but the action phase drops the outbound; tonscan shows the wallet's last tx with `out_msgs: []` and `getGroupKey(0)` stays null. Faucet to ≥ 0.5 TON before publishing. **Full operator-first runbook with copy-paste commands lives at [`docs/fortuna-solo-mode.md`](docs/fortuna-solo-mode.md)** — load that when helping a user enable Fortuna in solo-mode. Multi-op DKG groups (mainnet path) skip the equality check.

> **Slash commands** (Claude Code sessions, via [`.claude/commands/`](.claude/commands/)): `/navigate <task>` — task→file lookup · `/dev <args>` — run CLI via ts-node · `/playground [<flags>]` — local sandbox demo · `/verify` — full gate · `/test-one <name>` — scoped jest · `/preflight` · `/explain-error <code>` · `/new-subcommand` · `/new-handler` · `/new-metric` · `/new-config-field`. Every recipe resolves to a concrete edit; full catalogue in [`docs/dx.md`](docs/dx.md) §Slash commands.

## What is this project?

`@titon-network/automaton` is the **universal off-chain operator node** for the Titon protocol suite on TON. Operators install and run it to stake with ForgeTON (shared-security pool) and earn across every admitted consumer product — Kronos (automation), Fortuna (verifiable randomness), Themis (sealed-bid threshold-decryption), and any future product wired in via `config.products.<name>`.

Per-product responsibilities:
- **Kronos** (baseline): poll the registry, sign+send `Execute` for due jobs, react to slash events.
- **Fortuna** (opt-in via `products.fortuna`): hold a BLS12-381 pkShare registered at Atlas, watch Fortuna's request stream, sign alpha with the BLS secret, and submit `FulfillRandomness` before the deadline. Solo-mode (t=1, n=1) is the testnet-canary path. Multi-op additive `t=n` (sign + share-exchange via HTTP → aggregate → leader-elected submit) shipped in phase 2; full spec at [`docs/multi-op-fortuna.md`](docs/multi-op-fortuna.md).
- **Themis** (opt-in via `products.themis` + `config.themis.chambers`): for each configured chamber, observe `RoundStarted`/`BidSubmitted` events; once the commit window closes, threshold-decrypt every cached bid (`D = sk · c1` in solo-mode), BLS-sign the reveal payload over `(chamberBinding, roundId, groupEpoch, decryptionsRoot)`, submit `RevealRound` before `revealEta`. Same BLS secret as Fortuna (Atlas group secret) — one `bls.enc` covers both. v1 is **solo-mode only**; multi-op share-exchange + auto-discovery via the factory's `ChamberDeployed` events are deferred to v1.1.

Design goal: *super easy to launch, hassle-free, production-ready*. `automaton init` → `automaton stake register` → `automaton run` is the Kronos onboarding flow; add `automaton bls keygen` → `automaton bls register` when enabling Fortuna. Themis adds nothing further on the operator side beyond `products.themis: true` + a chamber list — the same BLS share signs reveals. `automaton doctor` / `automaton status` for diagnostics.

## Tech stack

Node.js ≥22 (preflight-gated), TypeScript 5.5+ strict/NodeNext CJS, `commander` v12, `zod`, `pino` (with structural redaction), `prom-client`, `@ton/core` + `@ton/ton` (`WalletContractV5R1`), `@ton/crypto` for BIP-39, Node's `crypto` for scrypt+AES-256-GCM, BLS12-381 via `@noble/curves/bls12-381` (routed through `@titon-network/fortuna-sdk`), Jest+ts-jest `--runInBand` with 1 GB per-worker heap. `@titon-network/forgeton-sdk` + `@titon-network/kronos-sdk` + `@titon-network/atlas-sdk` + `@titon-network/fortuna-sdk` + `@titon-network/themis-sdk` are sibling `file:` deps — pnpm **copies** them at install, does NOT live-link.

## Commands

```bash
pnpm install          # includes postinstall preflight (warn-only)
pnpm run build        # tsc → dist/
pnpm run test         # jest --runInBand, preflight first
pnpm dev <args>       # ts-node source-run (NB: `pnpm dev`, not `pnpm run dev --`)
pnpm run preflight    # sibling-SDK landmine scan
pnpm run verify       # build + test + smoke (the single gate before claiming "done")
pnpm run sync:sdks    # rebuild+reinstall after editing sibling SDKs
```

> ⚠️ **SDK snapshot staleness.** Edit `../forgeton/sdks/typescript/src/` or `../kronos/sdks/typescript/src/` → this repo is instantly stale. Run `pnpm run sync:sdks`. `tests/preflight.ts` catches the common failure (missing `dist/`) at test start.

## AI navigator — "I want to X, where do I look?"

| Task | Primary file(s) | Supporting |
|------|-----------------|------------|
| Add a new CLI subcommand | `src/cli/commands/<name>.ts` | Register via `registerXCommand(program)` in `src/cli/index.ts`; follow the stub pattern (each file is one command tree). Examples: `completion.ts` (static shell scripts), `config.ts` (nested `show` subcommand), `bls.ts` (nested `keygen`/`pubkey`/`register`/`deregister` on a single parent) |
| Change the playground / local sandbox demo | `src/playground/demo.ts` | `runPlayground(opts)` orchestrates: `createSandboxHarness({ withFortuna })` → register demo automaton → schedule Kronos job + (optionally) bootstrap Fortuna BLS solo group → loop calling `tickOnce` with both workers. Sandbox infra in `src/playground/sandbox-runtime.ts` (lifted from `tests/helpers/chain.ts`; tests re-export). CLI surface is `src/cli/commands/playground.ts`. Drift guard: `tests/cli-playground.spec.ts` |
| Inject a sandbox-friendly I/O boundary into a worker | `KronosWorker.submitExecute?` (`src/worker/loop.ts`) · `FortunaWorker.sender?` + `FortunaWorker.submitFulfill?` (`src/worker/fortuna.ts`) · `ThemisWorker.sender?` + `ThemisWorker.submitReveal?` (`src/worker/themis.ts`) | Worker constructors accept optional injection points so sandbox callers (the playground, integration tests) can route through `treasury.getSender()` instead of the production V5R1-wallet seqno-poll path. Same pattern across all three workers — mirror it for new product workers. |
| Add / change a BLS identity op | `src/cli/commands/bls.ts` + `src/bls/keystore.ts` | bls.enc is parallel to wallet.enc (scrypt+AES-256-GCM), plaintext holds the 48-byte pkShare so `pubkey` works without a password |
| Wire a new consumer product | Create `src/products/<name>.ts` implementing `ProductModule` (template: `src/products/fortuna.ts`); add `<name>: z.boolean()` to `ConfigSchema.products`; append to `PRODUCTS` in `src/products/index.ts`. The orchestrator, event drain, deployment resolver, schema check, error explainer, doctor, and status all iterate `PRODUCTS` — no further changes. See §"Adding a new product" below for the full guide. |
| Change the Fortuna fulfillment path | `src/worker/fortuna.ts` | `FortunaWorker.eventHandler()` keeps the pending queue in sync; `.tick()` iterates pending, signs via `signAlpha`, submits via `sendFulfillRandomness`. Two modes: solo (peers list empty, partial == aggregate, today's testnet canary) and multi-op additive `t=n` (peers list non-empty → sign + broadcast via `src/daemon/share-exchange.ts` → wait for `n` partials → leader-grace → `aggregateFortunaPartials` → submit). Full protocol spec: [`docs/multi-op-fortuna.md`](docs/multi-op-fortuna.md). Phase-2 of the multi-op rollout shipped — orchestrator wiring + sandbox integration test still pending (phase 3). |
| Change the Themis reveal path | `src/worker/themis.ts` | `ThemisWorker.eventHandler()` accumulates per-chamber state from `RoundStarted` / `BidSubmitted` / `RoundRevealed` / `RoundExpired` / `OperatorSynced` / `GroupKeyCached`; `.tick()` iterates chambers, evaluates a 9-gate decision tree (mirrored / group-key / round / settled / in-flight / bids / eta-known / commit-closed / reveal-window-open), then for each ready chamber threshold-decrypts (`D = sk · c1`), calls themis-sdk `buildReveal({ chamber, roundId, groupEpoch, entries, groupKey })`, submits via `sendRevealRound`. Cold-start probe via `getOperator` + `getCurrentRound` + `getGroupKey` so the first tick can act without waiting for the next event. Per-chamber config cache (5min TTL, dropped on chamber `ConfigUpdated`) sizes the value attachment. v1 is solo-mode + static `config.themis.chambers` only — multi-op share-exchange + auto-discovery from factory `ChamberDeployed` events are v1.1. |
| Change the Themis ProductModule wiring | `src/products/themis.ts` | Resolves atlas / forgeton / factory + `chamber:<addr>` keyed entries via `themisChamberAddrKey()` / `isThemisChamberKey()` helpers (exported from `src/worker/themis.ts`). Event sources are `themis-factory` + one `themis-chamber:<addr>` per chamber via `chamberSourceKey()`. `buildHandlers` extracts chamber addresses from `ctx.contracts` then registers explicit per-source callbacks (no Proxy — matches fortuna's pattern). Reveal-error hint: pass `origin: 'themis'` to `sendAndConfirm` so themis exit codes 152-179 route to the right explainer. |
| Add an interactive prompt | `src/cli/prompt.ts` | `promptText` / `promptChoice` / `promptConfirm` — all throw `NotInteractiveError` on non-TTY; use a flag escape hatch for CI |
| Add a new config field | `src/config/schema.ts` | If runtime-tunable, add env override in `src/config/load.ts` (`applyEnvOverlay`); default goes in `defaultConfig()`; bump `CONFIG_VERSION` if semantics change |
| Add an env var override | `src/config/load.ts` | Narrow allow-list — `applyEnvOverlay` re-uses schema validators so types stay honest |
| Change where a file lives | `src/config/paths.ts` | Every filesystem path lives here as a pure function (re-reads env per call) |
| Add a `doctor` check | `src/cli/commands/doctor.ts` | Install-scoped? push into `buildInstallChecks`. Config-scoped? `buildConfigChecks`. On-chain? `buildChainChecks`. Each `Check.run()` returns `{ status, detail }` where status is `ok` / `warn` / `fail` / `skip`; failures gate exit, warnings don't. |
| Surface on-chain field in `status` | `src/cli/commands/status.ts` | Add a field to `ChainSnapshot`, read it in `collectChainSnapshot` via a `tryAsync` wrapper (never crashes the status output), and print in `renderStatus` |
| Add a new deployment (e.g. mainnet) | `src/chain/deployment.ts` | Add the `case` and pull addresses from whatever SDK constant lands; `deployment.spec.ts` has the matching case |
| Send a tx from the automaton wallet | `src/chain/submit.ts` | `senderFor(client, wallet)` builds the Sender; `sendAndConfirm(...)` wraps the send with seqno-advance polling + explorer URL; `waitForSeqnoAdvance` is the reusable core. **Always pass `origin: '<sdk>'`** in the options — that's what lets `PoolRejectedError` resolve cross-SDK exit-code overlaps and (when `verify` fails without a code in its inner exception) drives a one-shot bounce-trace inspection of the destination contract's recent txs. Pinned by `tests/DocsSurface.spec.ts › sendAndConfirm callers pass origin`. |
| Size a pool message | `src/chain/stake-cost.ts` | `registerValue` / `increaseStakeValue` / `requestUnstakeValue` / `finalizeUnstakeValue` / `cancelUnstakeValue` match the on-chain floors |
| Add a stake subcommand | `src/cli/commands/stake.ts` | Thread it through the shared `loadContext` → pre-state validation → `submit()` helper so the progress output + error handling stays uniform |
| Change the Kronos decide tree | `src/worker/decide.ts` | Pure function `decide(input) → { action, reason, ... }`; add a `DecisionReason` tag and update the test matrix in `decide.spec.ts` |
| Touch the worker poll loop | `src/worker/loop.ts` | `runWorkerCycle(deps)` does one iteration — ensure mirror freshness, iterate jobs, decide, submit. `submitExecute` is injectable for tests |
| Change mirror caching | `src/worker/mirror.ts` | `AutomatonMirror.ensureFresh()` refreshes when activeCount changes (tick-path); `refresh()` is unconditional (event-handler path — called by `mirrorPatchHandler` on `AutomatonMirrorUpdated`) |
| Add an event handler | `src/worker/handlers.ts` (baseline ForgeTON) or `src/products/<name>.ts` (per-product) | Write a factory returning `EventHandler`. The shape is `{ on?: { [source]: (event, ctx) => … }, onCycleEnd?(): … }` — register the callback under each `EventSource.source` string you care about (`'pool'` for ForgeTON, `'registry'` for kronos, `'fortuna'` for fortuna, `THEMIS_FACTORY_SOURCE` + `chamberSourceKey(addr)` for themis). `drainEvents` orchestrates dispatch. Existing handlers as templates: `mirrorPatchHandler` (debounce via `onCycleEnd`), `selfSlashHandler` (filter on `me`), `forgetonAwarenessHandler` / `kronosAwarenessHandler` / `fortunaAwarenessHandler` / `themisAwarenessHandler` (per-protocol awareness), `forgetonHealthHandler` / `kronosHealthHandler` / `fortunaHealthHandler` / `themisHealthHandler` (protocol health log), `fortunaConfigInvalidatorHandler` / `themisConfigInvalidatorHandler` (drop worker cache on `ConfigUpdated`). |
| Wire an event handler into the daemon | `src/daemon/orchestrator.ts` `buildHandlers()` + the `if (config.products.fortuna)` block | `buildHandlers()` returns the always-on handlers (mirror patch, self-slash, consumer watch). Per-product handlers (e.g. `fortunaWorker.eventHandler()`) are pushed onto the returned array inside the product-specific block before `drainEvents` is called the first time |
| Wire a per-product worker into the daemon tick | `src/daemon/orchestrator.ts` `tickOnce()` + `runDaemon`'s product-specific block | Pattern: instantiate worker alongside `FortunaWorker`, push its handler, add it as an optional field on `TickDeps`, invoke `.tick()` after `runWorkerCycle` inside `tickOnce`, wait for `hasInFlight()` in the shutdown drain predicate |
| Change event polling / checkpoint | `src/worker/events.ts` + `src/worker/checkpoint.ts` | `drainEvents(deps)` walks transactions backward to the stored checkpoint; state lives in `~/.titon/automaton/state.json` (zod-validated) |
| Change daemon startup order | `src/daemon/orchestrator.ts` | `runDaemon()` composes lockfile → keystore unlock → runtime → schema check → event handlers → main loop → graceful shutdown. Order matters and is documented at the top of the file |
| Tune daemon timers | `src/daemon/loop.ts` | `abortableSleep`, `loopCycles`, `waitForDrain` — all AbortSignal-driven, cleanly cancellable |
| Change daemon log format | `src/daemon/logger.ts` | `createPinoLogger({ level })` is the production default (with redacted paths). `createConsoleLogger` is a simpler alternative for tests |
| Add a new metric | `src/daemon/metrics.ts` | Add to the one returned `DaemonMetrics` bundle; document in the `help` string; use bounded labels only |
| Change health/readiness semantics | `src/daemon/http.ts` | `/healthz` reads `liveness()` (staleness-gated), `/readyz` reads `readiness()` (array of subchecks). Both called fresh per request |
| Add a retry-with-backoff to any async op | hand-rolled loop in the caller | `src/errors/backoff.ts` exports `jitteredBackoff` (equal-jitter math) + `defaultSleep` (ref-ed timer). See `FailoverTonClient.call` and `sendAndConfirm` for the two existing patterns — copy whichever fits |
| Explain a TVM exit code to an operator | `src/errors/explain.ts` | `explainExitCode(n)` returns `{code, origin, name, message, hint?}` — picks the right SDK (kronos 100-119 / forgeton 160-182 / tvm 1-100); `extractExitCode(err)` pulls it off SDK errors or parses `exit code N` out of sandbox error strings |
| Cut a release | `scripts/release.sh <bump>` | Dry-run by default; prints the mutating plan (tests + version bump + build + tag + commit) and the next-steps for `npm publish` + `docker buildx`. Pass `--apply` to execute |
| Build the Docker image | `Dockerfile` + `.dockerignore` | Build context is the parent dir (so sibling SDKs are visible). `docker buildx build --platform linux/amd64,linux/arm64 -t titon/automaton:X -f automaton/Dockerfile .` |
| Install the systemd unit | `contrib/automaton.service` | Copy to `/etc/systemd/system/`, install `automaton.env.example` at `/etc/automaton.env`, fill in `AUTOMATON_PASSWORD`, `systemctl daemon-reload && systemctl enable --now automaton` |
| Deploy on AWS — Lightsail (testnet, hobbyist) | `contrib/aws/lightsail/` | Lightsail-only (~$3.50/mo `nano_3_0`, ~$5/mo `micro_3_0` for the Fortuna leg). Keystore-mode bootstrap (operator runs `automaton init` locally; mnemonic stays off AWS; `wallet.enc` + optional `bls.enc` ride in Terraform state — encrypt the backend). Optional `bls_keystore_file` knob enables Fortuna alongside Kronos. Validated via `terraform validate` + `terraform fmt`. See the module's README for the full quickstart + security trade-offs. The team's testnet canary runs on this. |
| Deploy on AWS — EC2 (mainnet, production) | `contrib/aws/ec2/` | EC2 t4g.small + Docker container under systemd, ~$12/mo on-demand (~$7/mo Savings Plan). **SSM-mode bootstrap** — the encrypted `wallet.enc`, password, optional `bls.enc` live in SSM Parameter Store (KMS-encrypted, IAM-scoped) and are NOT in Terraform state. Multi-region by instantiating once per region with its own `ssm_path`; the workspace at `automaton-mainnet/{eu-central-1,us-east-1}/` is the team's reference layout (sibling to `automaton-testnet-canary/`). SSM Session Manager for shell access (no inbound port). Recommended for mainnet positions; see `contrib/aws/ec2/README.md` for the operator quickstart and `automaton-mainnet/RUNBOOK.md` for the per-region onboarding playbook. |
| Change keystore format | `src/wallet/keystore.ts` (TON wallet) or `src/bls/keystore.ts` (BLS secret) | Bump `KEYSTORE_VERSION` / `BLS_KEYSTORE_VERSION`; store migration path in the same file |
| Change wallet derivation | `src/wallet/wallet.ts` | V5R1 is network-aware — mainnet/testnet produce different addresses from the same mnemonic; keystore must continue to carry the network |
| Change BLS signing | `src/bls/index.ts` + `src/worker/fortuna.ts` | `signAlpha` / `blsPublicKey` are re-exported from fortuna-sdk; alpha preimage byte-identity is enforced by `computeAlpha` |
| Persist a new file atomically | `src/util/atomic-write.ts` | `atomicWriteFile(path, data, mode)` — used by both config and keystore; use it for any other persistent file |
| Call a TON RPC with retry/failover | `src/chain/ton-client.ts` | `new FailoverTonClient({ endpoints, … }).call(fn)` — rotates endpoints on transient errors (timeout, 429, 5xx) with jittered exponential backoff |
| Open a contract wrapper (registry/pool) | `src/chain/ton-client.ts` | `failover.open(KronosRegistry.createFromAddress(addr))` — every `.get*()` / `.send*()` goes through the failover machinery automatically |
| Acquire single-instance lock | `src/chain/lockfile.ts` | `acquireLock()` at startup / `releaseLock()` at shutdown; handles live-pid contention + stale cleanup automatically |
| Verify on-chain schema matches SDK | `src/chain/schema-check.ts` | `checkSchemaVersions({ client, registry, pool })`; refuse to start on mismatch with an upgrade-path message |
| Write a test | `tests/*.spec.ts` | `jest --runInBand`, 1 GB per worker; `tests/preflight.ts` fails fast on SDK snapshot issues |

## Debugging symptoms

| Symptom | Most likely cause | First place to look |
|---------|-------------------|---------------------|
| `PREFLIGHT FAILED — node_modules/<sdk>/dist/index.js is missing` | the `file:` dep snapshot is empty | `pnpm run sync:sdks` (rebuilds both SDKs then force-reinstalls) |
| `PREFLIGHT FAILED — ../<kronos\|forgeton>/sdk/node_modules exists` | someone ran `pnpm install` inside a sibling SDK | `rm -rf ../<sdk>/sdk/node_modules` — that nested install creates a duplicate `@ton/core` which breaks `Address instanceof` across package boundaries |
| `keystore decryption failed — wrong password or corrupt data` | wrong password OR a tampered ciphertext/tag/salt/nonce | AES-GCM auth tag — can't tell the cases apart by design; try the password again |
| `keystore integrity check failed — stored address … does not match derived address …` | plaintext `network` field was hand-edited in `wallet.enc` | Restore the original `network` in the keystore JSON; address is deterministic from (mnemonic, network) |
| `cannot prompt for password: stdin is not a TTY` | running in Docker / systemd without a TTY | Set `AUTOMATON_PASSWORD` env var |
| `config not found at …` | no `config.json` yet | `automaton init` |
| `AUTOMATON_NETWORK must be one of testnet \| mainnet` | unknown env value | Fix the shell export; overlay validates through the same zod schema as the file |
| dist/ missing at runtime | forgot to build | `pnpm run build` |
| `automaton is already running: pid X…` | prior `run` still holds the lock, or it crashed without cleanup | Check the pid (`ps -p X`); if dead, `rm ~/.titon/automaton/automaton.lock` |
| `lock file at … is corrupt` | hand-edit / partial write / older version | Confirm no automaton is running, then `rm` the file |
| `all N endpoint(s) failed after M attempt(s)` | upstream outage or all endpoints blocked (rate limit) | Check network; consider adding more endpoints to `config.endpoints`; confirm API keys are valid |
| `contract schema mismatch — refusing to start` | deployed contract schema ≠ SDK's expected version | Upgrade `@titon-network/automaton` (contract newer) or wait for deploy to land (SDK newer); see message for direction |
| `products.fortuna is enabled but bls.enc is missing` | Fortuna flag on, BLS keystore not yet created | `automaton bls keygen` |
| `products.themis is enabled but bls.enc is missing` | Themis flag on, BLS keystore not yet created (Themis reuses Fortuna's bls.enc — Atlas group secret) | `automaton bls keygen` |
| `BLS keystore decryption failed — wrong password or corrupt data` | same flow as wallet WrongPasswordError, applied to bls.enc | Try the password again; check the file hasn't been tampered |
| `atlas.getOperatorShare(me) returned no registered share after send` (Atlas-side internal message reverted with `OperatorNotFound` / 120) | Most common: Atlas isn't in ForgeTON's consumer set, so no `AutomatonSync` ever reaches Atlas → operator map is empty. Less common: ForgeTON record went inactive between pre-check and submit (Atlas would revert with `OperatorNotForgetonActive` / 121 in that case). | Verify with `pool.getConsumer(<atlas-addr>) === null`; if null, ForgeTON owner runs `forgeton/scripts/admitConsumer.ts` and a `ForceSync` per existing operator. See `../atlas/sdks/typescript/skills/atlas-deploy.md` §Step 2. If ForgeTON consumer is admitted, retry `automaton stake register` to re-activate. |
| `solo-mode pkShare mismatch` from `automaton bls register` | Atlas solo-mode group has `groupPk` ≠ this operator's `pkShare`. Pre-flight catches this BEFORE the register lands; on-chain Atlas enforces the same invariant via `E_SOLO_PK_SHARE_MISMATCH = 161`. | The published groupPk in solo-mode IS supposed to be exactly the operator's pkShare — see `../atlas/sdks/typescript/skills/atlas-operator-register-share.md` §"Solo-mode flow". If the keystore was overwritten, restore the bls.enc that matches groupPk OR ask the Atlas owner to rotate the group (3-step timelock) to adopt the current pkShare. Pinned by `tests/bls-solo-mode.spec.ts` + `atlas/tests/Atlas.spec.ts:"solo-mode pkShare-equality invariant"`. |
| `fortuna: request references a stale groupEpoch — giving up` | Atlas rotated mid-flight; our epoch binding is stale | Normal; the consumer should reclaim for refund. Re-register BLS share if the rotation changed group membership |
| `fortuna: request no longer live` | peer operator won the race OR consumer reclaimed | Informational; winner-takes-all is expected behavior in t-of-n |
| `themis: round no longer current (settled by someone else)` | Another operator submitted the reveal first OR `AdvanceRound` rolled the round over | Informational; in solo-mode you're the only operator so this only fires after `AdvanceRound` (a missed reveal). Operator should check that the daemon was running through `commitEta`. |
| `themis: skip reveal { reason: 'not-mirrored' }` | Chamber's `getOperator(self)` returned null — operator hasn't been mirrored yet via `AutomatonSync` fan-out from the factory | Verify the operator is active at ForgeTON (`automaton status`); the factory fans `AutomatonSync` out on the next state change, but bounded by `cfg.maxFanoutPerSync` — wait or trigger a fresh sync. |
| `themis: skip reveal { reason: 'no-group-key' }` | Chamber hasn't received `GroupKeySync` from the factory yet | Anyone can call `themis-factory.sendRebroadcastGroupKey` to force fan-out (audit fix INT-1); otherwise wait for the next factory cycle. |
| `themis: getOperator probe failed` | Cold-start RPC failure; will retry next tick | Transient — check endpoint health. Persistent failures point at `automaton doctor` / `automaton status` red flags. |

**Canonical sources (don't hand-edit):**

- `dist/` — generated by `tsc`. The `automaton` bin points at `dist/cli/index.js`.
- `node_modules/@titon-network/{forgeton,kronos,atlas,fortuna,themis}-sdk/` — snapshot copies from `file:` deps; run `pnpm run sync:sdks` after editing sibling SDK source.
- `pnpm-lock.yaml` — committed, managed by pnpm.

**Which docs to load (in priority order):**

1. **This file** — always.
2. **[`CONTRIBUTING.md`](CONTRIBUTING.md)** — house rules (version bumps, bounded label cardinality, idempotent handlers, atomic writes). Load before schema/metric/persistent-file work.
3. **`../kronos/progress.md` §Phase D** — cross-repo task plan. Load for "what's next" questions.
4. **`../kronos/CLAUDE.md`** — registry architecture, for `src/worker/*` work.
5. **`../forgeton/CLAUDE.md`** — pool architecture, for stake/slash work.
6. **`../fortuna/CLAUDE.md` + `../fortuna/PLAN.md` §5–6** — Fortuna wire types, alpha/beta derivation, operator submission protocol. Load for any `src/worker/fortuna.ts` or `src/cli/commands/bls.ts` work.
7. **`../atlas/CLAUDE.md` + `../atlas/PLAN.md` §0.2** — BLS12-381 primitives (G1 pkShare, G2 signature, DST), group-key lifecycle, operator share registration. Load for BLS crypto or RegisterBlsShare work.
8. **`../themis/CLAUDE.md` + `../themis/PLAN.md` §"Phase 3 — Off-chain operator pipeline"** — Themis wire types (`SignedReveal` 76-byte byte-aligned slice, `Decryptions` cell layout, `RevealCallback` payload shape), reveal protocol, parent-child factory architecture. Load for any `src/worker/themis.ts` or `src/products/themis.ts` work.
9. **`../BLUEPRINT.md`** — workspace-level entity+message-flow diagram. Load for cross-contract scope questions.

---

## Adding a new product

The automaton is a universal off-chain operator node — every titon
protocol that wants operator-side action (Kronos automation, Fortuna
VRF, future Phoebe price oracle, future Argus indexer …) plugs in
through the **`ProductModule` registry** at `src/products/`.

ForgeTON pool is the only true baseline (every operator stakes there
regardless of which products they enable). Kronos / Fortuna / Phoebe /
Argus / … are ALL ProductModules. The orchestrator, event drain,
deployment resolver, schema check, error explainer, doctor, and status
all iterate `PRODUCTS` — none of them hardcode product names. A
specialised operator (Phoebe-only oracle node) can disable Kronos
entirely; the daemon adapts.

**Three-line addition** for Phoebe (or any new product):

1. Author `src/products/phoebe.ts` implementing `ProductModule` (copy
   `src/products/kronos.ts` for a worker-bearing template, or
   `src/products/fortuna.ts` for an event-driven worker template).
2. Add `phoebe: z.boolean()` to `ConfigSchema.products` in
   `src/config/schema.ts`; default to `false` in `defaultConfig`.
3. Append the module to `PRODUCTS` in `src/products/index.ts`.

Done. No other file needs to change.

### What a ProductModule contributes

Each module declares (see `src/products/types.ts` for the full
interface):

| Method | Purpose |
|---|---|
| `name`, `description` | Identity + one-line summary. |
| `isEnabled(config)` | Reads `config.products[name]`. |
| `resolveAddresses(config)` | Per-network addresses (with config-override fallback) — landed in `runtime.deployment.products[name]`. |
| `openContracts(deps)` | `client.open(...)` for each contract — landed in `runtime.products[name]`. |
| `schemaChecks(deps)` | Tasks bundled into `checkSchemaVersions` startup gate. |
| `eventStreams(deps)` | One `EventSource` per emitting contract — drained per tick alongside baseline registry+pool streams. |
| `bootstrapWorker?(deps)` | Optional — instantiate a `ProductWorker` (FortunaWorker is canonical). Pure-observational products (Argus) leave this undefined. |
| `buildHandlers(deps)` | Built-in `EventHandler`s contributed by the product (config invalidator, per-self awareness, protocol health log). |
| `explainError(code)` | Routed into the unified `explainExitCode` walk. |
| `doctorInstallChecks()` | "@titon-network/X-sdk resolves" install-layer checks. |

### Reference implementations

- **`src/products/kronos.ts`** — poll-driven worker (`KronosWorker`
  iterates the registry every tick, decides which jobs to execute,
  sends `Execute` for each due slot). Use as the template for products
  whose work is driven by polling on-chain state.
- **`src/products/fortuna.ts`** — event-driven worker (`FortunaWorker`
  enqueues from `RequestCreated` events, signs alpha with a BLS share,
  submits `FulfillRandomness` before the deadline). Use as the template
  for products whose work is driven by inbound events the consumer
  initiated.

### Worked example: Phoebe (price oracle, operator submits price quotes)

```ts
// src/products/phoebe.ts
import { Phoebe, PHOEBE_TESTNET, PHOEBE_STORAGE_VERSION,
         decodeEvents as decodePhoebeEvents,
         explainError as explainPhoebeError } from '@titon-network/phoebe-sdk';
import type { ProductModule } from './types';

export const PHOEBE_SOURCE = 'phoebe' as const;

export const phoebe: ProductModule = {
    name: 'phoebe',
    description: 'Price oracle — operator signs + submits price quotes.',
    isEnabled: (cfg) => cfg.products.phoebe === true,
    resolveAddresses: (cfg) => cfg.products.phoebe
        ? { phoebe: cfg.network === 'testnet' ? PHOEBE_TESTNET.phoebe : ... }
        : {},
    openContracts: ({ client, addresses }) => addresses.phoebe
        ? { phoebe: client.open(Phoebe.createFromAddress(addresses.phoebe)) }
        : {},
    schemaChecks: ({ contracts }) => contracts.phoebe ? [{
        contract: 'phoebe',
        address: contracts.phoebe.address,
        expected: PHOEBE_STORAGE_VERSION,
        sdkVariable: 'PHOEBE_STORAGE_VERSION',
        read: () => contracts.phoebe.getSchemaVersions().then((v) => v.storage),
    }] : [],
    eventStreams: ({ addresses }) => addresses.phoebe ? [{
        source: PHOEBE_SOURCE,
        address: addresses.phoebe,
        decode: (bodies) => decodePhoebeEvents(bodies),
    }] : [],
    bootstrapWorker: async (deps) => new PhoebeWorker({
        phoebe: deps.contracts.phoebe,
        client: deps.client,
        wallet: deps.wallet,
        logger: deps.logger,
    }),
    buildHandlers: (deps) => deps.worker !== undefined
        ? [phoebeAwarenessHandler(deps.wallet.address, deps.logger)]
        : [],
    explainError: (code) => explainPhoebeError(code),
    doctorInstallChecks: () => [{
        name: '@titon-network/phoebe-sdk resolves',
        async run() { /* import + count exports */ },
    }],
};
```

Then in `src/products/index.ts`:

```ts
import { phoebe } from './phoebe';
export const PRODUCTS: readonly ProductModule[] = [kronos, fortuna, themis, phoebe];
```

### Worked example: Argus (indexer, pure observer, no worker)

Argus doesn't run on-chain transactions — it watches event streams
from existing contracts and forwards them to an indexer DB. From the
automaton's perspective, that's an `EventHandler` registered via
`buildHandlers` that POSTs decoded events to an off-chain endpoint.
There's no contract, so `resolveAddresses` returns `{}`,
`openContracts` returns `{}`, `schemaChecks` returns `[]`,
`eventStreams` returns `[]`, and `bootstrapWorker` is undefined. The
only useful method is `buildHandlers` (and `doctorInstallChecks` if
the SDK ships).

```ts
// src/products/argus.ts (sketch — Argus today is a separate process,
// but if we wanted automaton to forward events to it):
export const argus: ProductModule = {
    name: 'argus',
    description: 'Forward decoded events to an off-chain indexer.',
    isEnabled: (cfg) => cfg.products.argus === true,
    resolveAddresses: () => ({}),
    openContracts: () => ({}),
    schemaChecks: () => [],
    eventStreams: () => [],
    buildHandlers: ({ logger, config }) => [{
        // Listen on EVERY source — baseline + every other product.
        on: new Proxy({}, {
            get: () => async (event, ctx) => {
                await fetch(config.argus?.webhookUrl, {
                    method: 'POST',
                    body: JSON.stringify({ kind: event.kind, ctx }),
                });
            },
        }) as any,
    }],
    explainError: (code) => ({ code, origin: 'unknown', name: 'Unknown', message: '' }),
    doctorInstallChecks: () => [],
};
```

The Argus example illustrates the shape of an observational product —
no contracts, no schema checks, just an event sink. Adding Argus
doesn't touch any other file.

### Files that DO NOT change when adding a product

These iterate `PRODUCTS` (or call methods on enabled products):

- `src/chain/runtime.ts` — `buildChainRuntime` opens product contracts.
- `src/chain/deployment.ts` — `resolveDeployment` collects addresses.
- `src/chain/schema-check.ts` — `checkSchemaVersions` collects tasks.
- `src/errors/explain.ts` — `explainExitCode` walks product explainers.
- `src/cli/commands/doctor.ts` — `buildInstallChecks` collects SDK checks.
- `src/daemon/orchestrator.ts` — `runDaemon` bootstraps each worker
  + composes handlers + concatenates event sources for drain.
- `src/worker/events.ts` — `drainEvents` is data-driven from the
  passed `sources` list.

The orchestrator's iteration order is `PRODUCTS` registration order,
so any cross-product priority (e.g. `explainExitCode` first-non-unknown
walk) is deterministic and adjustable by re-ordering the array.

---

## Key design decisions

### Persistent files: atomic writes + schema versioning

All persistent files (config, keystore, state, lockfile) go through `src/util/atomic-write.ts` — tmp + explicit chmod (writeFileSync's `mode` is umask-masked) + rename. A crash mid-write leaves the old file intact. `CONFIG_VERSION` / `KEYSTORE_VERSION` are `z.literal(N)`; loaders reject mismatches; migration lives next to the bump. Path resolution is centralised in `src/config/paths.ts` as **functions** (re-read env per call) so tests can mutate `TITON_HOME` mid-run. `TITON_HOME` moves the root; `AUTOMATON_CONFIG` overrides just the config path. CLI-only package — `package.json` declares only `bin` (no `main`/`types`); programmatic callers go via the SDKs directly.

### BLS identity is decoupled from the TON wallet

A second keystore (`bls.enc`) holds a 32-byte BLS12-381 secret, separate from the
TON wallet's mnemonic. Rationale: the two identities serve different purposes
(wallet signs transactions; BLS signs VRF alphas) and have different future
storage paths (wallet stays soft-key + mnemonic backup; BLS may migrate to an
HSM / remote signer for multi-signer setups). Keeping them decoupled from day
one means the daemon's `BLS signer = X` surface is swappable without touching
the wallet code.

`bls.enc` stores the 48-byte G1 pkShare in plaintext (network-agnostic;
public-readable) so `automaton bls pubkey` works without a password. The
scrypt+AES-GCM discipline, atomic writes, and tamper-vector checks mirror
`wallet.enc` exactly — see `src/bls/keystore.ts` for the shape.

**v1 password model:** wallet + BLS unlock with the same password (daemon
flow asks once). This is ergonomic for single-operator onboarding but
breaks for multi-signer (operator + signer delegate). Phase F introduces
per-identity passwords; today's shared path doesn't lock out that future.

### FortunaWorker: in-memory pending queue, event-driven fulfillment

Unlike Kronos (polling `[0, jobCount)` each tick), Fortuna is event-driven:
the operator watches `EvtRequestCreated` and enqueues the request in an
in-memory `Map<reqKey-hex, PendingFortunaRequest>`. `RequestFulfilled` /
`RequestReclaimed` dequeue. Each tick iterates the queue, re-checks liveness
(`getRequest()` might report a race-lost or reclaimed request the event drain
hasn't caught up on yet), validates `groupEpoch` hasn't rotated, signs alpha,
and submits `FulfillRandomness`.

**Hex-keyed Map** because `bigint` keys are referentially fragile across the
decoder → handler → map boundary. The hex string has stable identity.

**No on-disk persistence** of the queue: on restart, we rebuild from events
after the checkpoint. Requests created BEFORE the checkpoint but still pending
at crash time are silently lost — the file header at `src/worker/fortuna.ts`
flags this as E.2 scope (an on-startup scan of recent Fortuna txs would
backfill). Fortuna deadlines are long (hours), so crash-then-recover inside
the deadline window is the common case.

**Deadline enforcement is proactive, not reactive.** Each tick checks
`now >= req.deadline` and drops expired requests from the queue — otherwise
the worker would keep trying to submit against a request that on-chain is
already reclaimable. The consumer's refund path runs independently; the
operator just stops wasting gas.

**Config cache (5 min TTL).** `sendFulfillRandomness` value = `submitterReward
+ minForwardReserve + fwd buffer`, read from Fortuna's on-chain config. The
config rarely changes (owner-timelocked UpdateConfig), so a short cache
covers most ticks without re-reading per fulfillment.

### Keystore is network-aware

`WalletContractV5R1` bakes network globalId (-239 mainnet / -3 testnet) into walletId → same mnemonic yields **different addresses** per network. Keystore records `network` plaintext; on unlock: (1) AES-GCM tag check, (2) re-validate mnemonic BIP-39, (3) re-derive address and compare against stored. Defense-in-depth catches ciphertext *and* plaintext-metadata tampering.

**Password flow**: `AUTOMATON_PASSWORD` env (for Docker/systemd) or raw-mode TTY prompt. No `--password` flag — would leak to shell history. `getPassword` validates min length.

**Scrypt**: `N=131072` prod (matches ethers.js v6, ~300-500 ms/unlock, `maxmem=256 MB` so it actually runs). Tests pass `kdfN: 2048` via `LockOptions` to stay fast. Crypto primitives identical — tamper vectors still meaningful. AES-256-GCM with random 96-bit nonce + 128-bit tag; re-locks produce fresh salt + nonce. All operator-owned files 0600.

### Doctor: ok/warn/fail/skip semantics

`automaton doctor` builds checks at runtime in layers: install-scoped always (node version, SDK resolvability, pkg version) → config-scoped skipped cleanly when absent (cross-checks config/keystore `network`) → chain-scoped skipped when deployment unknown (RPC reachable, wallet balance vs `minFreeBalance`, schema versions, registry admitted on pool) → runtime-scoped always (lockfile state). Each returns `{ status, detail }`. Only `fail` gates exit. `warn` = "works but fix this." `skip` = "prerequisite missing." TTY-coloured; plain otherwise.

### Status is best-effort — chain errors never crash it

`automaton status` queries 7 pieces of chain state in parallel; each wrapped in `tryAsync` that pushes errors into a footer array. Dead RPC surfaces as "balance: ECONNRESET" — operator still sees everything else, which is the whole point during an outage. `pool.getAutomaton(walletAddr)` returns null for "not registered" / full struct otherwise.

### Worker architecture: pure decide / I/O loop / timer daemon

1. **`decide(input)` (`src/worker/decide.ts`)** — pure. Job state × window × assignment → `{ action, reason, detail, window, assigned }`. Every path has a machine-readable `reason` tag — authoritative list for Prom label cardinality.
2. **`runWorkerCycle(deps)` (`src/worker/loop.ts`)** — one tick. Ensure mirror → fetch config/jobCount/paused in parallel → iterate `[0, jobCount)` → decide → submit Execute. Single-flight via `Set<bigint>` on jobId (slow RPC can't let next tick double-submit). Per-job fetch failure can't abort the cycle.
3. **`runDaemon` (`src/daemon/orchestrator.ts`)** — wraps cycle in `loopCycles(pollIntervalMs)` + lockfile + signal handlers + health server + graceful shutdown. `tickOnce(deps)` exports the compose step for integration tests.

`submitExecute` is injectable — prod passes `defaultSubmitExecute` (real `sendAndConfirm` + post-state verify); sandbox tests pass `harness.submitExecuteVia(treasury)`.

### Mirror: `ensureFresh` on tick, `refresh` on event

`AutomatonMirror` has two methods for two call-sites: `ensureFresh()` is count-gated (skips per-slot re-fetch if `getActiveAutomatonCount` unchanged — swap-and-pop can drift, but a wrong-slot Execute just fails and the next cycle fixes it); `refresh()` is unconditional, called by `mirrorPatchHandler` on every `AutomatonMirrorUpdated`. `registry.getActiveAutomatonCount()` is authoritative; **don't** substitute `pool.getAutomatonCount()` — that's the pool's zombie-inclusive lifetime counter.

### Event drain + checkpoint survive restarts

`drainEvents(deps)` pages `getTransactions` backward until the last-processed `(lt, hash)` in `state.json`, reverses (oldest-first), decodes external-out bodies via all three SDKs. Unknown opcodes return `null` and are silently skipped — forward-compat safe (new event types from a contract upgrade don't crash, they just don't fire handlers until the SDK is taught). Built-in handlers wired by `runDaemon`:

- **`mirrorPatchHandler`** (registry) — debounces `AutomatonMirrorUpdated` and calls `mirror.refresh()` once per drain via `onCycleEnd`.
- **`selfSlashHandler`** (pool) — filters `AutomatonSlashed` for self, logs at warn, POSTs to `config.alertWebhookUrl`, increments `selfSlash` counter. **Never throws** — webhook failures caught + logged so a slash can't crash the daemon.
- **`consumerWatchHandler`** (pool) — logs `ConsumerUpdated` for observability.
- **`automatonAwarenessHandler`** (all three streams) — catch-all for events naming THIS automaton: kronos `AssignedAutomatonMissed` / `JobExecuted`, forgeton stake lifecycle (`AutomatonRegistered` / `StakeIncreased` / `UnstakeRequested` / `UnstakeCancelled` / `Unstaked`) + `AutomatonOptInChanged` + `AutomatonPruned` + `ForceSyncTriggered`, fortuna `OperatorMirrored`. Surfaces "you missed an assigned slot", "owner pruned you", "you got opted-into consumer X" without polling.
- **`registryHealthHandler`** (all three streams) — non-self protocol health: kronos / forgeton / fortuna `ConfigUpdated`, `PausedChanged`, `CodeUpdated`, upgrade-lifecycle (`UpgradeProposed` / `UpgradeCancelled`), kronos `TreasuryUpdated` / `HousekeepingJobSet` / `ForgetonSet` / `SlashRetried`, forgeton `ConsumerSlashCapUpdated`, fortuna `GroupKeyCached` / `FeesWithdrawn` / `CodeUpgrade*`. Logs at info; warns on adverse transitions (paused, group-key rotation, code upgrade).
- **`fortunaConfigInvalidatorHandler`** (fortuna only, when products.fortuna) — drops the `FortunaWorker.configCache` on `ConfigUpdated` so the next `FulfillRandomness` re-reads the live `submitterReward` + `minForwardReserve` instead of waiting out the 5-minute TTL.

Checkpoint advances ONLY after dispatch. Mid-drain crash re-reads same events — handlers **must be idempotent**.

### Daemon startup order (`runDaemon`)

Strict order; each step depends on prior: load config+keystore → acquire lockfile (second daemon exits here with `LockHeldError`) → unlock wallet → build chain runtime → schema-check → load checkpoint → wire handlers → install SIGTERM/SIGINT/SIGHUP → `loopCycles` (drain → save checkpoint → `runWorkerCycle` → sleep) → on abort `waitForDrain(inFlight.size==0, 30s)` → final saveCheckpoint → exit → `finally { releaseLock() }`.

All cancellation through one `AbortController`. `abortableSleep` clears its timer on abort. `loopCycles` never lets a tick throw abort the loop. SIGHUP is warn-and-ignore (config-reload-without-restart is future). Tests inject `externalAbort: AbortSignal` for deterministic shutdown.

### Schema check gates startup

`checkSchemaVersions` reads `storageVersion` from both registry+pool, compares against SDK-bundled `REGISTRY_STORAGE_VERSION`/`FORGETON_STORAGE_VERSION`. Mismatch → `SchemaMismatchError` with upgrade-direction hint. Refuse rather than silently misinterpret state. Optional `fetcher` param so tests exercise comparison without a sandbox.

### Stake subcommands pre-check on-chain state

Every `automaton stake *` loads pool config + consumer count + this automaton's record, refuses early on wrong pre-state ("already registered" / "not registered" / "unstake already pending" / "cooldown not elapsed") — one-line error before wallet unlocks beats 500 ms RPC → revert. Message values computed from pool config, not constants: `registerValue = stake + minGasForRegister + consumerCount × syncGasCost` (mirrors `handleRegisterAutomaton`). If owner bumps `syncGasCost` or admits a consumer, tx sizing follows automatically. `WALLET_GAS_BUFFER = 0.1 TON` headroom so errors mention exact shortfall vs cryptic seqno timeout.

### Failover is a property of the client, not the caller

`FailoverTonClient` wraps `@ton/ton`'s `TonClient`. Two surfaces: `.call(fn)` for ad-hoc ops; `.open(contract)` wraps `@ton/core`'s `openContract` with a `ContractProvider` that delegates every method through `.call` — so every `registry.getX()`/`pool.sendY()` transparently inherits retry/rotate.

**Transient**: `ECONNRESET`/`ECONNREFUSED`/`ECONNABORTED`/`ETIMEDOUT`/`ENOTFOUND`/`EAI_AGAIN`/`EPIPE`/`ERR_NETWORK`, HTTP 429, HTTP 5xx. Everything else (4xx non-429, malformed response, exit-code throws) is permanent — re-throw immediately.

**Backoff**: equal-jitter exponential `sleep = base·2^(n−1)/2 + rand[0, base·2^(n−1)/2)`, capped at `maxBackoffMs`. Prevents N automatons retrying in lockstep. On `maxAttempts` exhaustion wraps the last transient error in `AllEndpointsFailedError` with attempt count + endpoint list.

**Sleep ref-ness matters.** Retry sleeps use `defaultSleep` from `src/errors/backoff.ts` — a plain `setTimeout` that keeps the event loop alive. An `.unref()`-ed timer would let one-shot CLI commands exit mid-await: when `automaton status` / `stake register` fan out parallel chain reads and all hit a 429 backoff, the retry timer is the only pending work; if it doesn't keep the loop alive, Node exits cleanly with no output and exit code 0. The daemon's main poll loop has its own non-unref-ed timer so it's unaffected. Pinned by `tests/backoff.spec.ts › defaultSleep`. **Don't add private `setTimeout(...).unref()` retry sleeps elsewhere** — use `defaultSleep` for any retry path that must complete. The single legitimate `.unref()` lives in `src/worker/handlers.ts` (webhook deadline; never blocks shutdown).

### Single-instance lock via PID

`~/.titon/automaton/automaton.lock` holds `{ version, pid, startedAt }`. Acquire: `open(path, 'wx')` atomic "create-only"; EEXIST triggers live-pid check via `process.kill(pid, 0)`; dead → unlink+retry once; EEXIST again = race with another stale-cleaner → throw loudly. Release is idempotent and PID-matched. Corrupt locks never auto-removed — operator-only cleanup. Inherent PID-reuse limitation: if OS recycled the PID we refuse to start (safer than the inverse); `startedAt` gives operators the manual-`rm` signal.

### `init` is idempotent, TTY-aware, CI-friendly

Three flags (`--network`, `--import-mnemonic <file>`, `--password-file <file>`) individually disable prompts — pass all three = fully non-interactive. If `config.json` OR `wallet.enc` exists → refuses with a message listing every path that would be overwritten. Write order: **keystore first, config second** (no orphan config pointing at missing wallet). New-mnemonic branch is **interactive-only by design** — printing mnemonics in CI logs is a footgun we won't ship; operators who need scripted generation mint out-of-band and use `--import-mnemonic`.

### Errors surface human text — not stack traces

- **TVM exit codes** via `explainExitCode(n)` → `{origin, name, message, hint?}`. kronos 100-119 / forgeton 160-182 / TVM 1-100 — helper tries both SDKs in order. `extractExitCode(err)` pulls from SDK `exitCode`, numeric `code`, or `exit code N` substring. CLI top-level catch prints raw `error: <message>` + explanation when a code is extractable.
- **Typed errors** (`PoolRejectedError` / `LockHeldError` / `InsufficientWalletBalanceError` / `CheckpointStateError`) are already self-describing; CLI prefers their message, exit code is additive.
- **Uncaught exceptions / unhandled rejections** in the daemon log at `error` (redacted pino) and abort the main `AbortController` → graceful shutdown → systemd `Restart=on-failure` respawns. We never die silently.

### Metrics + logs + health: one source of truth each

- **Logs (`src/daemon/logger.ts`)**: pino structural redaction on `password`/`mnemonic`/`privateKey`/`seed`/`secretKey` at top-level AND one level deep — `logger.info('x', { password: 'hunter2' })` becomes `[Redacted]` regardless of call-site discipline.
- **Metrics (`src/daemon/metrics.ts`)**: every counter/gauge/histogram declared in one file with a `help` string. Fresh Registry per `createDaemonMetrics()` — no global state leaks between test runs. Use **bounded labels only**.
- **Health (`src/daemon/http.ts`)**: `/metrics` / `/healthz` / `/readyz` on `127.0.0.1:metricsPort` (local-only; reverse proxy for remote scrape). `/healthz` 200 iff last cycle within `2×pollIntervalMs` (floor 10s). `/readyz` 200 iff every sub-check passes (lockfile held, wallet unlocked, stake active, RPC reachable); body lists per-check status so `curl /readyz` tells operators exactly what's red.

### Distribution

- **npm** (`pnpm publish --access=public`). `prepublishOnly` cleans/rebuilds/chmods `dist/cli/index.js`/verifies shebang. **Known limitation**: SDK `file:` deps mean public `npm install` would fail until SDKs published.
- **Docker** (`docker buildx build -f automaton/Dockerfile .`). **Build context = parent dir** so Dockerfile sees sibling SDK sources. Multi-stage `node:22-alpine` builder (builds both SDKs sequentially → automaton) → `distroless/nodejs22-debian12:nonroot` runtime (UID 65532, ~90 MB). Multi-arch linux/amd64,arm64. No `automaton init` at container build — mount pre-initialised `TITON_HOME`.
- **systemd** (`contrib/automaton.service`). `User=automaton`, `Restart=on-failure`, `RestartPreventExitStatus=75` (prevents `EXIT_LOCK_HELD` loop), full sandbox (`ProtectSystem=strict`, `NoNewPrivileges`, `RestrictNamespaces`, `MemoryDenyWriteExecute`), 60s `TimeoutStopSec` (30s drain + headroom). `EnvironmentFile=-/etc/automaton.env` (leading `-` = optional so first-boot `systemctl start` doesn't fail).

Release via `scripts/release.sh <bump>` — **dry-run by default**: runs tests + bumps package.json + runs real `prepublishOnly` + tags git + **prints** (not executes) next-step `pnpm publish` / `docker buildx` / `git push --tags`. Pass `--apply` to mutate. Dry-run-by-default is deliberate — releases land on muscle-memory days.

## Scope

Three products supported out of the box:

- **Kronos** (always-on baseline): poll the registry, decide which jobs to execute, submit `Execute`, react to slash events.
- **Fortuna** (opt-in via `config.products.fortuna`): hold a BLS pkShare registered at Atlas, watch Fortuna's request stream, sign alpha, submit `FulfillRandomness` before the deadline. Solo-operator (t=1, n=1) is the testnet-canary path; multi-op additive `t=n` (peer share-exchange + leader-elected aggregate submit) shipped in 0.8.0 — wire shape unchanged.
- **Themis** (opt-in via `config.products.themis` + `config.themis.chambers`): for each configured chamber, observe round + bid lifecycle events; once the commit window closes, threshold-decrypt every cached bid (`D = sk · c1`), BLS-sign the reveal payload, submit `RevealRound` before `revealEta`. v1 is solo-mode + static configured chamber list; multi-op share-exchange + auto-discovery from the factory's `ChamberDeployed` events are deferred to v1.1.

Operator-adverse conditions (slashed, pruned, missed assigned slot, group-key rotation, registry/pool/fortuna/themis pause flips, code upgrades, opt-in changes, factory-driven chamber-bytecode upgrades) surface at the appropriate log level via the built-in event handlers — the operator doesn't grep tx history to find out what happened.

Verify the full surface with `pnpm run verify`.
