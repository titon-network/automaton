# Release runbook — `@titon-network/automaton`

> End-to-end pipeline for shipping a new automaton version. Captures
> every step a new maintainer needs + every gotcha hit on past ships
> (0.12.0 → 0.14.0).
>
> **Read order:** prerequisites → release steps → verification → gotchas.
> If something fails, jump to the matching gotcha first.

Audience: titon-network maintainers cutting a release. Operators
running automatons should read [`docs/ops.md`](docs/ops.md) §"Version
upgrades" instead.

---

## Prerequisites (one-time per workstation)

| Need | Check | If missing |
|---|---|---|
| Docker daemon reachable as the calling user | `docker ps` returns without sudo | snap docker has no `docker` group — `sudo chmod 666 /var/run/docker.sock` (resets on reboot) |
| Multi-arch buildx builder | `docker buildx ls` lists `linux/arm64` | `docker buildx create --name titon-builder --use --bootstrap && docker run --privileged --rm tonistiigi/binfmt --install all` |
| AWS auth scoped to the live account | `aws sts get-caller-identity` shows the expected account / IAM principal | configure `~/.aws/credentials` per the team's mainnet ops workspace runbook (team-internal) |
| npm publish auth for `@titon-network/*` | `npm whoami` works (not 401) | `npm login` to refresh the token in `~/.npmrc` |
| ECR public auth | `aws ecr-public get-login-password \| docker login --username AWS --password-stdin public.ecr.aws` succeeds | re-run; tokens are short-lived |

---

## Release pipeline

### 1. Bump versions in lockstep

- `automaton/package.json` → next semver (`X.Y.Z`)
- `automaton-mainnet/eu-central-1/main.tf` `var.automaton_image` default → `public.ecr.aws/titon-network/automaton:X.Y.Z`
- `automaton-mainnet/us-east-1/main.tf` `var.automaton_image` default → same

Three files, same tag. Easy to miss one of the tf files.

### 2. Run the full automaton test suite

```bash
cd automaton && pnpm test
```

Should be all green. Known false-positive guards live in
`tests/DocsSurface.spec.ts:NOT_METRICS` — if you add a new Terraform
variable or config field with an `automaton_*` prefix, add it there.

### 3. Pack + sanity-check the npm tarball

```bash
cd automaton
pnpm pack --pack-destination /tmp/
tar -tzf /tmp/titon-network-automaton-<ver>.tgz | head -20
```

Inspect for accidentally-included files (`.env`, build artifacts not
in the `files` allowlist, etc.). The `files` field in `package.json`
gates this.

### 4. Build + push the multi-arch docker image

Build context must be the workspace root (one level above
`automaton/`) so the sibling SDK sources are visible.

```bash
# Login to ECR public (token expires in ~12h)
aws ecr-public get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin public.ecr.aws

cd <workspace-root>    # the dir holding automaton/ + sibling SDK repos
docker buildx build \
  --builder titon-builder \
  --platform linux/amd64,linux/arm64 \
  --tag public.ecr.aws/titon-network/automaton:<ver> \
  --tag public.ecr.aws/titon-network/automaton:latest \
  --file automaton/Dockerfile \
  --push \
  .
```

5-10 min total (two arches × full TS compile × four sibling SDK builds).

Verify on ECR:
```bash
aws ecr-public describe-images --region us-east-1 --repository-name automaton \
  --query 'imageDetails[?imageTags!=`null`].{tags:imageTags,pushed:imagePushedAt}' --output json
```

### 5. npm publish

```bash
cd automaton
pnpm publish --access=public --no-git-checks --otp=<your-6-digit-code>
```

- `--no-git-checks` — the workspace usually has uncommitted deploy
  artifacts (deployments.json, SSM payloads, etc.); pnpm's clean-tree
  check would block.
- `--otp=...` — registry enforces 2FA on every publish.

Verify:
```bash
npm view @titon-network/automaton@<ver> version time.modified
```

### 6. Terraform apply both regions (sequential)

EU first, verify, then US — never both in parallel (would partition
the multi-op share-exchange during the brief overlap when neither
instance is fully up).

```bash
# Assumes AWS_PROFILE is already exported in your shell.

cd <team-mainnet-ops>/eu-central-1
terraform apply -auto-approve
# Each apply REPLACES the EC2 instance (user_data changed).
# Wait ~3-5 min for: cloud-init → image pull → titon-fetch-secrets
# → systemd start. Then verify before moving on.

cd ../us-east-1
terraform apply -auto-approve
```

Wallet keystores live in SSM Parameter Store and survive instance
replace; only the EBS volume churns.

### 7. Verify each region

For each region, after the apply:

```bash
INSTANCE=$(terraform output -raw instance_id)
REGION=eu-central-1   # or us-east-1

# Image tag + uptime
CMD=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["docker ps --format \"{{.Image}} | {{.Status}}\" --filter name=titon-automaton"]' \
  --query 'Command.CommandId' --output text)
sleep 5
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" \
  --query 'StandardOutputContent' --output text

# Activity histogram (last 60s)
CMD=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["sudo journalctl -u titon-automaton --no-pager --since \"60 seconds ago\" | grep -oE \"\\\"msg\\\":\\\"[^\\\"]+\\\"\" | sort | uniq -c | sort -rn | head -10"]' \
  --query 'Command.CommandId' --output text)
sleep 5
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" \
  --query 'StandardOutputContent' --output text
```

Expect:
- `automaton:<new-ver> | Up <N> seconds`
- `phoebe: push verified` (the new poll-based verify — see G4 for the old false-positive)
- Multi-op partials broadcasting + aggregating (one of `phoebe: signed + broadcast our partial`, `phoebe: our snapshot accepted`)

### 8. End-to-end dapp-dev smoke

Confirm the live mainnet stack is consumable by external dapps:

```bash
mkdir -p /tmp/dapp-smoke && cd /tmp/dapp-smoke
cat > package.json <<'EOF'
{"name":"dapp-smoke","version":"1.0.0","private":true,"type":"commonjs"}
EOF
pnpm add @titon-network/phoebe-sdk @ton/ton @ton/core
cat > smoke.js <<'EOF'
const { TonClient } = require('@ton/ton');
const { Phoebe, PHOEBE_MAINNET, fetchVerifiedPrice } = require('@titon-network/phoebe-sdk');
(async () => {
    const client = new TonClient({ endpoint: 'https://toncenter.com/api/v2/jsonRPC' });
    const phoebe = client.open(Phoebe.createFromAddress(PHOEBE_MAINNET.phoebe));
    const q = await fetchVerifiedPrice(phoebe, 0, PHOEBE_MAINNET.operators);
    const price = Number(q.mantissa) * Math.pow(10, q.expo);
    console.log(`✓ TON/USD = $${price.toFixed(4)} (op=${q.sourceOperator.slice(0,12)}.., age=${q.ageSec}s)`);
})();
EOF
node smoke.js
```

Expect `✓ TON/USD = $X.XX (...)`. Re-run a few times — first attempt may catch an empty-leaves window.

---

## Gotchas hit on past ships

### G1 — pnpm supply-chain `minimumReleaseAge` blocks same-day SDK installs

pnpm 10.x ships with `minimumReleaseAge` defaulting to 24h. A
`@titon-network/*` SDK published <24h ago breaks the docker build
with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`.

**Fix in place:** `Dockerfile` passes `--config.minimum-release-age=0`
to every `pnpm install` + `pnpm prune` invocation. If you add new
pnpm invocations to the Dockerfile, the flag MUST be passed.

### G2 — `pnpm run build` re-invokes `pnpm install` internally

pnpm's "deps-status check" re-runs install before `pnpm run`,
ignoring CLI flags from the outer call. **Fix in place:** Dockerfile
calls `tsc` directly via `./node_modules/.bin/tsc -p tsconfig.json`
instead of `pnpm run build`. Don't switch back without re-deriving
the policy bypass.

### G3 — Multi-arch buildx needs qemu binfmt handlers

If `docker buildx inspect titon-builder` shows only `linux/amd64` (no
arm64), install once:
```bash
docker run --privileged --rm tonistiigi/binfmt --install all
```
Mainnet operators run on `t4g.small` (Graviton / arm64) — without
arm64 in the image manifest the EC2 pull silently uses no-arch image
or fails.

### G4 — V5R1 ghost-tx pattern (was: false-positive "push verified")

**Fixed in 0.14.0.** When the operator wallet balance dropped below
the push value + storage reserve, V5R1 silently dropped the action
phase (seqno still advanced). The old verify checked only
`getLastSubmitter` against our wallet, which held over from a *prior*
push by us — so verify returned success even though THIS push never
reached phoebe.

The new verify polls `phoebe.lastSnapshotTime` until it advances to
(or past) the push's `opts.timestamp`. If it doesn't within the
poll budget (default 30s), throws with the operator's wallet
address inline — actionable error.

**Monitoring:** the metric `automaton_wallet_balance_ton` already
exists. Alert below ~1 TON to catch the wallet-drain class before
ghosting starts.

### G5 — Snap docker has no `docker` group

`sudo usermod -aG docker $USER` fails with "group 'docker' does not
exist" on Ubuntu snap-installed docker. Workaround:
```bash
sudo chmod 666 /var/run/docker.sock
```
Scope: until reboot / snap restart. For a persistent fix, switch
from snap to apt docker.

### G6 — `terraform apply` triggers EC2 instance REPLACE on user_data changes

The image tag, SG rules, `enable_fortuna` flag, and peer IPs all
render into user_data. Any change → instance must be replaced.
~3-5 min downtime per region during the boot.

Wallet keystores (`wallet.enc`, `password`, `bls.enc`, `config.json`)
live in SSM Parameter Store and survive — only the EBS volume goes
away.

### G7 — Force-sync after admitting a new consumer

If a new consumer (e.g. atlas → new factory) is admitted at forgeton,
forgeton's fan-out cursor may not reach the new slot on the first
ForceSync. Re-run 2-3x to guarantee coverage. Documented in
`../DEPLOY_CORE.md` §5.2.

### G8 — `automaton_image` regex false-positive in DocsSurface test

The metric-name regex matches the `automaton_image` Terraform
variable name. Allow-listed in `tests/DocsSurface.spec.ts:NOT_METRICS`.
If you add similar TF vars / config fields prefixed `automaton_*`,
extend the allow-list.

### G9 — Forgeton owner ForceSync also ghosts on low balance

Same V5R1 pattern as G4 but on the forgeton owner wallet during
admit/sync flows. The default fan-out send is 0.5 TON — if the
forgeton-owner wallet balance < 0.5 + reserve, the ForceSync
silently drops. Symptom: target consumer's `getOperator(automaton)`
returns null indefinitely. Fix: top up the forgeton-owner wallet
OR send the ForceSync with a lower value via manual override.

---

## Workstation setup commands (one-time, copy-paste)

```bash
# Snap docker socket (Ubuntu)
sudo chmod 666 /var/run/docker.sock

# buildx + qemu (one-time)
docker buildx create --name titon-builder --use --bootstrap
docker run --privileged --rm tonistiigi/binfmt --install all

# AWS auth — set AWS_PROFILE to whatever your credentials file is keyed by.
export AWS_PROFILE=<your-profile>
aws sts get-caller-identity   # → confirm the expected account before proceeding

# ECR login (re-run when token expires, ~12h)
aws ecr-public get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin public.ecr.aws

# npm auth (one-time per machine + when token expires)
npm login
npm whoami   # → confirms you're authenticated
```

---

## Rollback

If a release misbehaves in production:

1. **Roll back the terraform default image tag** to the previous
   working version in both region tfs.
2. `terraform apply` per region — replaces the instance back to the
   previous image.
3. **Do NOT** unpublish from npm — that breaks downstream pinning.
   Deprecate the bad version instead: `npm deprecate @titon-network/automaton@X.Y.Z "rolled back; use X.Y.{Z-1}"`.
4. Investigate + cut a `X.Y.{Z+1}` with the fix.

The ECR image stays — historical tags are useful for forensics.

---

## See also

- [`scripts/release.sh`](scripts/release.sh) — partial automation
  (version bump + tests + git tag); prints the manual steps it
  doesn't execute. **Dry-run by default**.
- [`CLAUDE.md`](CLAUDE.md) §"Distribution" — design rationale for
  the npm + docker + systemd surfaces.
- [`docs/ops.md`](docs/ops.md) §"Version upgrades" — the
  operator-side of a release (what they do on their box).
- The titon-network team's mainnet ops workspace (`automaton-mainnet/`)
  — per-region operator runbook + SSM Session Manager recipes for
  SSH-less debugging. Team-internal; not part of this public repo.
- [`../DEPLOY_CORE.md`](../DEPLOY_CORE.md) §5 — gotcha catalogue
  shared across the workspace (V5R1 ghost-tx, fan-out cursor, RPC
  flakiness).
