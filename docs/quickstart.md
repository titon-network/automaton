# Quickstart — first reward on testnet

Goal: from "nothing installed" to "daemon executing due jobs and earning testnet TON." Target time: 5 minutes of work + ~10 minutes of waiting for faucet + registration to confirm on-chain.

You'll need:
- Node.js ≥ 22 on your machine (for the from-source path), **or** Docker
- A Telegram account (to claim testnet TON from the faucet bot)
- ~15 minutes of attention

---

## 1. Install

From source (matches what's in `README.md`):

```bash
git clone https://github.com/titon/titon.git
cd titon/automaton
pnpm install
pnpm run build
sudo ln -s "$(pwd)/dist/cli/index.js" /usr/local/bin/automaton
automaton --version
# → 0.1.0
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
  ok    forgeton-sdk resolves — 18 exports
  ok    kronos-sdk resolves — 34 exports
  ok    package version readable — 0.1.0
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

## What next

- [docs/ops.md](ops.md) — systemd + Docker deployment, key rotation, upgrades, backup.
- [docs/troubleshooting.md](troubleshooting.md) — every exit code, every preflight failure, every common mistake.
- [README.md](../README.md) — config reference.

Mainnet deploy isn't live yet. When it lands, replay this entire quickstart with `--network mainnet` and a real-TON-funded wallet. Minimum stake + gas math stays the same; endpoint ring should include your own paid toncenter plan (not the public 1 req/s tier).
