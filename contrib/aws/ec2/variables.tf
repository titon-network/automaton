# Required: where this instance reads its secrets from.
#
# This module uses SSM-mode bootstrap. The operator uploads four
# parameters under a base path BEFORE `terraform apply`:
#
#   ${ssm_path}/wallet.enc      SecureString  (base64 of the encrypted keystore)
#   ${ssm_path}/config.json     String        (the daemon's config JSON)
#   ${ssm_path}/password        SecureString  (the keystore password)
#   ${ssm_path}/bls.enc         SecureString  (optional — only when enable_fortuna)
#
# At first boot the EC2 instance assumes its IAM role, fetches each
# parameter via `aws ssm get-parameter --with-decryption`, and writes
# them to disk under /var/lib/automaton (mode 0600, owned by UID 65532
# — the `nonroot` user inside the daemon's distroless container). The
# mnemonic NEVER enters AWS — operator generates the wallet locally,
# encrypts it, uploads only the ciphertext.
#
# Trade-offs vs the Lightsail module's keystore-in-state pattern:
#   + No secrets in Terraform state. State holds only the SSM PATH, not values.
#   + Rotate by `aws ssm put-parameter --overwrite`; restart the systemd
#     unit; no terraform-apply needed for cred rotation.
#   + IAM-scoped: only this instance's role can read this path.
#   - Slightly more setup (one ssm:put-parameter per secret per region).
#   - Costs $0/month for the standard SSM tier (≤4KB per param, ≤10K
#     parameters per account per region — we use 3-4 params per instance).

variable "ssm_path" {
  description = <<EOT
    Base SSM Parameter Store path under which this instance's secrets live.
    Example: "/titon/automaton/eu-central-1". The instance's IAM role is
    scoped to read parameters under this prefix only — multiple instances
    in the same region MUST use distinct paths so a key compromise on
    one doesn't grant access to another.
  EOT
  type        = string

  validation {
    condition     = can(regex("^/[A-Za-z0-9][A-Za-z0-9_.\\-/]+$", var.ssm_path)) && !can(regex("/$", var.ssm_path))
    error_message = "ssm_path must start with '/', use only [A-Za-z0-9_.-/], and must not end with '/'."
  }
}

variable "name" {
  description = "Resource name prefix. Used for the EC2 Name tag, IAM role, security group, and the systemd / docker container name."
  type        = string
  default     = "titon-automaton"
}

variable "network" {
  description = "TON network: testnet | mainnet. Default = mainnet — the EC2 module is the recommended path for mainnet positions."
  type        = string
  default     = "mainnet"

  validation {
    condition     = contains(["testnet", "mainnet"], var.network)
    error_message = "network must be one of: testnet, mainnet."
  }
}

variable "instance_type" {
  description = "EC2 instance type. Default t4g.small (2 vCPU, 2 GB RAM, ARM64) fits Kronos + Fortuna with headroom. See README §Sizing for alternatives."
  type        = string
  default     = "t4g.small"
}

variable "architecture" {
  description = "CPU architecture: arm64 | x86_64. Switch in lockstep with instance_type if you change CPU family — used for the AL2023 AMI lookup."
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["arm64", "x86_64"], var.architecture)
    error_message = "architecture must be one of: arm64, x86_64."
  }
}

variable "automaton_image" {
  description = "Docker image reference for the daemon. Pinned for reproducible deploys; bump + terraform apply replaces the instance cleanly. Multi-arch — works on arm64 and x86_64. Default is the team's ECR Public image; the auto-generated alias `b0k9s4w3` will migrate to `titon-network` once AWS approves the vanity claim."
  type        = string
  default     = "public.ecr.aws/b0k9s4w3/automaton:0.7.0"
}

variable "enable_fortuna" {
  description = "When true, fetch ${"$"}{ssm_path}/bls.enc and flip products.fortuna in the daemon config. Upload bls.enc to SSM before applying. Atlas registration of the pkShare is operator-driven post-apply via `automaton bls register`."
  type        = bool
  default     = false
}

variable "rpc_url" {
  description = "TON RPC endpoint URL. null (default) = public toncenter, rate-limited; override with a paid endpoint for production mainnet."
  type        = string
  default     = null
}

variable "rpc_api_key" {
  description = "API key for rpc_url, when required. For maximum stricture, instead leave null + upload an api-keyed config.json to ${"$"}{ssm_path}/config.json (avoids the key landing in user-data)."
  type        = string
  default     = null
  sensitive   = true
}

variable "volume_size_gb" {
  description = "Root EBS volume size in GiB. 8 fits the daemon + image + a week of logs."
  type        = number
  default     = 8

  validation {
    condition     = var.volume_size_gb >= 8 && var.volume_size_gb <= 256
    error_message = "volume_size_gb must be between 8 and 256."
  }
}

variable "kms_key_id" {
  description = "KMS key for root EBS encryption. null = AWS-managed aws/ebs key (free)."
  type        = string
  default     = null
}

variable "assign_eip" {
  description = "Allocate + attach an Elastic IP for a stable public address. Free while attached."
  type        = bool
  default     = true
}

variable "allowed_ssh_cidrs" {
  description = "CIDRs allowed inbound on TCP/22. Default empty = no inbound; use SSM Session Manager (`aws ssm start-session --target <instance-id>`) for shell access."
  type        = list(string)
  default     = []
}

variable "peer_ips" {
  description = <<EOT
    Multi-op Fortuna peer IPs (each is the EIP of another operator in the
    same threshold-BLS group). When non-empty:
      - Ingress on TCP/9091 (share-exchange POSTs) opens to each /32.
      - Egress on TCP/9091 opens to each /32 so the daemon can post
        shares to peers.
    Default empty = solo-mode (no peer traffic). The matching daemon
    config is `config.fortuna.peers`; the two must agree (every IP here
    must correspond to a `config.fortuna.peers[].endpoint`).
  EOT
  type        = list(string)
  default     = []
}

variable "subnet_id" {
  description = "Subnet to launch into. null = first public subnet of the account's default VPC. Must be a public subnet (daemon needs outbound IGW). The VPC is derived from this subnet — no separate vpc_id input."
  type        = string
  default     = null
}

variable "additional_tags" {
  description = "Extra tags merged into every taggable resource."
  type        = map(string)
  default     = {}
}
