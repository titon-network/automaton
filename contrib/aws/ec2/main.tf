# Titon automaton — EC2 deployment.
#
# Production-posture sibling to the Lightsail module. Recommended for
# mainnet positions where the encrypted keystore should NOT ride in
# Terraform state.
#
# Architectural difference vs the Lightsail module: keystore +
# password live in **SSM Parameter Store** (KMS-encrypted at rest,
# IAM-scoped), not in TF state. The instance assumes a per-instance
# IAM role with `ssm:GetParameter` scoped to a single base path; first
# boot fetches each parameter, decrypts via the role's KMS access,
# writes them to disk, and starts the daemon under systemd wrapping
# `docker run`.
#
# Multi-region: the module is region-agnostic — instantiate once per
# region with a provider alias or a per-region root module. Each
# region needs its own SSM parameters under its own path; SSM is
# regional and parameter values do NOT replicate cross-region by
# default.

data "aws_region" "current" {}

data "aws_partition" "current" {}

data "aws_caller_identity" "current" {}

# Subnet resolution. When the caller doesn't pass a subnet_id, fall
# back to the first public subnet of the account's default VPC —
# default VPC has IGW + auto-public-IP, which is what we want for an
# outbound-only daemon (no NAT gateway costs). The `data "aws_subnet"`
# read on the resolved id gives us the VPC the security group needs.
data "aws_vpc" "default" {
  count   = var.subnet_id == null ? 1 : 0
  default = true
}

data "aws_subnets" "default_public" {
  count = var.subnet_id == null ? 1 : 0

  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default[0].id]
  }

  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

data "aws_subnet" "resolved" {
  id = (
    var.subnet_id != null
    ? var.subnet_id
    : tolist(data.aws_subnets.default_public[0].ids)[0]
  )
}

# AL2023 AMI — minimal, dnf-based, multi-arch, regularly patched. The
# `al2023-ami-*` SSM parameter is what AWS itself recommends for
# always-current AL2023 lookups.
data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${var.architecture}"
}

locals {
  base_tags = merge(
    {
      Name    = var.name
      Module  = "titon-network/automaton/aws/ec2"
      Network = var.network
    },
    var.additional_tags,
  )

  # Resolved RPC endpoint. Same logic as the lightsail module —
  # toncenter public is the default per network, override via rpc_url
  # for production. Empty string if no api key (templatefile() can't
  # carry nulls cleanly).
  resolved_rpc_url = (
    var.rpc_url != null
    ? var.rpc_url
    : (var.network == "mainnet" ? "https://toncenter.com/api/v2/jsonRPC" : "https://testnet.toncenter.com/api/v2/jsonRPC")
  )
  rpc_api_key_or_empty = var.rpc_api_key != null ? var.rpc_api_key : ""

  # Render the secrets-fetch helper as its own template so the rpc_api_key
  # / rpc_url / etc. survive any character (the user-data heredoc would
  # otherwise risk shell-quoting hazards). Base64-encode the result and
  # embed in user-data — the bootstrap script `base64 -d`s it back to disk.
  state_dir      = "/var/lib/automaton"
  container_name = "titon-automaton"

  fetch_secrets_b64 = base64encode(templatefile("${path.module}/titon-fetch-secrets.sh.tftpl", {
    state_dir      = local.state_dir
    ssm_path       = var.ssm_path
    aws_region     = data.aws_region.current.name
    network        = var.network
    enable_fortuna = var.enable_fortuna
    rpc_url        = local.resolved_rpc_url
    rpc_api_key    = local.rpc_api_key_or_empty
  }))
}

# -----------------------------------------------------------------------------
# IAM — instance role
# -----------------------------------------------------------------------------
#
# Two policy components:
#   1. AWS-managed `AmazonSSMManagedInstanceCore` — Session Manager,
#      patch baseline, instance metadata. The "no SSH key" path.
#   2. Inline policy: `ssm:GetParameter` + `ssm:GetParameters` scoped
#      to var.ssm_path/* + KMS decrypt for the SSM-managed key.
#
# Scope ssm:GetParameter to the path prefix only — operator key for
# region A can't read region B's params even if mis-applied to the
# wrong instance.
data "aws_iam_policy_document" "instance_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = "${var.name}-instance-role"
  assume_role_policy = data.aws_iam_policy_document.instance_assume_role.json
  tags               = local.base_tags
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "secrets_read" {
  statement {
    sid    = "ReadAutomatonSecrets"
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${var.ssm_path}/*",
    ]
  }

  # SSM SecureString params encrypt with the AWS-managed `aws/ssm` KMS
  # key by default. The instance role needs Decrypt for that key OR the
  # operator's CMK if they're using one. We allow both with a condition
  # that scopes to ssm.<region>.amazonaws.com — KMS only honors decrypts
  # forwarded through SSM.
  statement {
    sid       = "DecryptSecretsViaSSM"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${data.aws_region.current.name}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "secrets_read" {
  name   = "${var.name}-secrets-read"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.secrets_read.json
}

resource "aws_iam_instance_profile" "this" {
  name = "${var.name}-instance-profile"
  role = aws_iam_role.this.name
  tags = local.base_tags
}

# -----------------------------------------------------------------------------
# Security group
# -----------------------------------------------------------------------------
#
# Egress: 443 only — toncenter, ghcr.io, ssm endpoint, AL2023 dnf
# mirrors all use HTTPS. DNS resolves via the VPC resolver (link-local,
# no SG rule needed). 9090 metrics stays loopback-only inside the VM.
#
# Ingress: only when var.allowed_ssh_cidrs is non-empty. SSM Session
# Manager doesn't need an open port — it dials out from the agent.
resource "aws_security_group" "this" {
  name        = "${var.name}-sg"
  description = "Titon automaton - outbound 443 only; SSH inbound iff allowed_ssh_cidrs is set."
  vpc_id      = data.aws_subnet.resolved.vpc_id
  tags        = local.base_tags
}

resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.this.id
  description       = "HTTPS - toncenter, ECR Public, ssm, dnf"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  for_each          = toset(var.allowed_ssh_cidrs)
  security_group_id = aws_security_group.this.id
  description       = "SSH from operator (consider SSM Session Manager instead)"
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

# Multi-op Fortuna peer share-exchange. Plain HTTP (BLS signatures are
# self-authenticating; TLS adds nothing to the trust model). Per-peer
# /32 rules on both ingress and egress; opening 0.0.0.0/0 would let any
# host on the internet POST to /fortuna/v1/share — the daemon would
# reject unknown senders, but defense-in-depth says don't even let them
# reach the listener.
resource "aws_vpc_security_group_ingress_rule" "fortuna_share" {
  for_each          = toset(var.peer_ips)
  security_group_id = aws_security_group.this.id
  description       = "Multi-op Fortuna peer share-exchange (inbound POSTs)"
  cidr_ipv4         = "${each.value}/32"
  ip_protocol       = "tcp"
  from_port         = 9091
  to_port           = 9091
}

resource "aws_vpc_security_group_egress_rule" "fortuna_share" {
  for_each          = toset(var.peer_ips)
  security_group_id = aws_security_group.this.id
  description       = "Multi-op Fortuna peer share-exchange (outbound POSTs)"
  cidr_ipv4         = "${each.value}/32"
  ip_protocol       = "tcp"
  from_port         = 9091
  to_port           = 9091
}

# Phoebe :9092 carries TWO routes:
#   - POST /phoebe/v1/share    — multi-op partial-signature exchange
#                                (auth-gated against config.phoebe.peers)
#   - GET  /phoebe/v1/snapshot — public read endpoint serving the latest
#                                published leaves so external dapps can
#                                build merkle proofs without running an
#                                operator. Self-verifying: consumers
#                                reconstruct the merkle root and compare
#                                against `phoebe.lastSnapshot.root` on-chain.
# Public ingress (0.0.0.0/0) for the GET; the POST stays sender-gated by
# the daemon's `knownPeers` check regardless of who can reach the port.
resource "aws_vpc_security_group_ingress_rule" "phoebe_public_read" {
  security_group_id = aws_security_group.this.id
  description       = "Phoebe public read endpoint (GET /phoebe/v1/snapshot)"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 9092
  to_port           = 9092
}

# Egress to peers for outbound POST /phoebe/v1/share (multi-op).
resource "aws_vpc_security_group_egress_rule" "phoebe_share" {
  for_each          = toset(var.peer_ips)
  security_group_id = aws_security_group.this.id
  description       = "Multi-op Phoebe peer share-exchange (outbound POSTs)"
  cidr_ipv4         = "${each.value}/32"
  ip_protocol       = "tcp"
  from_port         = 9092
  to_port           = 9092
}

# -----------------------------------------------------------------------------
# EC2 instance
# -----------------------------------------------------------------------------
#
# IMDSv2-only (`http_tokens = required`) — the SDK call chain inside
# user-data already handles the v2 token dance, and disabling v1 closes
# the SSRF-to-creds escalation path. metadata-options is not optional
# for new builds.
resource "aws_instance" "this" {
  # `insecure_value` (vs `value`) returns the AMI ID as a non-sensitive
  # string so `terraform plan` displays it instead of "(sensitive)".
  # Safe — AMI IDs are public.
  ami                         = data.aws_ssm_parameter.al2023_ami.insecure_value
  instance_type               = var.instance_type
  iam_instance_profile        = aws_iam_instance_profile.this.name
  vpc_security_group_ids      = [aws_security_group.this.id]
  subnet_id                   = data.aws_subnet.resolved.id
  associate_public_ip_address = true

  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.volume_size_gb
    encrypted             = true
    kms_key_id            = var.kms_key_id
    delete_on_termination = true
    tags                  = local.base_tags
  }

  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    automaton_image   = var.automaton_image
    container_name    = local.container_name
    state_dir         = local.state_dir
    fetch_secrets_b64 = local.fetch_secrets_b64
  })

  tags = local.base_tags
}

# -----------------------------------------------------------------------------
# Optional EIP — stable public IP across reboots / replacements.
# -----------------------------------------------------------------------------
resource "aws_eip" "this" {
  count    = var.assign_eip ? 1 : 0
  domain   = "vpc"
  instance = aws_instance.this.id
  tags     = local.base_tags
}
