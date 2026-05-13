# Required: pre-initialised wallet artifacts.
#
# This module uses keystore-mode bootstrap — the operator runs
# `automaton init` locally first, then passes the encrypted keystore +
# password to this module. The mnemonic NEVER enters AWS.
#
#   automaton init --network testnet
#   # Now ~/.titon/automaton/wallet.enc exists.
#   terraform apply \
#     -var "wallet_keystore_file=$HOME/.titon/automaton/wallet.enc" \
#     -var "keystore_password=$YOUR_PASSWORD"
#
# Trade-off: both values land in Terraform state. Encrypt your state.
# (S3 backend with KMS is the standard answer.)

variable "wallet_keystore_file" {
  description = "Path on the local machine to the `wallet.enc` produced by `automaton init`. Read at apply time and base64-embedded in user-data."
  type        = string
}

variable "keystore_password" {
  description = "Keystore password (≥ 8 chars). Stored in TF state — encrypt your backend."
  type        = string
  sensitive   = true
}

variable "bls_keystore_file" {
  description = <<EOT
    Path on the local machine to `bls.enc` (BLS12-381 secret keystore for
    Fortuna VRF and/or Themis reveals — one keystore covers both).
    When set, the module enables `products.fortuna` in the daemon config
    and embeds the keystore in user-data alongside `wallet.enc`. When
    `null` (the default), the daemon runs Kronos-only — same as before.

    Setting `themis_chambers` (below) ALSO requires `bls_keystore_file`
    — the same Atlas group secret signs both Fortuna fulfillments and
    Themis reveals.

    The BLS keystore today shares the wallet password (v1 same-password
    model — see `CLAUDE.md` §"BLS identity is decoupled"). Generate it
    locally with `automaton bls keygen`. Sizing note: enabling Fortuna
    bumps the working set; bundle_id="micro_3_0" is recommended over the
    "nano_3_0" default.

    Atlas registration of the pkShare is operator-driven (NOT run by
    bootstrap): after `terraform apply` and once the wallet is active in
    ForgeTON, run `sudo automaton bls register` on the instance. Until
    then, the FortunaWorker initialises but stays idle (no group
    membership at Atlas → no fulfillments routed). Themis uses the
    SAME pkShare registration — `bls register` once covers both products.
  EOT
  type        = string
  default     = null
}

variable "themis_chambers" {
  description = <<EOT
    List of Themis chamber addresses this operator should serve, in
    UQ-form (e.g. `["EQ…", "EQ…"]`). When non-empty, the daemon enables
    `products.themis` and writes the list under `themis.chambers` in
    config.json — the ThemisWorker tracks each chamber's round + bid
    state, threshold-decrypts cached bids when the commit window closes,
    and submits `RevealRound` before the reveal deadline.

    Themis additionally requires `bls_keystore_file` (same key as
    Fortuna — Atlas group secret signs both `FulfillRandomness` and
    `RevealRound`). Empty list (default `[]`) leaves themis disabled
    AND zero overhead — the worker only boots when at least one chamber
    is configured.

    Auto-discovery from the factory's `EvtChamberDeployed` events is a
    v1.1 follow-up; v1 keeps the surface explicit so the operator
    knows which chambers they're earning fees + bearing reveal
    liability for. To find chamber addresses: query the Themis factory's
    events or check the consumer protocol's docs.

    Pre-launch / sovereign-deployment overrides for the factory itself
    aren't exposed here yet — the canary uses the SDK-pinned
    `THEMIS_TESTNET.factory`. Add `themis_factory_address` /
    `themis_atlas_address` knobs when sovereign deployments need the
    Lightsail module too.
  EOT
  type        = list(string)
  default     = []
}

variable "network" {
  description = "TON network: testnet | mainnet."
  type        = string
  default     = "testnet"

  validation {
    condition     = contains(["testnet", "mainnet"], var.network)
    error_message = "network must be one of: testnet, mainnet."
  }
}

variable "bundle_id" {
  description = <<EOT
    Lightsail instance size. nano_3_0 ($3.50/mo, 512 MB RAM) is the
    cheapest viable; micro_3_0 ($5/mo, 1 GB) is comfortable headroom.
    The daemon needs ~256 MB; nano works for testnet, micro recommended
    for mainnet.
  EOT
  type        = string
  default     = "nano_3_0"
}

variable "allowed_ssh_cidrs" {
  description = "CIDR blocks allowed inbound SSH. Default `[]` = all inbound closed; the AWS console's browser-based SSH still works because it routes through Lightsail's mgmt plane, not your firewall. Add `[\"1.2.3.4/32\"]` to enable plain SSH from a specific IP."
  type        = list(string)
  default     = []
}

variable "automaton_version" {
  description = <<EOT
    npm semver range for `@titon-network/automaton`. Default is "latest";
    pin to an exact version (e.g. "0.3.1") for reproducible deploys, or
    a caret range (e.g. "^0.3.0") to follow patches. The bootstrap runs
    `npm install -g @titon-network/automaton@$${automaton_version}`.
  EOT
  type        = string
  default     = "latest"
}

variable "rpc_url" {
  description = <<EOT
    TON RPC endpoint URL the daemon talks to. `null` (default) selects the
    public toncenter endpoint for the chosen network — fine for testnet
    smoke, but rate-limited (~1 req/s) and shared with the rest of the
    public; the daemon's normal poll fan-out blows past that limit. For
    anything beyond a one-off canary, override with your own endpoint:
      - toncenter pro:    https://toncenter.com/api/v2/jsonRPC + rpc_api_key
      - dton.io / TONApi: their JSON-RPC URL
      - self-hosted:      e.g. http://10.0.0.5:8081/api/v2/jsonRPC
    The mainnet/testnet endpoint must match `var.network`.
  EOT
  type        = string
  default     = null
}

variable "rpc_api_key" {
  description = <<EOT
    API key for the RPC endpoint (sent as `?api_key=...` per toncenter
    convention). Required only when your endpoint demands auth — toncenter
    pro plans, paid third-party providers. Lands in TF state alongside the
    keystore password — encrypt your backend.
  EOT
  type        = string
  default     = null
  sensitive   = true
}

variable "name" {
  description = "Resource name prefix + Lightsail instance name."
  type        = string
  default     = "titon-automaton"
}

variable "availability_zone" {
  description = "Availability Zone in the provider's region. null = first AZ of the region."
  type        = string
  default     = null
}

variable "additional_tags" {
  description = "Extra tags merged into every taggable resource."
  type        = map(string)
  default     = {}
}
