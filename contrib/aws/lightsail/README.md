# Titon automaton — Lightsail Terraform module

Cheapest cloud deployment: $3.50/month on a `nano_3_0` instance. Single Lightsail VPS + static IP + systemd-managed daemon, installed via `npm install -g @titon-network/automaton` on first boot. Smoke-tested end-to-end on the Titon protocol team's testnet canary.

```
Lightsail nano_3_0 ($3.50/mo)
├── Ubuntu 22.04 LTS
├── 512 MB RAM, 1 vCPU, 20 GB SSD
├── Node.js 22 (NodeSource) + @titon-network/automaton (npm)
├── systemd: titon-automaton.service (User=automaton, hardened)
├── Static IP attached (free while attached)
└── Wallet pre-initialised locally — keystore embedded in user-data
```

**No Docker, no source clone.** First boot installs Node 22, runs `npm install -g @titon-network/automaton`, materialises the wallet/config/env from terraform variables, drops a hardened systemd unit, and starts the daemon. The whole bootstrap is ~30 seconds; the daemon's ~256 MB working set fits comfortably in nano's 512 MB.

---

## Posture + trade-offs

| | |
|---|---|
| Cost | $3.50–$5/mo (`nano_3_0` / `micro_3_0`) |
| Bootstrap mode | Keystore-mode — operator runs `automaton init` locally, uploads the resulting `wallet.enc` |
| Mnemonic exposure | **Never enters AWS** (stays on paper) |
| Password exposure | Terraform state (encrypt your backend) |
| Keystore exposure | Terraform state + Lightsail user-data (the AWS API can read it back via `lightsail:GetInstance`) |
| Customisation | Lightsail abstractions only (no VPC / SG / IAM tuning) |
| Recommended for | Testnet trials, hobbyist operators, small mainnet positions |

For larger mainnet positions, prefer a from-source / systemd or self-hosted Docker deployment with an IAM-isolated secret store — see [`../../../docs/deploy.md`](../../../docs/deploy.md) for the full path matrix.

---

## Prerequisites

1. **AWS CLI configured** with permissions for Lightsail.
2. **Terraform ≥ 1.5**.
3. **A locally-initialised wallet** — run `automaton init` on your laptop (NOT on AWS):
   ```bash
   # Build automaton from source (one-time):
   git clone https://github.com/titon-network/automaton.git
   cd automaton && pnpm install && pnpm run build
   ./dist/cli/index.js init --network testnet
   # → produces ~/.titon/automaton/wallet.enc + config.json
   # → prints your wallet address
   ```
4. **Encrypted Terraform state** — the keystore + password land in state. Use S3 + KMS, or `terraform_remote_state` with encryption, or run from a machine with disk encryption you trust. **Don't commit `terraform.tfstate` to git.**

---

## Quickstart

```hcl
provider "aws" {
  region = "us-east-1"
}

module "automaton" {
  source = "github.com/titon-network/automaton//contrib/aws/lightsail?ref=main"

  network              = "testnet"
  wallet_keystore_file = "${pathexpand("~")}/.titon/automaton/wallet.enc"
  keystore_password    = "your-strong-password" # use a TF_VAR_keystore_password env in CI

  # Optional: pin a specific RPC endpoint instead of public toncenter.
  # Default = the public toncenter URL for the chosen network — free, but
  # rate-limited (~1 req/s). For anything beyond a one-off canary,
  # override here. See ../../docs/ops.md §Choosing an RPC for trade-offs.
  # rpc_url     = "https://toncenter.com/api/v2/jsonRPC"
  # rpc_api_key = var.toncenter_api_key  # sensitive — TF state must be encrypted

  # Optional: enable Fortuna VRF alongside Kronos. Run `automaton bls keygen`
  # locally first to produce ~/.titon/automaton/bls.enc; the same wallet
  # password unlocks both keystores (v1 same-password model). Atlas
  # registration is operator-driven post-apply — see §Enabling Fortuna.
  # bundle_id            = "micro_3_0"  # 1 GB RAM recommended with Fortuna on
  # bls_keystore_file    = "${pathexpand("~")}/.titon/automaton/bls.enc"
}

output "public_ip"       { value = module.automaton.public_ip }
output "ssh"             { value = module.automaton.ssh_command }
output "bootstrap_log"   { value = module.automaton.bootstrap_log_command }
```

```bash
export TF_VAR_keystore_password="..."
terraform init && terraform apply
```

---

## Operations

### Get an SSH key (or skip it)

Lightsail's **browser-based SSH** works out of the box with no key and no firewall opening — open the instance in the [Lightsail console](https://lightsail.aws.amazon.com/) and click "Connect using SSH". This is the fastest path for first-touch ops; routes through Lightsail's mgmt plane, not your firewall.

For SSH from your terminal, download the default key pair from the [Lightsail console](https://lightsail.aws.amazon.com/) (Account → SSH keys → "Default key for *region*"), then add `["1.2.3.4/32"]` to `allowed_ssh_cidrs` and `terraform apply`.

> ⚠️ **`allowed_ssh_cidrs` semantics.** Lightsail's blueprint default firewall opens port 22 to **`0.0.0.0/0`**. The module gates whether to *restrict* that:
> - **Empty list** (default) — module does **not** create an `aws_lightsail_instance_public_ports` resource, so the blueprint default stands: **port 22 open to the world**. Browser SSH still works either way; key-based SSH from a terminal works from any IP.
> - **Non-empty list** — port 22 is restricted to the listed CIDRs and closed to everyone else.
>
> If you want browser-only access (port 22 closed entirely), Lightsail's API requires you to pass at least one `port_info` block to manage public ports — i.e. you can't use this module alone to fully close 22. For testnet the blueprint default is acceptable; for mainnet, set `allowed_ssh_cidrs = ["<your-ip>/32"]`.

### Stake on-chain (after funding)

```bash
ssh ubuntu@$(terraform output -raw public_ip)
sudo automaton stake register 10
```

(The `automaton` wrapper at `/usr/local/bin/automaton` invokes the daemon's installed binary as the `automaton` system user with the same env the systemd unit uses; `sudo` is needed to read `/etc/automaton.env`.)

### Tail logs

```bash
ssh ubuntu@$(terraform output -raw public_ip) sudo journalctl -u titon-automaton -f
```

### Backup

The wallet is the persistent identity; you already have `wallet.enc` locally (you used it as input to terraform). The in-flight event-checkpoint state lives on the instance's root disk and re-derives from chain history on restart, so backup is mostly belt-and-suspenders. If you want it, enable Lightsail's automatic-snapshot add-on by editing `main.tf` to add an `add_on` block to `aws_lightsail_instance` (`type = "AutoSnapshot"`, `snapshot_time = "06:00"`, `status = "Enabled"`). First 7 retained snapshots per instance are included in the bundle price.

### Upgrade

Two paths:

- **Pin a new version via terraform.** Bump `automaton_version` (e.g. `"0.4.0"`) and `terraform apply -replace=module.automaton.aws_lightsail_instance.this`. The instance is replaced; first boot installs the pinned npm version. Static IP stays attached, so DNS doesn't churn.
- **In-place SSH upgrade.** Faster but doesn't update the terraform record:
  ```bash
  ssh ubuntu@$(terraform output -raw public_ip)
  sudo npm install -g @titon-network/automaton@latest
  sudo systemctl restart titon-automaton
  ```

### Resize

Lightsail bundles can't be changed in-place — recreate the instance:
```bash
terraform apply -replace=module.automaton.aws_lightsail_instance.this -var bundle_id=micro_3_0
```
The static IP stays attached; only the instance is replaced. The keystore is re-embedded from your local `wallet.enc`, so the wallet identity is preserved.

---

## Enabling Fortuna

Fortuna VRF is opt-in. The daemon stakes once with ForgeTON and earns from
every admitted consumer product; flipping Fortuna on adds VRF fulfillment
work alongside Kronos automation.

### Step 1 — Generate a BLS keystore locally

```bash
automaton bls keygen
# → produces ~/.titon/automaton/bls.enc (encrypted under the wallet password)
# → prints the 48-byte G1 pkShare
```

The BLS secret is held in a separate file from the TON wallet but unlocks
with the same password today (v1 same-password model). Back up `bls.enc`
alongside `wallet.enc` — losing both ends the operator's BLS identity.

### Step 2 — Pass it to the module + bump the bundle

```hcl
module "automaton" {
  source = "github.com/titon-network/automaton//contrib/aws/lightsail?ref=main"

  network              = "testnet"
  bundle_id            = "micro_3_0"   # recommended ≥ 1 GB RAM with Fortuna on
  wallet_keystore_file = "${pathexpand("~")}/.titon/automaton/wallet.enc"
  bls_keystore_file    = "${pathexpand("~")}/.titon/automaton/bls.enc"
  keystore_password    = var.keystore_password
}
```

`terraform apply`. The bootstrap embeds both keystores, flips
`config.products.fortuna: true`, and brings up the daemon. The
FortunaWorker initialises and idles until Atlas knows about the pkShare.

### Step 3 — Register the pkShare at Atlas (one-time, operator-driven)

This step is NOT run by bootstrap because Atlas registration costs gas
and requires the wallet to be active in ForgeTON first. After
`automaton stake register <amount>` has confirmed:

```bash
ssh ubuntu@$(terraform output -raw public_ip) sudo automaton bls register
# Submits RegisterBlsShare to Atlas; verifies the share landed.
```

`terraform output fortuna_register_command` prints the verbatim command
when `bls_keystore_file` is set.

> ⚠️ **`OperatorNotFound (120)` on `bls register`** means Atlas isn't yet
> admitted as a ForgeTON consumer — its operator map for the wallet is empty
> because `AutomatonSync` never reaches it. This is a one-time
> ForgeTON-owner-driven prerequisite, not an operator-fixable error. See
> [§Enabling Fortuna VRF in `docs/deploy.md`](../../../docs/deploy.md#enabling-fortuna-vrf)
> for the admit + force-sync flow. On the testnet canary today this is
> already done; fresh deploys against testnet should land cleanly.

### Verifying Fortuna is live

```bash
ssh ubuntu@$(terraform output -raw public_ip) sudo automaton status --format json | jq .fortuna
# → non-null when the daemon has Atlas + Fortuna runtime
```

In the daemon log (`journalctl -u titon-automaton -f`):
- `fortuna worker initialised` — bootstrap loaded the BLS share
- `fortuna: operator mirror updated for self isActive=true` — Atlas accepted RegisterBlsShare and the mirror has fanned out
- On a `RequestCreated` matching this group: `fortuna: fulfill submitted ...`

---

## Sizing guide

| Bundle | RAM | vCPU | Disk | Cost | When to use |
|---|---|---|---|---|---|
| `nano_3_0` | 512 MB | 1 | 20 GB | $3.50/mo | Default. Testnet, single product (Kronos), no Fortuna |
| `micro_3_0` | 1 GB | 2 | 40 GB | $5/mo | Comfort headroom for sandbox tests, Fortuna leg, log accumulation |
| `small_3_0` | 2 GB | 2 | 60 GB | $10/mo | Mainnet, multiple products, paid RPC endpoint, monitoring agent |

The daemon's working set is ~256 MB Kronos-only. Adding Fortuna's BLS
signing + pending request queue brings it close to nano's 512 MB ceiling
under load — the recommendation is `micro_3_0` whenever Fortuna is on.
Nano fits but no swap. Bump to micro if you see OOM-kills in
`journalctl`.

---

## Security notes

The Lightsail module trades stricter security for simplicity. The honest accounting:

| Asset | Where it is | Risk | Mitigation |
|---|---|---|---|
| Mnemonic | Operator's paper backup, never on AWS | None from this module | Operator-side discipline |
| Keystore (wallet.enc) | Terraform state + Lightsail user-data | `lightsail:GetInstance` API exposes user-data; state file exposes its contents | (a) encrypt the TF backend; (b) AES-encrypted keystore is useless without the password; (c) lock down the Lightsail IAM principal set |
| BLS keystore (bls.enc) | Same places as wallet.enc when Fortuna is on | Same | Same. The BLS secret unlocks under the wallet password (v1 same-password model); Phase F introduces per-identity passwords |
| Password | Same places as keystore | Same | Same — and the encrypted keystore is what's slowing the attacker; password alone is useless |
| Daemon SSH access | Lightsail-managed keys | Lightsail key compromise → instance access | Use SSH from a hardware key + tighten `allowed_ssh_cidrs` |

The Lightsail module's posture is appropriate for testnet exploration and small mainnet positions. For larger mainnet positions where the keystore should not ride in Terraform state, prefer a self-hosted systemd or Docker deployment with an IAM-isolated secret store of your choice.

---

## Bug reports & PRs

[github.com/titon-network/automaton/issues](https://github.com/titon-network/automaton/issues) — tag with `aws-lightsail`.
