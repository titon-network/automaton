# Titon automaton — EC2 Terraform module

Production-posture mainnet deployment. Single EC2 instance per region, encrypted secrets in **SSM Parameter Store** (not Terraform state), Docker container under systemd, no inbound SSH (SSM Session Manager for ops). Multi-region by instantiating once per region with its own SSM path.

```
EC2 t4g.small ($12/mo on-demand, ~$7/mo on a Savings Plan)
├── Amazon Linux 2023 (ARM64), IMDSv2-only
├── Encrypted gp3 root volume (8 GiB default)
├── Docker daemon + ghcr.io/titon-network/automaton:<tag>
├── systemd unit wraps `docker run` → restart on crash, restart on reboot
├── IAM role: ssm:GetParameter scoped to /titon/automaton/<region>/*
│             + AmazonSSMManagedInstanceCore (Session Manager)
├── Security group: outbound 443 only; NO inbound by default
└── Optional Elastic IP for stable public address
```

The encrypted keystore (`wallet.enc`), keystore password, and optional `bls.enc` live in **SSM Parameter Store** as `SecureString` parameters under an operator-defined path — KMS-encrypted at rest, IAM-scoped to the per-instance role only, never present in Terraform state.

---

## Posture vs the Lightsail module

| | Lightsail | EC2 (this module) |
|---|---|---|
| Cost | $3.50–$5/mo | ~$12/mo on-demand t4g.small (~$7/mo with Savings Plan) |
| Bootstrap mode | Keystore embedded in user-data + TF state | Encrypted keystore in **SSM Parameter Store**; IAM-scoped read |
| Secrets in TF state | Yes (`wallet.enc` + password) | **No** — only the SSM path |
| Secrets exposure surface | TF state file + `lightsail:GetInstance` API | `ssm:GetParameter` on the path prefix only |
| Secret rotation | Edit TF + re-apply | `aws ssm put-parameter --overwrite` + `systemctl restart` |
| Operator shell | Browser SSH (Lightsail console) or key-based SSH | **SSM Session Manager** (no inbound port required) |
| Multi-region | One Terraform state per region | One Terraform state per region |
| Recommended for | Testnet canary, hobbyist operators | Mainnet, multi-region operator clusters |

For mainnet, use this module.

---

## Prerequisites

1. **AWS CLI configured** with credentials for the target account in each region you'll deploy to.
2. **Terraform ≥ 1.5**.
3. **A locally-generated wallet** — run `automaton init --network mainnet` on your laptop (NOT on AWS):
   ```bash
   git clone https://github.com/titon-network/automaton.git
   cd automaton && pnpm install && pnpm run build
   ./dist/cli/index.js init --network mainnet
   # → ~/.titon/automaton/wallet.enc + config.json
   # → prints the wallet's mainnet UQ-form address
   ```
   The mnemonic stays on paper. Only the encrypted keystore goes into SSM.
4. **(Optional) A locally-generated BLS keystore** — for Fortuna VRF:
   ```bash
   automaton bls keygen
   # → ~/.titon/automaton/bls.enc
   ```

---

## Quickstart

### 1. Upload secrets to SSM (per region)

```bash
REGION=eu-central-1
SSM_PATH=/titon/automaton/$REGION

# Wallet keystore (base64-encoded — sidesteps SSM 4 KB limit + quoting).
aws ssm put-parameter \
    --region "$REGION" --type SecureString \
    --name "$SSM_PATH/wallet.enc" \
    --value "$(base64 -w0 < ~/.titon/automaton/wallet.enc)"

# Keystore password.
aws ssm put-parameter \
    --region "$REGION" --type SecureString \
    --name "$SSM_PATH/password" \
    --value "$YOUR_KEYSTORE_PASSWORD"

# (Optional) BLS keystore — only when running Fortuna.
aws ssm put-parameter \
    --region "$REGION" --type SecureString \
    --name "$SSM_PATH/bls.enc" \
    --value "$(base64 -w0 < ~/.titon/automaton/bls.enc)"

# (Optional) Override config.json — useful when you want a paid RPC
# endpoint baked into config rather than passed via TF vars. The
# String form below is fine because config.json never contains
# secrets in this module's flow (the api key, if any, lives in here
# but is already protected by the SSM path's IAM scope).
aws ssm put-parameter \
    --region "$REGION" --type String \
    --name "$SSM_PATH/config.json" \
    --value "$(cat /path/to/your/config.json)"
```

> **Why base64 for `wallet.enc` / `bls.enc`?** SSM Parameter Store standard tier capacity is 4 KB, and the JSON-with-binary-ciphertext keystore can contain bytes that need careful quoting. Base64 stretches the size by ~33% (a typical wallet.enc is ~600 bytes raw → ~800 bytes base64) and gives you a safe ASCII payload. The bootstrap script `base64 -d`s it back. Advanced-tier SSM (8 KB) is available if you need it but is not free.

### 2. Instantiate the module

```hcl
provider "aws" {
  region = "eu-central-1"
}

module "automaton" {
  source = "github.com/titon-network/automaton//contrib/aws/ec2?ref=main"

  ssm_path = "/titon/automaton/eu-central-1"
  network  = "mainnet"
  name     = "titon-automaton-mainnet-eu-central-1"

  # Optional — paid RPC for production. For a one-off canary, leave
  # null and the bootstrap will use public toncenter (rate-limited).
  # rpc_url     = "https://toncenter.com/api/v2/jsonRPC"
  # rpc_api_key = var.toncenter_api_key

  # Optional — enable Fortuna alongside Kronos. Requires `bls.enc`
  # uploaded to ${ssm_path}/bls.enc first.
  # enable_fortuna = true

  # Optional — open SSH from your operator IP. Default is no inbound,
  # use SSM Session Manager instead. SSM is the recommended path.
  # allowed_ssh_cidrs = ["1.2.3.4/32"]

  additional_tags = {
    Environment = "mainnet"
    OwnerTeam   = "titon-protocol"
  }
}

output "instance_id"           { value = module.automaton.instance_id }
output "public_ip"             { value = module.automaton.public_ip }
output "ssm_session_command"   { value = module.automaton.ssm_session_command }
output "bootstrap_log_command" { value = module.automaton.bootstrap_log_command }
```

```bash
terraform init && terraform apply
```

First boot takes ~1.5 minutes (dnf install docker + jq + awscli, docker pull, secrets fetch, daemon start). Tail the bootstrap log:

```bash
$(terraform output -raw bootstrap_log_command)
```

---

## Operations

### Get a shell — SSM Session Manager

No SSH key, no open port. Just IAM permissions on the operator's local AWS CLI:

```bash
$(terraform output -raw ssm_session_command)
# → drops you into a root-equivalent shell on the instance
```

If your local IAM principal can `ssm:StartSession` on the instance ARN, this works out of the box. Use IAM least-privilege: scope to `arn:aws:ec2:<region>:<account>:instance/<instance-id>` so an operator can only session into instances they're authorised for.

### Stake on-chain (after funding the wallet)

Fund the wallet's UQ-form mainnet address with ≥ 11 TON (10 TON stake + 1 TON gas reserve), then:

```bash
aws ssm start-session --target $INSTANCE_ID \
    --document-name AWS-StartInteractiveCommand \
    --parameters command='sudo /usr/local/bin/automaton stake register 10'
```

The `automaton` wrapper at `/usr/local/bin/automaton` is a `docker exec` against the running daemon container — it inherits the container's `AUTOMATON_PASSWORD` env so you don't have to plumb the password through. `sudo` is required because only root can `docker exec`.

### Daily ops

```bash
# Check the daemon
sudo /usr/local/bin/automaton status
sudo /usr/local/bin/automaton doctor

# Tail logs
sudo journalctl -u titon-automaton -f

# Restart (e.g. after rotating the keystore password in SSM)
sudo systemctl restart titon-automaton
```

### Upgrade the automaton image

```bash
# 1) Bump `automaton_image` in your terraform root + terraform apply.
#    The user_data hash changes, so the instance is replaced cleanly
#    by the `user_data_replace_on_change = true` flag.

# 2) OR in-place — faster, doesn't update the terraform record:
sudo docker pull ghcr.io/titon-network/automaton:0.7.1
# Edit /etc/systemd/system/titon-automaton.service to bump the image tag, then:
sudo systemctl daemon-reload
sudo systemctl restart titon-automaton
```

The bind-mounted `/var/lib/automaton` survives container replacement, so wallet/config/state persist across image bumps without re-uploading SSM parameters.

### Rotate the keystore password (hot — no terraform-apply required)

The systemd unit's `ExecStartPre=/usr/local/sbin/titon-fetch-secrets` re-pulls every secret from SSM on each `systemctl restart`, so rotation is push-then-restart:

```bash
# 1) Locally, re-encrypt the keystore with a new password (offline).
#    Easiest path: re-init against a tmp TITON_HOME using the existing
#    mnemonic — produces a freshly-encrypted wallet.enc with the new
#    password.
TMPHOME=$(mktemp -d)
echo "<the 24-word mnemonic>" > /tmp/mnemonic.txt
TITON_HOME=$TMPHOME automaton init --network mainnet \
    --import-mnemonic /tmp/mnemonic.txt
shred -u /tmp/mnemonic.txt

# 2) Push both to SSM.
aws ssm put-parameter --overwrite --region $REGION --type SecureString \
    --name $SSM_PATH/wallet.enc \
    --value "$(base64 -w0 < $TMPHOME/automaton/wallet.enc)"
aws ssm put-parameter --overwrite --region $REGION --type SecureString \
    --name $SSM_PATH/password \
    --value "$NEW_PASSWORD"

# 3) Restart the daemon. ExecStartPre re-runs titon-fetch-secrets,
#    which materialises the new wallet.enc + new /etc/automaton.env
#    BEFORE the daemon container starts.
aws ssm start-session --target $INSTANCE_ID \
    --document-name AWS-StartInteractiveCommand \
    --parameters command='sudo systemctl restart titon-automaton'

shred -u $TMPHOME/automaton/wallet.enc
rm -rf $TMPHOME
```

The same flow rotates the BLS keystore (`SSM_PATH/bls.enc`), or swaps in a new operator-supplied `config.json` (`SSM_PATH/config.json`). Anything in SSM is hot-reloadable.

> The TF state never sees the rotated values — only the SSM path. Audit who has `ssm:PutParameter` + `kms:Encrypt` on this path.

### Resize / change instance type

```bash
terraform apply -var instance_type=t4g.medium
```

The `aws_instance` resource has `user_data_replace_on_change = true` but `instance_type` change is an in-place modify (Terraform stops, modifies, restarts). If you change CPU family (ARM64 ↔ x86_64), bump `architecture` in lockstep so the AMI lookup picks the right image — that triggers an instance replacement.

---

## Multi-region

This module is region-agnostic. Instantiate once per region, each with its own SSM path:

```
my-deployment/
├── eu-central-1/
│   ├── main.tf            # provider region = eu-central-1; module call with ssm_path = /titon/automaton/eu-central-1
│   └── terraform.tfstate  # local state, gitignored
└── us-east-1/
    ├── main.tf            # provider region = us-east-1; module call with ssm_path = /titon/automaton/us-east-1
    └── terraform.tfstate
```

A reference layout ships in the workspace at `automaton-mainnet/{eu-central-1,us-east-1}/`. SSM is **regional** — parameters in eu-central-1 are NOT visible from us-east-1 even with the same name. Upload secrets per region.

For "two operators, two regions": treat each region as a fully separate operator. Each gets its own mnemonic, its own wallet, its own funding, its own ForgeTON registration, and its own SSM secrets. The two operators earn rewards independently.

---

## Sizing guide

| Instance | RAM | vCPU | Cost (us-east-1, on-demand) | When to use |
|---|---|---|---|---|
| t4g.micro | 1 GB | 2 | ~$6/mo | Kronos-only mainnet, tight RAM, no Fortuna |
| **t4g.small** (default) | 2 GB | 2 | ~$12/mo | Default. Kronos + Fortuna comfortable, room for log retention |
| t4g.medium | 4 GB | 2 | ~$25/mo | Mainnet + multiple products + monitoring agent |
| c7g.medium | 2 GB | 1 | ~$21/mo | No burst-credit risk; guaranteed CPU baseline |

The daemon's working set is ~256 MB Kronos-only / ~400 MB with Fortuna's BLS signing + pending request queue. t4g.small fits both with headroom. Bump if you're keeping `journalctl` retention long or running additional sidecars.

The `t4g` family uses **burstable** CPU credits — for the steady-state polling workload (one tick every ~10 s) it stays in baseline indefinitely. If you sustain CPU > baseline (e.g. heavy Fortuna fulfillment bursts) and run out of credits, switch to `c7g.medium` for a guaranteed-CPU instance.

---

## Security notes

| Asset | Where it lives | Risk | Mitigation |
|---|---|---|---|
| Mnemonic | Operator's paper backup, never on AWS | None from this module | Operator-side discipline |
| Keystore (`wallet.enc`) | SSM SecureString | `ssm:GetParameter` + KMS-decrypt scoped to instance role only; AES-encrypted, useless without the password | Audit IAM; minimise principals with `ssm:GetParameter` on the path |
| Keystore password | SSM SecureString | Same | Same — and the encrypted keystore is what slows the attacker; password alone is useless |
| BLS keystore (`bls.enc`) | SSM SecureString (when Fortuna on) | Same as wallet.enc; today shares the wallet password (v1 same-password model) | Same. Phase F introduces per-identity passwords |
| Daemon shell access | SSM Session Manager (no inbound port) | Compromise of an IAM principal with `ssm:StartSession` | IAM least-privilege; require MFA on principals; CloudTrail on the instance ARN |
| Container runtime | Docker, read-only rootfs, `cap-drop ALL`, `no-new-privileges`, bound on 127.0.0.1:9090 | Container escape | Distroless image (no shell), AL2023 host (regular patches) |

The keystore is encrypted with the operator's password using scrypt+AES-GCM (matches ethers.js v6 parameters — N=131072). An attacker who exfiltrates ALL of {`wallet.enc`, password} has the wallet. An attacker with only one has nothing. Scope SSM IAM accordingly.

---

## Bug reports & PRs

[github.com/titon-network/automaton/issues](https://github.com/titon-network/automaton/issues) — tag with `aws-ec2`.
