# Titon automaton — Lightsail deployment.
#
# Lightsail is AWS's simplified VPS — single-resource instance, built-in
# firewall, included disk, optional static IP. Cheaper and quicker to
# stand up than the EC2 module (~$3.50–$5/month vs ~$8 all-in), at the
# cost of less customisation and no IAM instance profile.
#
# Architectural difference vs the EC2 module: Lightsail can't read from
# Secrets Manager via instance role, so we bootstrap with keystore-mode
# instead — the wallet.enc is read from the operator's local disk at
# apply time and embedded in user-data. The mnemonic stays on paper,
# off AWS entirely.

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  az = var.availability_zone != null ? var.availability_zone : data.aws_availability_zones.available.names[0]

  base_tags = merge(
    {
      Name      = var.name
      ManagedBy = "terraform"
      Module    = "titon-network/automaton/aws/lightsail"
      Network   = var.network
    },
    var.additional_tags,
  )

  # base64-embed both secrets so they survive templatefile() and shell
  # interpolation cleanly — the keystore is JSON-with-binary-ciphertext,
  # and a password with `"` / `$` / backticks would break a raw heredoc.
  # The bootstrap script `base64 -d`s them back into their natural form.
  wallet_keystore_b64   = base64encode(file(var.wallet_keystore_file))
  keystore_password_b64 = base64encode(var.keystore_password)

  # Fortuna is enabled iff the operator passed a BLS keystore. One knob,
  # no separate flag — matches the "set the file → get the feature" shape
  # of `wallet_keystore_file`. Empty-string sentinel for the disabled case
  # so templatefile() doesn't have to handle nulls.
  enable_fortuna   = var.bls_keystore_file != null
  bls_keystore_b64 = var.bls_keystore_file != null ? base64encode(file(var.bls_keystore_file)) : ""

  # RPC endpoint. Default = the network's public toncenter URL (free tier,
  # rate-limited ~1 req/s) when the operator didn't pick one. The variable
  # paths through user-data into config.endpoints[0] verbatim.
  #
  # NOTE — the URLs below are duplicated from
  # `src/config/schema.ts:DEFAULT_ENDPOINTS` (canonical source for the CLI).
  # Terraform can't import the TS module so we restate them here. If the
  # canonical defaults ever change, update both. They're both stable
  # toncenter URLs the upstream project owns; change-frequency is "almost
  # never" in practice.
  resolved_rpc_url = (
    var.rpc_url != null
    ? var.rpc_url
    : (var.network == "mainnet" ? "https://toncenter.com/api/v2/jsonRPC" : "https://testnet.toncenter.com/api/v2/jsonRPC")
  )
  # Empty-string sentinel — null doesn't survive templatefile() cleanly.
  rpc_api_key_or_empty = var.rpc_api_key != null ? var.rpc_api_key : ""
}

resource "aws_lightsail_instance" "this" {
  name              = var.name
  availability_zone = local.az
  blueprint_id      = "ubuntu_22_04"
  bundle_id         = var.bundle_id

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    network               = var.network
    automaton_version     = var.automaton_version
    wallet_keystore_b64   = local.wallet_keystore_b64
    keystore_password_b64 = local.keystore_password_b64
    rpc_url               = local.resolved_rpc_url
    rpc_api_key           = local.rpc_api_key_or_empty
    enable_fortuna        = local.enable_fortuna
    bls_keystore_b64      = local.bls_keystore_b64
  })

  tags = local.base_tags
}

# Inbound firewall. Lightsail's default-from-blueprint firewall opens 22
# to the world; defining `aws_lightsail_instance_public_ports` REPLACES
# that with our explicit set. The provider requires ≥1 port_info block
# per resource, so we gate the whole resource on `allowed_ssh_cidrs`
# being non-empty. Trade-off:
#   - Empty list  → resource not created, blueprint default stands
#                   (port 22 OPEN to 0.0.0.0/0); use Lightsail browser
#                   SSH from the AWS console for ops.
#   - Non-empty   → port 22 restricted to the listed CIDRs only.
# For tighter posture, set `allowed_ssh_cidrs = ["<your-ip>/32"]`.
resource "aws_lightsail_instance_public_ports" "this" {
  count         = length(var.allowed_ssh_cidrs) > 0 ? 1 : 0
  instance_name = aws_lightsail_instance.this.name

  port_info {
    protocol  = "tcp"
    from_port = 22
    to_port   = 22
    cidrs     = var.allowed_ssh_cidrs
  }
}

# Stable public IP. Free while attached.
resource "aws_lightsail_static_ip" "this" {
  name = "${var.name}-static-ip"
}

resource "aws_lightsail_static_ip_attachment" "this" {
  static_ip_name = aws_lightsail_static_ip.this.name
  instance_name  = aws_lightsail_instance.this.name

  # When the instance is replaced (e.g. user_data change forces
  # replacement), AWS detaches the static IP as a side effect of the
  # destroy. Without this trigger, terraform's view of the attachment
  # stays "attached" and the next plan reports no diff — so the new
  # instance comes up with an auto-assigned ephemeral IP and the static
  # IP sits orphaned. `replace_triggered_by` forces this attachment to
  # be re-created whenever the instance is, restoring the static IP.
  lifecycle {
    replace_triggered_by = [aws_lightsail_instance.this.id]
  }
}
