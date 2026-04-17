# Operations guide

Day-2 operators' reference. If you've completed [quickstart.md](quickstart.md) and want to run `automaton` in production, start here.

Contents:
1. [systemd](#systemd-deployment)
2. [Docker](#docker-deployment)
3. [Metrics + Grafana](#metrics)
4. [Key rotation](#key-rotation)
5. [Version upgrades](#version-upgrades)
6. [Backup and restore](#backup-and-restore)
7. [Multi-region / failover](#multi-region)

---

## systemd deployment

The repo ships `contrib/automaton.service` — an opinionated unit with a full Linux sandbox (`ProtectSystem=strict`, `NoNewPrivileges`, `RestrictNamespaces`, `PrivateTmp`, `SystemCallArchitectures=native`). Install:

```bash
# 1. Install the binary. If you installed via npm, this is already done.
#    From source:
sudo cp dist/cli/index.js /usr/local/bin/automaton
sudo chmod +x /usr/local/bin/automaton

# 2. Create the service account.
sudo useradd --system --home /var/lib/automaton --shell /usr/sbin/nologin automaton

# 3. Bootstrap the config + keystore AS that user.
#    (init is interactive — drop into a shell first.)
sudo -u automaton -H automaton init --network testnet
#    Or non-interactive: pass --import-mnemonic / --password-file.

# 4. Fund the wallet (faucet for testnet; send TON for mainnet) AND
#    register (`automaton stake register …`) BEFORE starting the daemon.
#    The daemon will run even unstaked (permissionless first-run), but
#    /readyz stays FAIL until stake is active.

# 5. Install the unit + env file.
sudo install -m 0644 contrib/automaton.service /etc/systemd/system/automaton.service
sudo install -m 0600 -o root -g root contrib/automaton.env.example /etc/automaton.env
sudo $EDITOR /etc/automaton.env          # set AUTOMATON_PASSWORD

# 6. Enable + start.
sudo systemctl daemon-reload
sudo systemctl enable --now automaton
sudo systemctl status automaton
sudo journalctl -u automaton -f          # tail the JSON log
```

**Tuning:**
- The unit's `MemoryDenyWriteExecute` is commented out by default (can break Node's V8 JIT on kernels without W^X-compatible wxallocations). Uncomment only after a load test on your exact kernel + libc.
- `TimeoutStopSec=60s` accommodates the daemon's 30 s graceful drain + ~30 s safety margin. Don't lower it unless you've shortened `shutdownTimeoutMs` programmatically.
- `RestartPreventExitStatus=75` stops systemd from respawn-looping on `EXIT_LOCK_HELD`. If you `systemctl start` twice, the second start fails cleanly.

---

## Docker deployment

The shipped `Dockerfile` produces a multi-arch, distroless, non-root image (~90 MB). Build context is the **parent directory** so sibling SDKs are visible:

```bash
cd titon/                                # parent of automaton/
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag titon/automaton:0.1.0 \
  --tag titon/automaton:latest \
  -f automaton/Dockerfile \
  --push .
```

**Deploy:**

```bash
# Bootstrap on the host (interactive).
docker run --rm -it \
  -v $HOME/.titon:/home/nonroot/.titon:rw \
  titon/automaton:latest init --network testnet

# Fund + register on-chain as above, then run detached.
docker run -d \
  --name automaton \
  --restart unless-stopped \
  -v $HOME/.titon:/home/nonroot/.titon:rw \
  --env AUTOMATON_PASSWORD=<your-password> \
  --env-file /etc/automaton.env \
  -p 127.0.0.1:9090:9090 \
  titon/automaton:latest run
```

To publish `/metrics` for external Prometheus, flip `metricsHost` in `config.json` from `"127.0.0.1"` to `"0.0.0.0"` and expose the port normally (`-p 9090:9090`).

**Docker Compose** (abbreviated):

```yaml
services:
  automaton:
    image: titon/automaton:0.1.0
    restart: unless-stopped
    volumes: ["automaton-home:/home/nonroot/.titon"]
    environment:
      AUTOMATON_PASSWORD: ${AUTOMATON_PASSWORD}
    ports: ["127.0.0.1:9090:9090"]
    command: ["run"]
    healthcheck:
      test: ["CMD", "/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:9090/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
volumes:
  automaton-home:
```

---

## Metrics

The daemon exposes Prometheus metrics at `http://<metricsHost>:<metricsPort>/metrics`. All names are prefixed `automaton_`; each has a `help` string. Key series:

| Metric | Type | What it tells you |
|---|---|---|
| `automaton_execute_attempts_total{reason}` | counter | Every Execute tx we fired, labelled by the decide-tree reason. |
| `automaton_execute_success_total{reason}` | counter | Executions that verified on-chain. |
| `automaton_execute_failure_total{reason, errorClass}` | counter | Failed Executes, bounded error classes (`rpc-timeout`, `pool-rejected`, `tx-attribution`, `confirmation-timeout`, `verify-failed`, `other`). |
| `automaton_skip_total{reason}` | counter | Jobs skipped with no submission. |
| `automaton_in_flight_collision_total` | counter | Cycles where a jobId was still mid-submit from a prior tick. |
| `automaton_wallet_balance_ton` | gauge | Live wallet balance (updated every `gaugeSnapshotEveryNTicks`). |
| `automaton_stake_ton` · `automaton_active` · `automaton_slash_count` | gauge | Pool-side automaton state. |
| `automaton_pool_active_count` | gauge | Total active automatons — affects rotation. |
| `automaton_registry_syncs_received` · `_slashes_requested` | gauge | Drift counters. Compare against pool-side totals to catch lost messages. |
| `automaton_cycle_duration_seconds` | histogram | End-to-end tick duration. |
| `automaton_last_cycle_completed_at_seconds` | gauge | Unix time of the last successful cycle. Drives `/healthz`. |
| `automaton_self_slash_total` | counter | How many times this wallet was slashed. Alerting gold. |
| `automaton_events_dispatched_total{source, kind}` | counter | Event pump throughput. |
| `automaton_drain_capped_total{source}` | counter | Fired when the event drain hits `maxPages` — backlog exceeded the ceiling. |

**Alerting suggestions** (wire into your Alertmanager):
- `rate(automaton_execute_failure_total[5m]) > 0` — one bad cycle is fine; sustained failures aren't.
- `increase(automaton_self_slash_total[1h]) > 0` — page immediately.
- `automaton_wallet_balance_ton < 1` — refill before gas runs out.
- `time() - automaton_last_cycle_completed_at_seconds > 60` — cycle stuck; page.
- `up{job="automaton"} == 0` — scrape failure.

A starter Grafana dashboard is planned for a future release; for now these metric names are stable and hand-building a board is straightforward.

---

## Key rotation

The wallet mnemonic is the root of trust. Rotate when:
- The encryption password may have been compromised (re-encrypts only, same keys).
- The mnemonic backup may have been exposed (full rotation — new keys, new address).

**Re-encrypt only** (change password, same keys):

```bash
# Unlock with the old password (status reads plaintext fields, so this
# is just a sanity check), then:
automaton init --network testnet --import-mnemonic /path/to/backup --password-file /path/to/new-pw
# — refuses because ~/.titon/automaton/ exists. Move aside first:
mv ~/.titon/automaton ~/.titon/automaton.old
automaton init --network testnet --import-mnemonic ~/.titon/automaton.old/mnemonic.backup --password-file /path/to/new-pw
# Verify: automaton status shows the same address.
rm -rf ~/.titon/automaton.old
```

**Full rotation** (new mnemonic → new address):

```bash
# 1. Stop the daemon: systemctl stop automaton (or docker stop).
# 2. Unstake from the pool (burns 24 h cooldown + a gas top-up):
automaton stake request-unstake
# …wait 24 h (ForgeTON cooldown)…
automaton stake withdraw
# 3. Transfer the now-liquid stake to a holding wallet (any TON wallet works).
# 4. Wipe + reinstall:
rm ~/.titon/automaton/{wallet.enc,config.json,state.json}
automaton init --network testnet          # NEW mnemonic
# 5. Fund the NEW wallet, register, resume daemon.
```

---

## Version upgrades

Patch releases are backwards-compatible — drop the new binary in place, restart, done. Minor/major releases may bump the storage-schema version (`CONFIG_VERSION`, `KEYSTORE_VERSION`, `CHECKPOINT_STATE_VERSION`); the daemon will refuse to start with a mismatching file, so back up before upgrading.

```bash
# systemd:
sudo systemctl stop automaton
sudo cp new-dist/cli/index.js /usr/local/bin/automaton
sudo systemctl start automaton
sudo journalctl -u automaton -f

# Docker:
docker pull titon/automaton:0.2.0
docker stop automaton && docker rm automaton
# …re-run with the new tag…
```

If `systemctl start` fails with a schema-version error, the release notes for the new version will document the migration path — typically one of:
- `rm ~/.titon/automaton/state.json` (event checkpoint is rebuildable).
- Re-run `automaton init` (wallet can be restored from mnemonic).

**Config-schema changes are rare** — the schema versions `z.literal(N)` so a mismatched config throws `ConfigValidationError` with a clear path. Read it, fix the field, restart.

---

## Backup and restore

Three files matter, in order of criticality:

| File | Recoverable from | Back up? |
|---|---|---|
| The 24-word **mnemonic** (written on paper during `init`) | Nothing. This IS the key. | **YES, on paper, in multiple locations.** |
| `~/.titon/automaton/wallet.enc` | The mnemonic + your encryption password. | Nice-to-have. If lost, re-run `init --import-mnemonic`. |
| `~/.titon/automaton/config.json` | `automaton init` defaults. | Nice-to-have (only operator-customised endpoints / webhook are lost). |
| `~/.titon/automaton/state.json` | Rebuilt by replay on restart. | Skip. |
| `~/.titon/automaton/automaton.lock` | Created per daemon start. | Never. |

**Recommended backup cadence** — mnemonic once, on paper, never touched again. Full `~/.titon/automaton/` directory nightly via whatever backup system you already use (restic, borg, S3 snapshot). Restoring is `tar -xf backup.tar -C ~/.titon/automaton/`.

**Do NOT version-control** `wallet.enc` — even encrypted it's a secret. Git history is forever.

---

## Multi-region

If you want to run automaton across regions for RPC resilience: **don't run two daemons for the same wallet simultaneously.** They'll submit duplicate Execute txs, waste gas, and potentially double-slash on edge cases. The lockfile protects against two daemons on ONE host; it does not protect against two hosts.

Safe patterns:
- **Active/passive failover.** Host A holds the only running daemon. Host B has the same `~/.titon/automaton/` via rsync (or shared NFS, carefully — the lockfile semantics assume local fs). If A dies, start B manually or via DNS failover.
- **Separate wallets per region.** Register two independent automatons (separate mnemonics → separate addresses). Each runs its own daemon, independently. You pay 2× stake but get true redundancy and the pool's round-robin naturally load-balances between them.

The first pattern is simpler; the second is safer. For testnet experimentation, either is fine.

Cross-region RPC failover is already handled transparently by `FailoverTonClient` (`src/chain/ton-client.ts`) — list endpoints from different providers in `config.endpoints` and the daemon rotates on transient errors.
