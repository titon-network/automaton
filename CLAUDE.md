# Automaton — AI Development Guide

## AI navigator — "I want to X, where do I look?"

**Doing things:**

| Task | Primary file(s) | Supporting |
|------|-----------------|------------|
| Add a new CLI subcommand | `src/cli/commands/<name>.ts` | Register via `registerXCommand(program)` in `src/cli/index.ts`; follow the stub pattern (each file is one command tree) |
| Add a new config field | `src/config/schema.ts` | If runtime-tunable, add env override in `src/config/load.ts` (`applyEnvOverlay`); default goes in `defaultConfig()`; bump `CONFIG_VERSION` if semantics change |
| Add an env var override | `src/config/load.ts` | Narrow allow-list — `applyEnvOverlay` re-uses schema validators so types stay honest |
| Change where a file lives | `src/config/paths.ts` | Every filesystem path lives here as a pure function (re-reads env per call) |
| Add a `doctor` check | `src/cli/commands/doctor.ts` | Push to the `checks` array; each entry is `{ name, run() }`; `run` may be sync or async |
| Change keystore format | `src/wallet/keystore.ts` | Bump `KEYSTORE_VERSION`; store migration path in the same file |
| Change wallet derivation | `src/wallet/wallet.ts` | V5R1 is network-aware — mainnet/testnet produce different addresses from the same mnemonic; keystore must continue to carry the network |
| Persist a new file atomically | `src/util/atomic-write.ts` | `atomicWriteFile(path, data, mode)` — used by both config and keystore; use it for any other persistent file |
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
    commands/
      doctor.ts              # environment + config + keystore checks
      init.ts                # stub until D.5
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
  util/
    atomic-write.ts          # tmp + chmod + rename (used by config + keystore)
tests/
  preflight.ts               # jest globalSetup — fails fast on missing SDK dist / stray sibling node_modules
  cli.spec.ts                # CLI smoke — help, version, doctor, stub exits
  config.spec.ts             # round-trip, env overlay, schema rejection, path resolution
  wallet.spec.ts             # mnemonic, derivation, keystore round-trip + 6 tamper vectors, prompt env fallback
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

### Doctor is install-scoped, not runtime-scoped

`automaton doctor` checks Node version, SDK resolvability, config presence/validity, keystore presence/validity. It does NOT try to reach the chain or unlock the wallet — those are runtime concerns that belong in `status` or `run`. A failing doctor means "your install is broken"; a failing status means "your install works but the state doesn't line up with the chain."

### Tests use a lowered scrypt work factor

Production uses `DEFAULT_KDF_N = 131072` (matches ethers.js v6 wallet default, ~300–500 ms per unlock). Tests pass `{ kdfN: 2048 }` via `LockOptions` to keep the suite fast (~4 s total). The crypto primitives exercised are identical — only the work factor differs — so tamper-vector tests still validate the security properties honestly.

## Current status

- **D.1 (scaffold)** — done. `11574c9`.
- **D.2 (config + paths)** — done. `bdde95f`. 30 tests.
- **D.3 (wallet keystore)** — done. `8989253`. 23 tests, 6 tamper vectors.
- **Up next (D.4)** — TON client layer: `FailoverTonClient` (endpoint rotation + jittered backoff), `lockfile.ts` (PID-based single-instance), `schema-check.ts` (on-chain `storageVersion` vs SDK constants).
- **D.5–D.15** — see `../kronos/progress.md`.

Total: **57 tests** across 3 suites. Full build + test runs in ~5 s.

## Security hardening — summary

- scrypt N=131072 (matches ethers.js v6); maxmem=256 MB so the parameters actually run.
- AES-256-GCM with a random 96-bit nonce per lock + 128-bit auth tag. Re-locks produce fresh salt + nonce.
- Atomic writes + 0600 perms on all operator-owned files.
- `AUTOMATON_PASSWORD` env path validates min length on entry; CLI flag is unsupported.
- Keystore plaintext metadata (network, address, publicKey) cross-checked via re-derivation on every unlock.
- Preflight gate catches the `file:` dep snapshot traps that cost hours to diagnose as runtime errors.
