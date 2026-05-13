# Quickstart — first reward on testnet

Goal: from "nothing installed" to "daemon executing due jobs and earning testnet TON." Target time: 5 minutes of work + ~10 minutes of waiting for faucet + registration to confirm on-chain.

You'll need:
- Node.js ≥ 22 (the npm install path), **or** Docker
- A Telegram account (to claim testnet TON from the faucet bot)
- ~15 minutes of attention

---

## 1. Install

Via npm (recommended):

```bash
npm install -g @titon-network/automaton
automaton --version
```

Or Docker:

```bash
docker pull titon/automaton:latest
alias automaton='docker run --rm -it -v ~/.titon:/home/nonroot/.titon:rw titon/automaton:latest'
automaton --version
```

---

## 2. `automaton init` — scaffold the wallet + config

```bash
automaton init --network testnet
```

You'll be asked:

1. **Wallet choice: `new` or `import`.** Pick `new` unless you've minted a mnemonic elsewhere.
2. **On-screen 24-word mnemonic.** WRITE IT DOWN. On paper. This is your only recovery key — if the machine dies or `wallet.enc` is corrupted and you haven't backed up this mnemonic, the stake is gone.
3. **"Have you written the mnemonic down?"** — confirm before continuing.
4. **Encryption password (min 8 chars).** Used to encrypt `wallet.enc` at rest. Not recoverable; pick something strong and remember it.
5. Confirmation of the password.

On success you'll see:

```
  Wallet address (testnet, non-bounceable): 0QB... ...
  Keystore:                                 /home/you/.titon/automaton/wallet.enc
  Config:                                   /home/you/.titon/automaton/config.json

  Next steps:
    automaton doctor                 # verify install
    # Fund the wallet address above with at least 11 TON …
```

Copy the wallet address — you'll paste it into the faucet in step 4.

---

## 3. `automaton doctor` — verify the install

```bash
automaton doctor
```

You should see 9+ checks all `ok`:

```
  ok    node >= 22 — node 22.22.2
  ok    @titon-network/forgeton-sdk resolves — N exports
  ok    @titon-network/kronos-sdk resolves — N exports
  ok    package version readable
  ok    config — /home/you/.titon/automaton/config.json — network=testnet, endpoints=1
  ok    keystore — /home/you/.titon/automaton/wallet.enc — network=testnet, address=0QB...
  ok    config / keystore network agree — testnet
  warn  wallet balance >= minFreeBalance — 0 TON < 2 TON (minFreeBalance) — fund via https://t.me/testgiver_ton_bot
  ok    on-chain schema versions match — registry=v1, pool=v1
  ok    registry admitted on pool — consumer slot=0
  ok    lockfile — absent (daemon not running)
```

The `warn` on wallet balance is expected — the wallet is empty until step 4.

---

## 4. Fund the wallet

Open [@testgiver_ton_bot](https://t.me/testgiver_ton_bot) on Telegram. Send it the wallet address from step 2. The bot drops 2 TON per request; request it enough times to get **≥ 11 TON** (10 stake + 1 gas reserve).

Verify the balance landed:

```bash
automaton status
# Wallet
#     network:               testnet
#     address:               0QB...
#     balance:               12.0 TON
# Automaton
#     status:                not registered — run `automaton stake register`
```

---

## 5. `automaton stake register` — register on-chain

```bash
automaton stake register 10
# Keystore password: ******
#   Submitting register (value=10.07 TON)...
#   Verified (seqno 0 → 1, pool state updated).
#   Tx:   ab3c4e...
#   View: https://testnet.tonviewer.com/transaction/ab3c4e...
```

The register message attaches `10 stake + 0.05 gas + 1 × 0.02 fan-out = 10.07 TON`. The wallet balance drops from ~12 to ~1.9 TON (stake locked in the pool, remainder stays in the wallet for future tx gas).

If anything goes wrong, see [docs/troubleshooting.md](troubleshooting.md). The most common failure is "insufficient wallet balance" — faucet another round and retry.

---

## 6. `automaton run` — start the daemon

```bash
automaton run
```

The daemon prints JSON lines to stdout — one per significant event. You'll see:

```
{"ts":"2026-04-17T14:01:00.123Z","level":"info","msg":"acquired lockfile", …}
{"ts":"2026-04-17T14:01:00.456Z","level":"info","msg":"wallet unlocked"}
{"ts":"2026-04-17T14:01:01.789Z","level":"info","msg":"on-chain schema versions match SDK constants"}
{"ts":"2026-04-17T14:01:02.012Z","level":"info","msg":"daemon starting main loop","pollIntervalMs":10000}
```

Leave it running. Within a few poll cycles (~10 s each), you'll start seeing:

```
{"ts":"…","level":"info","msg":"job=1 execute success","reason":"primary-self"}
```

`reason: primary-self` means the rotation assigned this job to your automaton and you won the primary window. `fallback` means someone else was assigned, missed their window, and you claimed the reward + triggered their slash. Either way, the reward lands in your wallet balance over time.

---

## 7. Verify rewards landing

In another terminal:

```bash
automaton status
# Wallet
#     balance:               2.13 TON      ← earning!
# Automaton
#     status:                active
#     stake:                 10.0 TON
#     slashCount:            0
```

Or point a Prometheus scraper at `http://localhost:9090/metrics`:

```bash
curl -s http://localhost:9090/metrics | grep -E "execute_success|wallet_balance"
```

```
automaton_execute_success_total{reason="primary-self"} 3
automaton_execute_success_total{reason="fallback"} 1
automaton_wallet_balance_ton 2.1300000
```

That's it. Ship `Ctrl-C` to shut down gracefully (drains in-flight txs, flushes event checkpoint, releases lockfile).

---

## 8. Optional — enable Fortuna VRF on the same wallet

Same daemon, same stake, second product. The operator earns Fortuna VRF fulfillment rewards alongside Kronos automation. Order matters: `bls register` requires `products.fortuna: true` in the config (it reads the BLS keystore + Atlas address from there), so the config flip happens before the on-chain registration.

```bash
# Stop the daemon first (so the BLS register tx doesn't race with a live tick,
# and the next start picks up the new config + bls.enc cleanly).
# systemd:    sudo systemctl stop automaton
# Docker:     docker stop automaton
# Foreground: Ctrl-C the running `automaton run`

# 1. Generate the BLS keystore (uses the wallet password by default — v1 same-
#    password model). Stores ~/.titon/automaton/bls.enc + a plaintext pkShare.
automaton bls keygen

# 2. Flip products.fortuna: true in config.json:
automaton config edit
#   change "products": { "kronos": true, "fortuna": false }
#   to     "products": { "kronos": true, "fortuna": true }

# 3. Register the BLS share at Atlas (CLI command — daemon stays stopped):
automaton bls register
# → "Verified (seqno N → N+1). Tx: …"

# 4. Start the daemon. FortunaWorker boots with the share already in Atlas's
#    map; on the next event drain the daemon picks up Fortuna requests.
automaton run    # or `sudo systemctl start automaton` / `docker start automaton`
```

If step 3 reverts with `OperatorNotFound (120)`, Atlas hasn't been admitted as a ForgeTON consumer yet — see [`docs/deploy.md` §Enabling Fortuna VRF](deploy.md#enabling-fortuna-vrf) for the prerequisite. That's a one-time **ForgeTON-owner-driven** step (operators can't admit themselves); on the testnet canary today it's already done, so a fresh operator following this quickstart should land cleanly.

Verify Fortuna is live:

```bash
automaton status --format json | jq .fortuna
# → non-null when Atlas + Fortuna are wired and the operator is in the active group
```

In the daemon log you'll start seeing `fortuna: operator mirror updated for self isActive=true` (Atlas mirrored you in) and, when a request lands, `fortuna: fulfill submitted ...`.

**Back up `bls.enc`** alongside `wallet.enc`. The BLS secret is the operator's identity in the threshold-signing group; losing it requires `bls deregister` + `bls keygen` + `bls register` to rotate.

---

## 9. Optional — enable Themis (sealed-bid threshold-decryption)

Same daemon, same stake, same `bls.enc`, third product. Themis lets consumer protocols accept ciphertext bids during a commit window, then operators threshold-decrypt + reveal them in a batch — unlocks MEV-resistant DEX swaps, sealed-bid auctions, confidential governance. The operator earns `revealerReward` per chamber per round.

**Prerequisite chain:** the same `bls.enc` you generated for Fortuna IS the Themis signing key (Atlas group secret signs both `FulfillRandomness` and `RevealRound`). The Themis factory itself must be admitted as a ForgeTON consumer + Atlas verifier — that's a one-time owner-driven step, not operator-side.

```bash
# Stop the daemon (same reason as the Fortuna flip — clean restart).

# 1. List the chambers you want to serve. The Themis factory deploys
#    chambers per consumer protocol (sealed AMM, auction house, etc.) —
#    each has its own address. v1 requires explicit opt-in per chamber;
#    auto-discovery from the factory's ChamberDeployed events lands in v1.1.
#    Get the chamber list from the factory's `EvtChamberDeployed` events
#    OR from the consumer protocol's docs.

# 2. Edit config.json — flip products.themis: true and add the chambers list:
automaton config edit
#   change "products": { "kronos": true, "fortuna": true, "themis": false }
#   to     "products": { "kronos": true, "fortuna": true, "themis": true }
#   and add:
#     "themis": {
#         "chambers": [
#             "EQ…<chamber-1-addr>",
#             "EQ…<chamber-2-addr>"
#         ]
#     }
#   Pre-launch / sovereign deployments may also need:
#     "themis": { "factoryAddress": "EQ…", "atlasAddress": "EQ…", "chambers": [...] }

# 3. Start the daemon. ThemisWorker initialises one in-memory state per chamber
#    and seeds via getOperator + getCurrentRound + getGroupKey on the first tick.
automaton run    # or `sudo systemctl start automaton` / `docker start automaton`
```

Verify Themis is live:

```bash
automaton status --format json | jq '.products.themis'
# → object with atlas / factory / chamber:* keys when wired
curl -s http://127.0.0.1:9090/metrics | grep themis_
# → automaton_themis_chambers + automaton_themis_pending_reveals gauges
```

In the daemon log you'll see `themis worker initialised chamberCount=N`, `themis: operator-mirror updated for self at chamber EQ…` (after factory fan-out), and once a round closes: `themis: submitting RevealRound roundId=N bidCount=M groupEpoch=N`.

If `automaton_themis_chambers > 0` but `themis: skip reveal { reason: 'not-mirrored' }` keeps logging, the factory's `AutomatonSync` fan-out hasn't reached your operator's chamber yet — bounded by `cfg.maxFanoutPerSync`, may take a few cycles. See [`docs/troubleshooting.md`](troubleshooting.md#themis-skip-reveal--reason-not-mirrored-) for the full per-skip-reason reference.

---

## What next

- [docs/ops.md](ops.md) — systemd + Docker deployment, key rotation, upgrades, backup.
- [docs/troubleshooting.md](troubleshooting.md) — every exit code, every preflight failure, every common mistake.
- [README.md](../README.md) — config reference.

**Mainnet is live** — all four protocols TSA-audited zero-findings, deployed + wired since 2026-05-08. For mainnet, follow [`docs/deploy.md` §3 AWS EC2](deploy.md#3-aws-ec2--mainnet-production-path) instead of this local-quickstart. That path keeps secrets in SSM (not TF state), supports multi-op Fortuna, and uses the team-published image at `public.ecr.aws/b0k9s4w3/automaton:0.8.0`. Full module reference at [`contrib/aws/ec2/README.md`](../contrib/aws/ec2/README.md); multi-op operator setup at [`docs/multi-op-fortuna.md`](multi-op-fortuna.md) §Operator setup.
