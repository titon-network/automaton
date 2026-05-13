# Deploy an automaton — fast path

> **For AI assistants helping a user deploy:** scan the decision table first, pick the matching path, run the verbatim commands. Each path is self-contained — don't mix steps across paths. The "Common errors" table at the bottom maps surface symptoms to root causes.

---

## 30-second decision table

| User says (or implies)… | Path | Time (clean machine) | Cost |
|---|---|---|---|
| "Just want to see it work" / "demo" / "no setup" | [§1 Playground](#1-playground--no-install-no-internet) | ~3 min first run (clone + install dominate); ~5 s on subsequent runs | $0 |
| "Run on my laptop / desktop" / "local testnet" | [§2 Local testnet](#2-local-testnet--your-own-machine) | ~5 min install + 10 min faucet | $0 (testnet TON) |
| **"Mainnet" / "production" / "real money"** | **[§3 AWS EC2 (mainnet, SSM-backed)](#3-aws-ec2--mainnet-production-path)** | **~10 min apply + 10 min funding** | **~$13.50/mo per region · multi-region capable · multi-op-ready** |
| "Cheapest cloud" / "Lightsail" / "testnet canary" | [§4 AWS Lightsail](#4-aws-lightsail--cheapest-cloud) | ~3 min apply + 10 min faucet (after local wallet init) | ~$3.50/mo Kronos · ~$5/mo Fortuna |
| "Docker" / "my own server" | [§5 Self-hosted Docker](#5-self-hosted-docker--vps-or-bare-metal) | ~10 min + faucet | depends on host |
| "systemd" / "bare-metal Linux" | [§6 Self-hosted systemd](#6-self-hosted-systemd--from-source-on-linux) | ~15 min + faucet | depends on host |

**Default questions to ask the user before picking** (only if the path isn't obvious):
1. **Testnet or mainnet?** Mainnet → §3 (EC2). Testnet → §2 / §4. The EC2 module keeps the encrypted `wallet.enc` + password + `bls.enc` in **SSM Parameter Store** (KMS-encrypted, IAM-scoped), never in Terraform state. Lightsail (§4) lands them in TF state — fine for the testnet canary, sketchy for mainnet stake.
2. **Do they have AWS already configured?** `aws configure` works + has IAM permissions → §3 (mainnet) or §4 (cheap testnet). Otherwise → §1 / §2 / §5 / §6.
3. **Trying it or operating it?** Trying → §1 Playground (no real TON, exit Ctrl-C). Operating → any path §2–§6 (real wallet, real chain).
4. **Just Kronos, or also Fortuna VRF / Themis?** Kronos is the baseline (any active staked operator participates in round-robin assignment automatically). Fortuna is opt-in via `config.products.fortuna`. Themis (sealed-bid threshold-decryption) is opt-in via `config.products.themis` + `config.themis.chambers`. Onboarding shapes:
   - **Fortuna solo-mode (testnet only)** — `t=1, n=1`, `pkShare == groupPk` invariant. Single operator. Atlas's `publishSoloGroupKey` ceremony script. Single point of forgery; deliberately blocked on mainnet.
   - **Fortuna multi-op (mainnet)** — `t = n`, additive threshold-BLS. ≥ 2 operators sign + exchange partials over HTTP, leader aggregates + submits. No single point of forgery (the group secret is never assembled anywhere). Atlas's `publishMultiOpGroupKey` ceremony script. Spec + operator setup at [`docs/multi-op-fortuna.md`](multi-op-fortuna.md). End-to-end smoke after setup: `fortuna/scripts/coinFlipMainnetE2E.ts` (deploys CoinFlip → flip → polls until fulfilled).
   - **Themis (v1: solo-mode only)** — uses the same `bls.enc` as Fortuna (Atlas group secret signs both). Operator additionally lists each chamber to serve in `config.themis.chambers`. The Themis factory must be admitted as a ForgeTON consumer + Atlas verifier (one-time owner-driven). Multi-op + auto-discovery via factory `ChamberDeployed` events land in v1.1.

---

## 1. Playground — no install, no internet

Boots an in-process sandbox blockchain, deploys ForgeTON + Kronos + Atlas + Fortuna, registers a demo automaton, runs the real daemon code path. **Not real TON.** Use this when the user says "show me what it does" or "I just want to see it work."

```bash
npx @titon-network/automaton playground --ticks 5
```

Expected output: 5 ticks, demo automaton earns Kronos rewards + Fortuna VRF fulfillment rewards, summary line at bottom. Total wall-clock ~5 s.

If they want to keep it running indefinitely, drop `--ticks 5`. Ctrl-C exits cleanly.

---

## 2. Local testnet — your own machine

Real testnet wallet on the user's laptop/desktop. They keep the keystore + run the daemon themselves. Best for hobbyist operators or anyone who already runs a Linux box at home.

### Step 1 — Install

```bash
npm install -g @titon-network/automaton
automaton --version
```

### Step 2 — Initialize wallet

```bash
automaton init --network testnet
# Interactive: pick "new", write down the 24-word mnemonic, set a password.
# Prints the wallet address — copy it.
```

### Step 3 — Fund (user action, ~10 min)

User sends the address printed above to **[@testgiver_ton_bot](https://t.me/testgiver_ton_bot)** on Telegram. The bot drops 2 TON per request; they need **≥ 11 TON total (10 stake + 1 gas reserve)**, so request **at least 6 times** (5 × 2 = 10 TON falls just short).

Verify:
```bash
automaton status   # balance: 12.0 TON
```

### Step 4 — Register on-chain

```bash
automaton stake register 10
# Prompts for keystore password.
# Confirms with tx hash + tonviewer URL.
```

### Step 5 — Run the daemon

```bash
automaton run
# Logs JSON lines to stdout. Ctrl-C for clean shutdown.
```

To run as a service (Linux): see [§6 Self-hosted systemd](#6-self-hosted-systemd--from-source-on-linux). For Docker: see [§5](#5-self-hosted-docker--vps-or-bare-metal).

---

## 3. AWS EC2 — mainnet production path

**The recommended mainnet path.** Single t4g.small per region (~$13.50/mo on-demand, ~$7/mo on a Savings Plan), encrypted secrets in **SSM Parameter Store** (KMS-encrypted, IAM-scoped, rotation-friendly — never in Terraform state), Docker container running the team-published `public.ecr.aws/b0k9s4w3/automaton:0.8.0` multi-arch image (built from the audited-SDK-pinned codebase) under systemd, no inbound SSH (SSM Session Manager for ops), multi-region by instantiating once per region with its own SSM path.

Full module reference: [`contrib/aws/ec2/README.md`](../contrib/aws/ec2/README.md). Multi-op Fortuna protocol + operator setup: [`docs/multi-op-fortuna.md`](multi-op-fortuna.md).

### Prerequisites

- AWS CLI configured (`aws configure`) with IAM scope: EC2 + IAM (role/policy/instance-profile) + SSM (PutParameter / GetParameter / StartSession) + KMS (Decrypt for the SSM-managed key) in each target region
- Terraform ≥ 1.5
- Docker on your local machine (only for the one-time image build IF you publish your own image; the default points at `public.ecr.aws/b0k9s4w3/automaton:0.8.0` which is the audited team build)
- A locally-generated wallet (`automaton init --network mainnet`) — mnemonic stays on paper, off AWS

### Step 1 — Generate the wallet locally

The mnemonic NEVER touches AWS. Generate, capture, store on paper:

```bash
mkdir -p ~/.titon/automaton-mainnet-<REGION>
TITON_HOME=~/.titon/automaton-mainnet-<REGION> automaton init --network mainnet
# → ~/.titon/automaton-mainnet-<REGION>/automaton/wallet.enc + config.json
# → prints UQ-form mainnet address
```

### Step 2 — Upload secrets to SSM (per region)

```bash
REGION=eu-central-1   # or us-east-1, etc.
SSM_PATH=/titon/automaton/$REGION

aws ssm put-parameter --region "$REGION" --type SecureString \
    --name "$SSM_PATH/wallet.enc" \
    --value "$(base64 -w0 < ~/.titon/automaton-mainnet-$REGION/automaton/wallet.enc)"

aws ssm put-parameter --region "$REGION" --type SecureString \
    --name "$SSM_PATH/password" --value "$YOUR_KEYSTORE_PASSWORD"
```

### Step 3 — `terraform apply`

```hcl
provider "aws" { region = "eu-central-1" }

module "automaton" {
  source = "github.com/titon-network/automaton//contrib/aws/ec2?ref=main"

  ssm_path = "/titon/automaton/eu-central-1"
  network  = "mainnet"
  name     = "titon-automaton-mainnet-eu-central-1"

  # Default automaton_image = public.ecr.aws/b0k9s4w3/automaton:0.8.0
  # Default rpc_url = public toncenter (rate-limited; override for production)
}
```

```bash
terraform init && terraform apply
```

EC2 instance + IAM role + Elastic IP + security group come up; first-boot bootstrap fetches secrets from SSM, materialises them on disk, starts the Docker container under systemd. ~1.5 min from `terraform apply` to a healthy daemon.

### Step 4 — Fund + register

Send ≥ 11 TON to the wallet's UQ-form address (10 stake + 1 gas reserve), then:

```bash
INSTANCE=$(terraform output -raw instance_id)
aws ssm start-session --target "$INSTANCE" \
    --document-name AWS-StartInteractiveCommand \
    --parameters command='sudo /usr/local/bin/automaton stake register 10'
```

### Step 5 (optional) — Multi-op Fortuna

Once you have ≥ 2 operators (each with their own EC2 deployment from §3 + each staked + active), follow [`docs/multi-op-fortuna.md`](multi-op-fortuna.md) §"Operator setup":

1. Each operator runs `automaton bls keygen` locally → `bls.enc` + 96-hex pkShare
2. Operators hand their pkShare hex to the Atlas owner (public, off-chain channel)
3. Atlas owner runs `pnpm run publish:groupkey:multi:mainnet -- --pkshares <hex_1>,<hex_2>,...` (in `atlas/` repo) — sums shares to `groupPk`, publishes with `memberCount=N, threshold=N`
4. Each operator uploads `bls.enc` to SSM (`make upload-bls`)
5. Each operator updates its terraform: `enable_fortuna = true`, `peer_ips = ["<other-EIP>"]`, then `terraform apply` — instance replaces with multi-op + 9091 SG rules
6. Each operator updates SSM `config.json` to include the `fortuna.peers` block + `shareExchangeHost: "0.0.0.0"`, then `systemctl restart titon-automaton`
7. Each operator runs `automaton bls register` once

End-to-end smoke from a local clone of [`fortuna/`](https://github.com/titon-network/fortuna): `dotenv -e .env.mainnet -- npx ts-node scripts/coinFlipMainnetE2E.ts` (env vars: `AUTOMATON_PASSWORD`, `TONCENTER_API_KEY`, `KEYSTORE_PATH`). Deploys CoinFlip on mainnet, sends a flip, polls for fulfillment. Both daemons should sign + exchange partials; leader aggregates + submits; `flipsTotal` advances within ~1-2 minutes.

### Why this path for mainnet

| | Lightsail (§4) | EC2 (§3) |
|---|---|---|
| Cost | $3.50/mo | ~$13.50/mo |
| Bootstrap mode | Keystore in TF state + Lightsail user-data | **SSM Parameter Store, KMS-encrypted, IAM-scoped** |
| Secret rotation | Edit TF + apply | `aws ssm put-parameter --overwrite` + `make restart` (no terraform-apply needed) |
| Multi-op support | ❌ no peer share-exchange config | ✅ `peer_ips` opens TCP/9091 between operators |
| Operator shell | Browser SSH | **SSM Session Manager** (no inbound port) |
| Recommended for | Testnet canary | **Mainnet** |

Full module docs: [`contrib/aws/ec2/README.md`](../contrib/aws/ec2/README.md).

---

## 4. AWS Lightsail — cheapest cloud

Single Lightsail VPS, $3.50/mo. **Keystore-mode bootstrap**: user runs `automaton init` locally first, then passes the keystore through Terraform. Mnemonic never enters AWS.

### Prerequisites

- AWS CLI configured (`aws configure`)
- Terraform ≥ 1.5
- **A locally-initialized wallet** — Lightsail uses keystore-mode bootstrap, so `automaton init` must run on the user's local machine BEFORE `terraform apply`. The mnemonic stays on paper, off AWS entirely.

> ⚠️ **Mainnet caveat**: this path stores the encrypted keystore in Terraform state + Lightsail user-data (readable via `lightsail:GetInstance` for any AWS principal with that permission). Acceptable for testnet and small mainnet stakes; for larger mainnet positions where the keystore should NOT ride in TF state, route to §3 (EC2 with SSM-backed secrets — recommended) or §5 (Docker) / §6 (systemd) with a managed-secrets backend of your choice.

### Step 1 — Generate the keystore locally

```bash
npm install -g @titon-network/automaton
automaton init --network testnet
# → produces ~/.titon/automaton/wallet.enc
# → prints the wallet address (you'll fund this in step 3)
```

If §2 was already run, skip this step and `ls ~/.titon/automaton/wallet.enc` to confirm the keystore is there.

### Step 2 — Apply

```hcl
# main.tf
provider "aws" { region = "us-east-1" }

module "automaton" {
  source = "github.com/titon-network/automaton//contrib/aws/lightsail?ref=main"

  network              = "testnet"
  wallet_keystore_file = pathexpand("~/.titon/automaton/wallet.enc")
  keystore_password    = var.keystore_password

  # Optional: enable Fortuna VRF alongside Kronos. Run `automaton bls keygen`
  # locally first; the Atlas-admission prereq is a separate ForgeTON-owner
  # step — see §Enabling Fortuna VRF below.
  # bundle_id            = "micro_3_0"
  # bls_keystore_file    = pathexpand("~/.titon/automaton/bls.enc")
}

variable "keystore_password" { type = string; sensitive = true }
output "public_ip"                { value = module.automaton.public_ip }
output "ssh"                      { value = module.automaton.ssh_command }
output "fortuna_register_command" { value = module.automaton.fortuna_register_command }
```

```bash
export TF_VAR_keystore_password="..."
terraform init
terraform apply
```

### Step 3 — Faucet + register

```bash
terraform output -raw public_ip
# Send that address to @testgiver_ton_bot on Telegram (≥ 11 TON).

# Then register via Lightsail browser SSH (open instance → Connect):
sudo automaton stake register 10
```

Daemon was already running from `terraform apply` — registration kicks off the earning loop.

### Notes

- Default bundle = `nano_3_0` (512 MB RAM, $3.50/mo). For Fortuna, set `bundle_id = "micro_3_0"` ($5/mo, 1 GB) — the BLS signing + pending-request queue puts nano close to its OOM ceiling under load.
- TF state contains the keystore + password (and `bls.enc` if Fortuna is on). **Encrypt the backend** (S3 + KMS, or a remote backend with KMS).
- Full module README + security trade-offs: [`contrib/aws/lightsail/README.md`](../contrib/aws/lightsail/README.md).

---

## 5. Self-hosted Docker — VPS or bare metal

Any Linux host with Docker. Same image the AWS modules run.

**Password handling tip:** `-e AUTOMATON_PASSWORD="..."` on the command line leaks to `ps`. Stash the password in a chmod-0600 env file and pass via `--env-file`:

```bash
echo "AUTOMATON_PASSWORD=...your-password..." > ~/.titon-pw && chmod 600 ~/.titon-pw
```

Then every `docker run` below gets `--env-file ~/.titon-pw` instead of `-e AUTOMATON_PASSWORD=...`.

### Step 1 — Initialize the wallet

State lives at `~/.titon/automaton/` on the host (bind-mounted into the container — simpler key management than baking state into the image).

```bash
mkdir -p ~/.titon/automaton
docker run --rm -it -v ~/.titon:/home/nonroot/.titon \
  titon/automaton:latest init --network testnet
# Prints the wallet address — copy it for step 2.
```

### Step 2 — Fund (user action, ~10 min)

Send the printed address to **[@testgiver_ton_bot](https://t.me/testgiver_ton_bot)** on Telegram (≥ 6 requests for ≥ 11 TON). For mainnet, transfer from your funded source.

### Step 3 — Register on-chain

```bash
docker run --rm -it -v ~/.titon:/home/nonroot/.titon \
  --env-file ~/.titon-pw \
  titon/automaton:latest stake register 10
```

### Step 4 — Run as a long-lived service

```bash
docker run -d \
  --name automaton \
  --restart unless-stopped \
  -v ~/.titon:/home/nonroot/.titon:rw \
  --env-file ~/.titon-pw \
  -p 127.0.0.1:9090:9090 \
  titon/automaton:latest run

# Tail logs:
docker logs -f automaton
```

For systemd-managed Docker, see [`docs/ops.md`](ops.md) §Docker + systemd.

---

## 6. Self-hosted systemd — from source on Linux

When the user wants no Docker, no cloud, just a Linux service.

```bash
# Install:
npm install -g @titon-network/automaton

# Init:
automaton init --network testnet
# (fund + register as in §2)

# Install systemd unit (the published package ships these under the
# `contrib/` directory of the install — npm prefix varies by setup):
NPM_PREFIX=$(npm prefix -g)
sudo cp "$NPM_PREFIX/lib/node_modules/@titon-network/automaton/contrib/automaton.service" /etc/systemd/system/
sudo cp "$NPM_PREFIX/lib/node_modules/@titon-network/automaton/contrib/automaton.env.example" /etc/automaton.env
sudo chmod 600 /etc/automaton.env
sudo $EDITOR /etc/automaton.env   # set AUTOMATON_PASSWORD=...

sudo systemctl daemon-reload
sudo systemctl enable --now automaton
sudo journalctl -u automaton -f
```

---

## Enabling Fortuna VRF

Fortuna is opt-in. The daemon stakes once with ForgeTON and earns from every admitted consumer; turning Fortuna on adds VRF fulfillment alongside Kronos automation. The flow has one prerequisite that operators routinely trip on, so do the steps in order.

### Prereq — Atlas must be admitted as a ForgeTON consumer (one-time)

ForgeTON only fans out `AutomatonSync` to addresses in its consumer set. Until Atlas is in that set, Atlas's operator map for the wallet stays empty and `automaton bls register` reverts with `OperatorNotFound (120)`. This is a **ForgeTON-owner-driven** step, not the operator's; if you (the deployer) aren't the ForgeTON owner, ask them to run:

```bash
cd ../forgeton
ADMIT_CONSUMER=<atlas-address-0Q...> pnpm run admit:consumer:testnet
```

If operators staked at ForgeTON BEFORE Atlas was admitted, also run a one-shot `ForceSync` per existing operator — see [`../atlas/sdks/typescript/skills/atlas-deploy.md`](../../atlas/sdks/typescript/skills/atlas-deploy.md) §Step 2.5 for the inline snippet. Verify with `atlas.getOperator(<wallet>)` returning `{ forgetonActive: true }` before the operator runs `bls register`.

### Operator-side flow

Order matters: `bls register` reads `products.fortuna` from the config to know it should look at the Atlas address, so the config flip happens before the on-chain registration. The daemon doesn't need to be running for `bls register`; it's a one-shot CLI tx.

```bash
# 1. Generate the BLS keystore locally (uses the wallet password by default —
#    v1 same-password model; future Phase F adds per-identity passwords).
automaton bls keygen
# → produces ~/.titon/automaton/bls.enc
# → prints the 48-byte G1 pkShare hex

# 2. Flip products.fortuna: true in config.json. Either via:
automaton config edit
# (set products.fortuna = true), OR via the Lightsail module's bls_keystore_file
# variable which does this in user-data automatically.

# 3. Wallet must be ForgeTON-active (post `automaton stake register`)
#    AND Atlas must be admitted at ForgeTON. Then submit the BLS share:
automaton bls register
# → submits RegisterBlsShare; verifies the share landed in Atlas's map
# → if OperatorNotFound (120), the Atlas-admission prereq above hasn't landed

# 4. Restart the daemon so it picks up the BLS keystore + Fortuna runtime:
sudo systemctl restart automaton    # systemd
# or `docker restart automaton`     # Docker
# or stop + restart `automaton run` if running foreground
```

After step 3 lands, Atlas fans the operator-mirror update out to Fortuna; the daemon (post-restart in step 4) sees `RequestCreated` events routed to your group. Confirm via:

```bash
automaton status --format json | jq .fortuna
# → non-null when Atlas + Fortuna are wired and the operator is in the group
```

In the daemon log, you'll see lines like `fortuna: operator mirror updated for self isActive=true` once the mirror lands, then `fortuna: fulfill submitted ...` whenever a request gets routed to your share.

### Lightsail-specific

The Lightsail module wraps steps 1-3 — pass `bls_keystore_file = pathexpand("~/.titon/automaton/bls.enc")` and the bootstrap embeds it alongside `wallet.enc`, flips `products.fortuna: true` in the generated config, and exposes a `fortuna_register_command` Terraform output for step 4. Bump `bundle_id = "micro_3_0"` while you're at it — Fortuna's working set won't fit comfortably on `nano_3_0`.

---

## Common errors during deploy

| User reports… | Cause | Fix |
|---|---|---|
| `cannot prompt for password: stdin is not a TTY` | Running `init` / `stake register` in a non-interactive shell (CI, Docker without `-it`, etc.) | Set `AUTOMATON_PASSWORD` env var, or use `--password-file <path>` |
| `keystore decryption failed — wrong password or corrupt data` | Wrong password (or AES-GCM tag mismatch from tampering) | Try the password again; if it's the right one, the keystore file is corrupt — restore from backup |
| `config not found at …/.titon/automaton/config.json` | They didn't run `automaton init` yet | `automaton init --network testnet` |
| `automaton is already running: pid X` | Lockfile from a previous run | Check `ps -p X`; if dead, `rm ~/.titon/automaton/automaton.lock` |
| `all N endpoint(s) failed after M attempt(s)` | Public toncenter rate-limited (testnet: ~1 req/s) or upstream outage | Wait + retry; for production add a paid endpoint to `config.endpoints` |
| `contract schema mismatch — refusing to start` | `automaton` version is older than the deployed contract | Upgrade: `git pull && pnpm install && pnpm run build` (or bump `docker_image` in Terraform) |
| `stake register` errors with `InsufficientWalletBalanceError` (CLI-side pre-check) or `exit 161 InsufficientTonSent` (contract-side, if pre-check is bypassed) | Wallet has < 11 TON of free balance | Faucet more (testnet) or send TON (mainnet). Need 10 stake + ~0.07 gas + ≥ 1 reserve |
| `automaton bls register` reverts with `OperatorNotFound (120)` (a.k.a. "atlas.getOperatorShare(me) returned no registered share after send") | Atlas isn't admitted as a ForgeTON consumer, so its operator map for the wallet is empty | ForgeTON owner runs `forgeton/scripts/admitConsumer.ts` with the Atlas address; if operators predate the admission, also run `ForceSync` per existing operator. See §[Enabling Fortuna VRF](#enabling-fortuna-vrf) above + `../atlas/sdks/typescript/skills/atlas-deploy.md` §Step 2 |
| `terraform apply` fails with "default VPC not found" | AWS account has had its default VPC deleted | Pass `vpc_id` + `subnet_id` explicitly to the module |
| Cloud-init never finishes | Docker pull fails because `titon/automaton:latest` isn't published yet | Build + push to your own ECR, pass `docker_image = "<ecr-url>"` to the module |
| Daemon starts but `/readyz` says `stake-active: false` | They haven't run `stake register` yet | Run it; daemon picks up registration on next poll cycle |

---

## Faucet, funding, and gas math

- **Testnet faucet**: [@testgiver_ton_bot](https://t.me/testgiver_ton_bot) on Telegram. ~2 TON per request, no rate limit but you may need to wait between drops. Need ≥ 11 TON total to register.
- **Wallet drains gas slowly**: each Execute fan-out costs ~0.07 TON. The daemon needs ≥ `minFreeBalance` (default 2 TON) to keep operating. Top up by sending TON to the wallet address.
- **Mainnet TON**: not available from a faucet — user has to acquire on an exchange and transfer.
- **Stake amount**: 10 TON is the pool minimum (`FORGETON_DEFAULTS.minStake`). More stake doesn't increase rewards — it increases the slash exposure if the operator misbehaves.

---

## RPC endpoints

- **Default** (free toncenter): rate-limited to ~1 req/s. Fine for testnet, marginal for mainnet.
- **Production mainnet**: get an API key from [toncenter.com](https://toncenter.com) (paid tier) or run your own TON full node and point at it. Add to `config.endpoints` array.
- **Failover ring**: the daemon supports multiple endpoints — it rotates on transient errors. List 2–3 for resilience.

---

## When in doubt

- Architecture, design rationale → [`CLAUDE.md`](../CLAUDE.md)
- Operator-facing reference → [`README.md`](../README.md)
- Production ops (backup, key rotation, upgrades) → [`docs/ops.md`](ops.md)
- Symptom → fix mapping → [`docs/troubleshooting.md`](troubleshooting.md)
- DX surface catalog → [`docs/dx.md`](dx.md)
