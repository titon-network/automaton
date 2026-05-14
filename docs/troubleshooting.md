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

**If you're the operator (no ForgeTON owner credentials):** escalate to the protocol team / ForgeTON owner — point them at [`../../atlas/sdks/typescript/skills/atlas-deploy.md`](../../atlas/sdks/typescript/skills/atlas-deploy.md) §Step 2. There's nothing operator-side that can resolve `OperatorNotFound`; retrying `bls register` will keep reverting until the admission lands.

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

If output is `NOT ADMITTED`, run `forgeton/scripts/admitConsumer.ts` with the Atlas address; if any operators staked at ForgeTON before the admission, also run a `ForceSync` per operator. Full flow at [`../../atlas/sdks/typescript/skills/atlas-deploy.md`](../../atlas/sdks/typescript/skills/atlas-deploy.md) §Step 2 + §Step 2.5.

**If Atlas IS admitted but `bls register` still fails** with `OperatorNotForgetonActive` (121): the wallet went inactive at ForgeTON between pre-check and submit (e.g. mid-flight slash + drop below `minStake`). Re-stake via `automaton stake increase` and retry.

### `BLS keystore decryption failed — wrong password or corrupt data`

Same shape as `WrongPasswordError` for `wallet.enc`, applied to `bls.enc`. v1 unlocks both keystores with the same password, so this firing while wallet unlock works means the file is corrupt.

**Fix:** restore from backup. If no backup exists, `bls deregister` (uses wallet password, doesn't need the BLS secret) then `bls keygen --force` then `bls register` to rotate to a fresh share.

### `automaton bls register` reverts with `E_SOLO_PK_SHARE_MISMATCH (161)`

Atlas's solo-mode invariant: when `memberCount == 1, threshold == 1` (testnet / dev default), the operator's `pkShare` must byte-equal Atlas's published `groupPk`. The CLI pre-flights this off-chain too — same error code in either origin.

**Most common cause:** the Atlas owner published `groupPk` against a *different* operator's pkShare, or against an old key from a wiped keystore.

**Fix:** the operator's local pkShare is authoritative for solo-mode. Either re-publish `groupPk` to match (Atlas owner's call), or rotate the Atlas group via the 3-step timelock (Pause → Propose → 24h → Execute) to adopt the current pkShare. Full operator-first flow with copy-paste commands: [`docs/fortuna-solo-mode.md`](fortuna-solo-mode.md). Atlas-side narrative: [`../../atlas/sdks/typescript/skills/atlas-operator-register-share.md`](../../atlas/sdks/typescript/skills/atlas-operator-register-share.md) §"Solo-mode flow".

### `config.products.fortuna is false. Enable it in config.json…`

CLI guard: `automaton bls register` checks the local config to know which Atlas address to talk to and whether to spin up the Fortuna runtime. If `products.fortuna` isn't true, the command refuses up front.

**Fix:** flip the flag in `~/.titon/automaton/config.json`:

```bash
jq '.products.fortuna = true' ~/.titon/automaton/config.json | sponge ~/.titon/automaton/config.json
# or interactively:
automaton config edit
```

Then re-run `automaton bls register`. (Order matters: the config flip happens before `bls register`, not after — there's no auto-flip.)

### Atlas owner's `publishGroupKey` "lands" but never reaches Atlas

This is an Atlas-owner-side gotcha, not an operator-side error — but operators waiting on the publish hit it as `groupPk` staying null indefinitely. Diagnostic from the Atlas owner's side: `pnpm run publish:groupkey:testnet` prints "publish did not land within 60s — check tonscan + retry", and tonscan shows the wallet's most-recent tx with `out_msgs: []`.

**Cause:** V5R1 wallets accept the signed external (advance seqno + eat ~0.0005 TON in fees) but the **action phase** drops the outbound when the wallet's balance can't cover the message value (0.15 TON for `PublishGroupKey`) plus storage reserves. **No bounce, no error log.**

**Fix:** check the Atlas owner wallet balance:

```bash
curl -s "https://testnet.toncenter.com/api/v2/getAddressInformation?address=<atlas-owner-0Q...>" \
  | jq '.result.balance | tonumber / 1e9'
```

If < 0.5 TON, faucet via [@testgiver_ton_bot](https://t.me/testgiver_ton_bot) and re-run the publish. The same failure shape applies to any wallet-app-free script in the workspace that sends a non-trivial value with a low-balance signer — keep deploy/publish wallets funded to ≥ 1 TON.

### `fortuna: request references a stale groupEpoch — giving up`

Atlas rotated mid-flight; the request was created against the old `groupEpoch`. Normal during rotations.

**Fix:** the consumer reclaims the request for refund; nothing to do operator-side. If rotation changed group membership (e.g. an operator dropped out), the surviving operators may need to `bls deregister` + `bls register` to refresh their epoch binding — `automaton status` will show whether the share is current.

### `fortuna: request no longer live`

Either a peer operator won the race (winner-takes-all in t-of-n) OR the consumer reclaimed the request after the deadline. Informational.

**Fix:** none. If you see this for every request and never `fortuna: fulfill submitted`, the operator may not be in the active group — verify with `atlas.getOperatorShare(0, <wallet>)` returning `{ hasShare: true, isActive: true }`.

### `themis: skip reveal { reason: 'not-mirrored' }`

The configured chamber's `getOperator(self)` returned null — the factory hasn't fanned `AutomatonSync` out to the chamber for this operator yet.

**Cause:** ForgeTON's `AutomatonSync` was published, the factory cached it, but factory→chamber fan-out is bounded by `cfg.maxFanoutPerSync` per inbound. With many chambers, each operator change ripples through over multiple cycles.

**Fix:** wait for the next factory cycle (chamber count / fanoutCap ticks), OR verify the factory itself is healthy — it should be admitted as a ForgeTON consumer. If `pool.getConsumer(<factory-addr>) === null`, the factory itself isn't admitted; fix that first.

### `themis: skip reveal { reason: 'no-group-key' }`

The chamber hasn't received `GroupKeySync` from the factory yet — its cached `GroupKeyEntry` has `entryVersion=0`.

**Fix:** anyone can call the factory's permissionless `RebroadcastGroupKey` (audit fix INT-1) to force fan-out of the cached `groupPk` to the next batch of chambers. Otherwise wait for the natural rotation cadence.

### `themis: skip reveal { reason: 'commit-still-open' }`

Operator-side timing — `now < commitEta`. Bidders are still allowed to submit ciphertexts.

**Fix:** wait. The worker re-evaluates every poll cycle.

### `themis: skip reveal { reason: 'reveal-deadline-passed' }`

Operator missed the reveal window (`now >= revealEta`). Anyone can now call `AdvanceRound` to refund bidders.

**Fix:** investigate why the daemon was off through `commitEta..revealEta`. Common causes: lockfile contention, schema-mismatch refusing to start, RPC outage exceeding the drain window. The next round opens automatically when `AdvanceRound` lands.

### `themis: round no longer current (settled by someone else)`

The pre-submit live freshness check (`getCurrentRound`) reports a different `roundId` than the cached one — a peer operator (in v1.1+ multi-op) submitted the reveal first OR `AdvanceRound` rolled the round over after a missed deadline.

**Fix:** informational. In solo-mode v1 you're the only operator — this only fires after a missed reveal that triggered `AdvanceRound`.

### `themis: RevealRound threw — RevealRound did not advance roundId (still N)` (FIXED in 0.9.1)

False-negative phantom failure on **every successful reveal** in 0.9.0. The verify callback expected `getCurrentRound().roundId` to advance after `RevealRound`, but `RevealRound` settles the round IN PLACE (`phase = REVEALED`); only `AdvanceRound` advances `roundId`. The reveal had actually landed cleanly — chamber emitted `EvtRoundRevealed` + dispatched `RevealCallback` to the consumer — but the worker would log this error AND retry on the next tick, where the second `RevealRound` would revert with `E_ROUND_ALREADY_REVEALED (156)` (wasted gas + alarming logs).

**Fix:** upgrade to **automaton@0.9.1** or later — `submitOne`'s verify is now `assertChamberAccepted`, which polls the chamber's recent inbound txs for the matching `RevealRound` and reads its `computePhase.exitCode` directly.

### `themis: RevealRound threw — seqno advanced for ... but the wallet-initiated tx could not be located in the last N transactions` (FIXED in 0.9.2)

`TxAttributionError` from `sendAndConfirm`. The wallet's seqno bumped (so the external message was accepted by the chain) but `getTransactions(limit=4)` couldn't find a matching external-in tx in the last 4. Surfaces on operators co-running multiple products (Fortuna fulfillment + Themis reveal + Kronos execute can land within the same tick); intervening txs push the just-sent one past the lookback window.

**Fix:** upgrade to **automaton@0.9.2** or later — `TX_LOOKBACK` widened from 4 → 32 (one toncenter HTTP round-trip; absorbs ~8s of bursty tx production). Affected all workers, not just Themis.

### Multi-op: `fortuna: signed + broadcast our partial peers=N ok=0`

Daemon signed locally + tried to POST partials to all peers; **zero** peers received it. Requests will time out and consumers will reclaim.

**Cause:** peer reachability — typically one of:
- **Security group** — the EC2 module's `peer_ips` variable wasn't set OR doesn't include the OTHER operator's EIP. Check `aws_vpc_security_group_ingress_rule.fortuna_share` exists for each peer.
- **Docker port not published** — the systemd unit must `docker run -p 0.0.0.0:9091:9091`. Verify with `sudo ss -ltnp | grep 9091` on the host (should show docker-proxy listening on `*:9091`).
- **Peer URL wrong** — `config.fortuna.peers[].endpoint` should be `http://<peer-EIP>:9091` (no path, no trailing slash, no HTTPS — peer-share-exchange is plain HTTP, BLS-signature-self-authenticating).
- **`shareExchangeHost` defaulted** — the daemon binds `127.0.0.1:9091` by default. For peer-reachable, set `config.fortuna.shareExchangeHost: "0.0.0.0"` (the SG provides the security boundary).

**Diagnose:** from the daemon's host, `curl -m 5 -X POST http://<peer-EIP>:9091/fortuna/v1/share -d '{}'`. Expect HTTP 400 (server is reachable + rejects empty body). `Connection refused` = listener / port-publish issue. Timeout = SG / route issue.

### Multi-op: `share-exchange: rejected partial — unknown sender: <addr>`

A peer POSTed a partial whose `fromAddress` isn't in our `config.fortuna.peers[].address` set.

**Causes:**
- Peer's address typo'd in `config.fortuna.peers` (UQ-form is base64url, **case-sensitive** — copy verbatim from the peer's `automaton status`).
- Stale partial from a previously-replaced peer instance (benign; happens transiently during rolling restarts).
- Real intrusion attempt (very rare; the inbound listener is firewalled to peer EIPs by the SG).

**Fix:** confirm the rejected `fromAddress` matches the peer's published wallet. If yes, fix the typo in `config.fortuna.peers`, push to SSM, restart daemon.

### Multi-op: `share-exchange: rejected partial — sender not registered for groupEpoch=N`

Peer claims a `groupEpoch` that doesn't match what Atlas has for that operator. Either the peer didn't run `automaton bls register` against the current epoch, or there's been a mid-flight rotation.

**Fix:** the peer needs to run `automaton bls register` (or `bls deregister` + `bls register` after a rotation). Verify with `atlas.getOperatorShare(0, <peer-addr>)` showing `shareEpoch == <current groupEpoch>`.

### Multi-op: `share-exchange: rejected partial — claimed pkShare does not match Atlas's record`

Peer's local `pkShare` (from their `bls.enc`) differs from what Atlas has registered for them. Most likely cause: the peer regenerated their BLS keystore (`automaton bls keygen --force`) without re-running `automaton bls register`, OR a group rotation changed the registered shares.

**Fix:** peer runs `automaton bls register` to re-publish their current `pkShare`. If solo-mode (`memberCount=1`), the on-chain invariant `pkShare == groupPk` requires a group-key rotation to adopt the new pkShare instead.

### Multi-op: `share-exchange: rejected partial — partial signature failed BLS verify`

Sender's pkShare matches Atlas's record AND the partial is the right shape, but it doesn't BLS-verify against the alpha. Should be impossible from a healthy peer (the peer signed the alpha they themselves derived).

**Cause (rare):** the peer is running an older daemon version with a different `computeAlpha` byte order, OR their BLS DST drifted from `BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_`.

**Fix:** ensure all operators run the same `automaton` major + minor version. The DST is constant across the codebase — drift would be a code-level bug, not a config issue.

### Multi-op: `multi-op cache lost partials between gate and submit`

Internal race: the tick's gate-check saw enough partials in the cache, but by the time `submitOne` ran, the cache had been cleared (concurrent fulfillment, daemon restart between gate and submit, prune cycle). Self-healing — next tick re-signs + rebroadcasts.

**Fix:** none if it's transient. If it repeats every tick, the share-exchange server might be receiving partials but failing to write to the worker's cache (a wiring bug). Check that the orchestrator instantiated ONE `ShareCache` shared between the server and the worker — `src/products/fortuna.ts:bootstrapWorker` does this; if you're using a custom integration, verify both sides see the same cache instance.

### Multi-op: requests time out + reclaim, no fulfillments at all

End-to-end blocker. Walk the chain:

1. **Atlas group state** — `atlas.getGroupKey(0)` returns non-null with `memberCount=N`, `threshold=N`, `groupPk` matching the published aggregate? If null → owner hasn't run `publishMultiOpGroupKey:mainnet` yet.
2. **Operator registration** — `atlas.getOperatorShare(0, <each-operator-wallet>)` returns `{ hasShare: true, shareEpoch: <current>, isActive: true }` for ALL operators? If any is missing → that operator runs `automaton bls register`.
3. **Daemon mode** — `automaton status` on each region shows `mode: multi-op (n=N)` in `fortuna worker initialised` log? If it shows `solo` → `config.fortuna.peers` is empty or didn't reach the daemon (re-upload SSM config + restart).
4. **Peer reachability** — `curl http://<peer>:9091/fortuna/v1/share` from each region → expect HTTP 400. If `Connection refused` / timeout → SG / port-publish issue (see above).
5. **Share exchange flowing** — daemon log shows `fortuna: signed + broadcast our partial peers=N ok=N` (matching `peers == ok`)? If `ok < peers` → peer connectivity gap.
6. **Aggregate landing** — leader's daemon log shows `fortuna: submitting FulfillRandomness` followed by `fortuna: fulfillment verified`? If submit happens but verify fails with `E_INVALID_BLS_SIGNATURE (161)` → aggregate doesn't pair with the published `groupPk`. Most likely cause: not all operators registered against the current epoch, OR Atlas's published `groupPk` ≠ sum of registered pkShares (publish ceremony bug — the publish script's input must include EVERY operator's pkShare in the same order they're registered).

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

**Fix:** `rm -rf ../kronos/sdks/typescript/node_modules ../forgeton/sdks/typescript/node_modules`. NEVER `pnpm install` inside those directories.

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
