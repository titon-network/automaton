# Troubleshooting

If the daemon is misbehaving or a command refuses to run, search this page first. Organized by symptom.

---

## Process exit codes

| Code | Name | Cause | Fix |
|---|---|---|---|
| `0` | clean | Graceful shutdown on SIGTERM/SIGINT. | Nothing to do. |
| `1` | crash | Uncaught exception, unhandled rejection, or an explicit `throw` in the startup sequence (bad config, missing keystore, schema-version mismatch). | Check stderr / `journalctl -u automaton -n 100` for the error message + explanation. |
| `2` | bad CLI | Invalid subcommand or flag. | Check `--help`. |
| `75` | `EXIT_LOCK_HELD` (sysexits `EX_TEMPFAIL`) | Another `automaton run` is already holding the lockfile at `~/.titon/automaton/automaton.lock`. | `ps aux \| grep automaton` to see what's running. If nothing is, the lockfile is stale — `rm ~/.titon/automaton/automaton.lock`. systemd's `RestartPreventExitStatus=75` prevents a respawn loop for this case. |
| `130` | force-exit on second signal | Operator hit Ctrl-C a second time while graceful shutdown was in progress; in-flight txs are abandoned. | Intentional escape hatch. |

---

## `automaton init` errors

### `refusing to overwrite existing files: …`

`init` found `config.json` and/or `wallet.enc` in `~/.titon/automaton/` and won't clobber them.

**Fix:** back up the existing install, then either delete it or choose a new `$TITON_HOME`:

```bash
mv ~/.titon/automaton ~/.titon/automaton.$(date +%s)
# or:
TITON_HOME=~/.titon-alt automaton init
```

### `--import-mnemonic: file does not contain a valid 24-word BIP-39 mnemonic: …`

The file is missing, wrong-size, or the word list isn't BIP-39.

**Fix:** verify the file with `cat /path/to/file.txt | wc -w` (should be 24). Each word must be in the BIP-39 wordlist (english). Whitespace between words is normalised — line breaks or extra spaces are fine.

### `--import-mnemonic: file … is 5000 bytes (max 4096)`

Probably the wrong file. A 24-word mnemonic is ~200 bytes.

**Fix:** point the flag at a file containing ONLY the mnemonic.

### `--password-file: … is empty`

The password file exists but contains nothing (or only whitespace after trimming trailing line endings).

**Fix:** write the password into the file. The daemon strips trailing `\r\n` / `\n` but not leading whitespace — don't add leading spaces.

### `stdin is not a TTY — cannot prompt interactively`

You're running `init` under a non-interactive context (systemd, Docker without `-it`, piped stdin).

**Fix:** either run in a terminal, or pass `--network`, `--import-mnemonic`, `--password-file` so no prompt fires. For CI, the three flags together make `init` fully non-interactive.

---

## `automaton doctor` / `status` warnings

### `config — absent at … (run automaton init)`

No config yet. Expected on a fresh install.

**Fix:** `automaton init` (or `TITON_HOME=…` if you're looking at the wrong directory).

### `wallet balance … < … TON (minFreeBalance)`

Your wallet balance dropped below `config.minFreeBalance` (default 2 TON). Not a failure, just a warning.

**Fix (testnet):** [@testgiver_ton_bot](https://t.me/testgiver_ton_bot) will drop more TON on request. **(mainnet):** send more TON to the wallet address (surfaced by `automaton status`).

### `chain checks — skip — Kronos mainnet deployment is not yet live`

Mainnet isn't deployed yet. All chain-dependent checks (RPC, schema, consumer-admitted) skip.

**Fix:** run on testnet for now, or wait for mainnet launch.

### `contract schema mismatch — refusing to start`

The deployed registry / pool is on a different storage-schema version than the SDK you installed.

**Fix:** the error message tells you which direction — either upgrade `@titon-network/automaton` (contract is newer than you) or wait / redeploy (you're newer than the contract). See `automaton status` to see which side is ahead.

### `lockfile — STALE — pid N is no longer running`

A previous daemon crashed without releasing the lockfile.

**Fix:** confirm no daemon is running (`ps aux | grep automaton`), then `rm ~/.titon/automaton/automaton.lock`.

### `registry admitted on pool — NOT admitted`

The kronos registry was deployed but the pool owner hasn't called `SetConsumer` to admit it. Check-only — doesn't stop the daemon (first-run executions are permissionless), but slashing won't fire for missed primary windows.

**Fix:** contact the pool owner (Titon team for the default deployment) or, if you're the pool owner, run the deploy-wiring script.

---

## `automaton stake` errors

### `already registered (stake=N TON, active=true)`

`stake register` refuses when there's already an active registration.

**Fix:** use `stake increase <amount>` to add more collateral.

### `not registered — nothing to …`

Tried to `increase` / `unstake` / `cancel-unstake` / `withdraw` without being registered.

**Fix:** `stake register <amount>` first.

### `unstake is pending — cancel it first`

Tried to `increase` while an unstake is pending.

**Fix:** `automaton stake cancel-unstake` to abort the unstake, OR wait for the cooldown and `withdraw` to finish the cycle.

### `cooldown not elapsed — stake available at …`

The unstake cooldown (default 24 h on ForgeTON) hasn't elapsed.

**Fix:** wait until the printed ISO timestamp, then rerun `withdraw`. Running early doesn't cost anything — just fails.

### `wallet balance X TON is below required Y TON`

The wallet doesn't have enough for the tx's attached value + 0.1 TON buffer for wallet-tx gas.

**Fix:** fund the wallet (faucet for testnet; send TON for mainnet). The error message includes the exact shortfall.

### `the wallet tx landed but the pool rejected the internal message: …`

This is `PoolRejectedError`. The wallet's external message landed (seqno bumped) but the forwarded internal Execute/Register/etc. reverted on the pool side.

**Fix:** read the exit-code explanation printed underneath — it names the pool error (e.g. `E_AUTOMATON_NOT_ACTIVE`, `E_UNSTAKE_ALREADY_REQUESTED`). `automaton status` shows current on-chain state. Most common causes: another tx landed between our pre-state check and our submit; the pool owner paused the pool; insufficient stake.

### `seqno did not advance within 60000ms — ConfirmationTimeoutError`

Our wallet's seqno never bumped — the RPC never saw our external message get accepted.

**Fix:** most often a flaky RPC. Retry the subcommand after checking `automaton doctor`. If sustained, swap in a different toncenter endpoint.

### `seqno advanced but the wallet-initiated tx could not be located`

`TxAttributionError`. Usually a race — another unrelated incoming transfer landed and shifted the tx list. The wallet tx almost certainly landed; check the explorer for the wallet address.

**Fix:** `automaton status` shows current state. Wait a block and rerun if needed.

---

## `automaton bls *` errors

### `BLS keystore already exists at … Re-run with --force to overwrite`

Operator ran `bls keygen` twice. Second run refuses to clobber.

**Fix:** if the existing `bls.enc` is the operator's real identity, do nothing — that's the BLS secret you want. To rotate: `automaton bls deregister` first (removes the share at Atlas), then `automaton bls keygen --force`, then `automaton bls register`. Rotating without deregistering first orphans the old pkShare on-chain.

### `automaton bls register` reverts with the wallet tx landing but the pool rejecting

Wrapper error from `sendAndConfirm`'s verify callback: `atlas.getOperatorShare(me) returned no registered share after send`. The Atlas-side internal message reverted — most likely with `OperatorNotFound` / 120 ("Caller is not in the operator map (never synced from ForgeTON)"); less likely `OperatorNotForgetonActive` / 121 ("Operator is mirrored but their ForgeTON isActive flag is false").

**Most likely cause: Atlas isn't admitted as a ForgeTON consumer.** ForgeTON only fans out `AutomatonSync` to addresses in its consumer set; until Atlas is in that set, its operator map for any wallet is empty. **This is a ForgeTON-owner-driven fix — operators can't admit themselves.**

**If you're the operator (no ForgeTON owner credentials):** escalate to the protocol team / ForgeTON owner — point them at [`../../atlas/sdk/skills/atlas-deploy.md`](../../atlas/sdk/skills/atlas-deploy.md) §Step 2. There's nothing operator-side that can resolve `OperatorNotFound`; retrying `bls register` will keep reverting until the admission lands.

**If you're the protocol-team / ForgeTON owner with the workspace checked out**, confirm the diagnosis with this one-shot from inside `automaton/`:

```bash
node -e '
const { TonClient } = require("@ton/ton");
const { ATLAS_TESTNET } = require("@titon-network/atlas-sdk");
const { ForgeTON, FORGETON_TESTNET } = require("@titon-network/forgeton-sdk");
(async () => {
  const c = new TonClient({ endpoint: "https://testnet.toncenter.com/api/v2/jsonRPC" });
  const fg = c.open(ForgeTON.createFromAddress(FORGETON_TESTNET.forgeton));
  const consumer = await fg.getConsumer(ATLAS_TESTNET.atlas);
  console.log("atlas-as-forgeton-consumer:", consumer === null ? "NOT ADMITTED" : "admitted slot " + consumer.index);
})();'
```

If output is `NOT ADMITTED`, run `forgeton/scripts/admitConsumer.ts` with the Atlas address; if any operators staked at ForgeTON before the admission, also run a `ForceSync` per operator. Full flow at [`../../atlas/sdk/skills/atlas-deploy.md`](../../atlas/sdk/skills/atlas-deploy.md) §Step 2 + §Step 2.5.

**If Atlas IS admitted but `bls register` still fails** with `OperatorNotForgetonActive` (121): the wallet went inactive at ForgeTON between pre-check and submit (e.g. mid-flight slash + drop below `minStake`). Re-stake via `automaton stake increase` and retry.

### `BLS keystore decryption failed — wrong password or corrupt data`

Same shape as `WrongPasswordError` for `wallet.enc`, applied to `bls.enc`. v1 unlocks both keystores with the same password, so this firing while wallet unlock works means the file is corrupt.

**Fix:** restore from backup. If no backup exists, `bls deregister` (uses wallet password, doesn't need the BLS secret) then `bls keygen --force` then `bls register` to rotate to a fresh share.

### `fortuna: request references a stale groupEpoch — giving up`

Atlas rotated mid-flight; the request was created against the old `groupEpoch`. Normal during rotations.

**Fix:** the consumer reclaims the request for refund; nothing to do operator-side. If rotation changed group membership (e.g. an operator dropped out), the surviving operators may need to `bls deregister` + `bls register` to refresh their epoch binding — `automaton status` will show whether the share is current.

### `fortuna: request no longer live`

Either a peer operator won the race (winner-takes-all in t-of-n) OR the consumer reclaimed the request after the deadline. Informational.

**Fix:** none. If you see this for every request and never `fortuna: fulfill submitted`, the operator may not be in the active group — verify with `atlas.getOperatorShare(0, <wallet>)` returning `{ hasShare: true, isActive: true }`.

---

## `automaton run` (daemon) errors

### `automaton is already running: pid X started …`

Another daemon instance holds the lockfile.

**Fix:** if the other daemon should keep running, this one is redundant — exit. If the PID is dead, remove `~/.titon/automaton/automaton.lock`.

### `uncaughtException` / `unhandledRejection` → graceful shutdown

The daemon's own handlers catch these, log them at error level, and trigger orderly shutdown. The `finally` block still runs — lockfile is released, state flushed.

**Fix:** read the logged stack to find the bug; file an issue at [github.com/titon-network/automaton/issues](https://github.com/titon-network/automaton/issues) with the stack + your config (redact secrets, though pino already redacts the common field names).

### `all N endpoint(s) failed after M attempt(s)`

Every configured RPC endpoint is unreachable or rate-limiting. FailoverTonClient exhausted its retry budget.

**Fix:** check your internet; add more endpoints (or a paid toncenter plan) to `config.endpoints`; verify API keys if set. The daemon's backoff will keep retrying on the next tick — no manual intervention needed once the RPC is back.

### `cycle threw — continuing loop` (repeated)

A single tick failed. The daemon logs + continues — one bad cycle is expected on transient network blips.

**Fix:** nothing; the exponential backoff (`maxBackoffMs=60s`) protects against log-flooding if the error is sustained. If it's persistent, investigate the `error` field in the log lines.

### `event drain: hit maxPages=N for … — Backlog exceeded`

The daemon was offline long enough for the registry/pool to emit more events than the drain cap can process in one tick. Events older than the drained batch are orphaned (documented limitation).

**Fix:** orphaned events are mostly recoverable at the state level — the mirror refresh + chain reads don't depend on historical events. The only real loss is `AutomatonSlashed` alerts for your own wallet that fired during the downtime; `automaton status` still shows current stake, so you'll see the damage even if the webhook didn't fire.

### `PREFLIGHT FAILED — node_modules/<sdk>/dist/index.js is missing`

Test-only. The jest preflight ran but couldn't find the SDK snapshot.

**Fix:** `pnpm run sync:sdks` (from the automaton/ directory).

### `PREFLIGHT FAILED — ../<sdk>/sdk/node_modules exists`

Someone ran `pnpm install` inside a sibling SDK. That creates duplicate `@ton/core` across package boundaries and breaks `instanceof Address` checks.

**Fix:** `rm -rf ../kronos/sdk/node_modules ../forgeton/sdk/node_modules`. NEVER `pnpm install` inside those directories.

---

## Metric-driven alerts

If an alert fires, find the runbook here:

### `automaton_self_slash_total > 0` — we just got slashed

Usually means we missed a primary window (the assigned automaton didn't execute in time, the fallback window passed to us, and a different fallback-window executor won + triggered our slash). Less common: something went wrong with the Execute tx.

**Triage:**
1. Check `automaton status` for `slashCount` vs `stake`. If `slashCount` jumped but stake is intact, this was a one-off — look at `automaton_execute_failure_total` around the time of the slash to see what blocked us.
2. If slashes are repeated, the daemon is likely underperforming (slow RPC, skipped cycles). Check `automaton_cycle_duration_seconds_bucket` and `/healthz` staleness.
3. If stake drops below `pool.minStake` (default 10 TON), the automaton becomes inactive. `automaton stake increase` to top back up.

### `time() - automaton_last_cycle_completed_at_seconds > 60` — cycle stuck

The worker loop hasn't completed a cycle in over a minute. Either the daemon is hung (unlikely — `loopCycles` per-tick try/catch) or the RPC is so slow the backoff put us in a long sleep.

**Triage:**
1. `journalctl -u automaton -n 50` — look for recent `cycle threw` errors.
2. `curl http://localhost:9090/readyz` — shows which sub-check is failing.
3. Restart the daemon (`systemctl restart automaton`). Graceful shutdown drains state cleanly.

### `automaton_execute_failure_total{errorClass="pool-rejected"}` — pool is rejecting our txs

The wallet external message lands, but the internal Execute reverts. Read the `error` field in the corresponding log line for the exit code + explanation.

**Common causes:** not assigned (the decide tree placed us in `primary-self` but the pool disagrees — indicates mirror drift; restart to force-refresh); pool paused by owner; E_INSUFFICIENT_GAS (raise `cfg.minGasReserve` in the registry or reduce gas cost in jobs).

---

## Typed error reference

The daemon surfaces ~15 named error classes. If you see one in a log line and don't know where to look, find it here.

| Error class | Source | Symptom | See |
|---|---|---|---|
| `ConfigNotFoundError` | `src/config/load.ts` | `config not found at <path>` | Run `automaton init` |
| `ConfigValidationError` | `src/config/load.ts` | `config at <path> failed validation: …` | Fix the listed schema issues, or delete + re-init |
| `ConfigEnvOverlayError` | `src/config/load.ts` | `AUTOMATON_<VAR> must be …` | Fix the shell export; allow-list is `AUTOMATON_NETWORK` / `AUTOMATON_METRICS_PORT` / `AUTOMATON_LOG_LEVEL` |
| `KeystoreNotFoundError` | `src/wallet/keystore.ts` | `keystore not found at <path>` | Run `automaton init` |
| `KeystoreValidationError` | `src/wallet/keystore.ts` | `keystore at <path> failed validation: …` | The wallet file shape doesn't match `KEYSTORE_VERSION`; rebuild via init |
| `WrongPasswordError` | `src/wallet/keystore.ts` | `keystore decryption failed — wrong password or corrupt data` | Try the password again; AES-GCM auth tag can't distinguish wrong-password vs ciphertext tamper |
| `BlsKeystoreNotFoundError` | `src/bls/keystore.ts` | `bls.enc not found at <path>` | Run `automaton bls keygen` first (only required when `products.fortuna: true`) |
| `BlsKeystoreValidationError` | `src/bls/keystore.ts` | `bls.enc at <path> failed validation: …` | The file shape doesn't match `BLS_KEYSTORE_VERSION`; rebuild via `automaton bls keygen --force` |
| `BlsWrongPasswordError` | `src/bls/keystore.ts` | `BLS keystore decryption failed — wrong password or corrupt data` | v1 same-password model — if wallet unlocks but BLS doesn't, the file is corrupt; restore from backup or rotate |
| `LockHeldError` | `src/chain/lockfile.ts` | `automaton is already running: pid X` | Another daemon holds the lock (exits with code 75) |
| `LockCorruptError` | `src/chain/lockfile.ts` | `lock file at <path> is corrupt` | Hand-edit or partial write; after confirming no automaton is running, `rm` the file |
| `DeploymentNotAvailableError` | `src/chain/deployment.ts` | `Kronos mainnet deployment is not yet live` | Run on testnet; wait for mainnet deploy |
| `ProductsNotSupportedError` | `src/chain/runtime.ts` | `config.products.kronos is false …` / `config.products.fortuna is true …` | Reset `config.products` to `{ kronos: true, fortuna: false }` |
| `SchemaMismatchError` | `src/chain/schema-check.ts` | `contract schema mismatch — refusing to start` | Error message names which side is ahead; upgrade the binary or wait for deploy |
| `PoolRejectedError` | `src/chain/submit.ts` | `the wallet tx landed but the pool rejected the internal message: …` | Read the wrapped reason — stake-side means the pool reverted; daemon-side `errorClass=verify-failed` means post-state didn't advance |
| `TxAttributionError` | `src/chain/submit.ts` | `seqno advanced … but the wallet-initiated tx could not be located` | Race with an unrelated inbound tx; check the explorer, tx almost certainly landed |
| `ConfirmationTimeoutError` | `src/chain/submit.ts` | `seqno did not advance within 60000ms` | Flaky RPC; retry, check doctor |
| `AllEndpointsFailedError` | `src/chain/ton-client.ts` | `all N endpoint(s) failed after M attempt(s)` | Upstream outage or rate limit; add endpoints or wait |
| `CheckpointStateError` | `src/worker/checkpoint.ts` | `state at <path> is malformed: …` OR `stored checkpoint hash does not match tx at lt=…` | Shape corruption or cross-deployment pollution; `rm ~/.titon/automaton/state.json` and restart |
| `NotInteractiveError` | `src/cli/prompt.ts` | `stdin is not a TTY` | Pass CLI flags or set `AUTOMATON_PASSWORD`; see init docs |
| `AbortError` | `src/daemon/loop.ts` | `aborted` (internal) | Propagates SIGTERM/SIGINT cancellation; benign during shutdown |

---

## Still stuck?

- Check [CLAUDE.md](../CLAUDE.md) for the architecture + navigator tables.
- Open an issue at [github.com/titon-network/automaton/issues](https://github.com/titon-network/automaton/issues) with:
  - `automaton --version`
  - `automaton doctor` output
  - `automaton status` output (redact the wallet address if you're paranoid)
  - Relevant log lines (`journalctl -u automaton -n 200 | redact`)
- Don't paste secrets. Pino redacts `password`, `mnemonic`, `privateKey`, `seed`, `secretKey` automatically, but re-check before you paste.
