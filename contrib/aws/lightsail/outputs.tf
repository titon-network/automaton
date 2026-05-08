output "instance_name" {
  description = "Lightsail instance name."
  value       = aws_lightsail_instance.this.name
}

output "public_ip" {
  description = "Stable public IP (Lightsail static IP)."
  value       = aws_lightsail_static_ip.this.ip_address
}

output "ssh_command" {
  description = "Shell command to SSH in via the operator's local key (download from the AWS Lightsail console: Account → SSH keys). For zero-setup, use the browser-based SSH from the Lightsail console — no key or firewall opening required."
  value       = "ssh ubuntu@${aws_lightsail_static_ip.this.ip_address}"
}

output "bootstrap_log_command" {
  description = "Read the user-data bootstrap log over SSH (debug a failed first boot)."
  value       = "ssh ubuntu@${aws_lightsail_static_ip.this.ip_address} 'sudo tail -200 /var/log/titon-automaton-bootstrap.log'"
}

output "fortuna_register_command" {
  description = <<EOT
    When `bls_keystore_file` is set, registering the BLS pkShare at Atlas
    is operator-driven and runs AFTER the wallet is active in ForgeTON.
    Empty string when Fortuna is disabled.
  EOT
  value = (
    var.bls_keystore_file != null
    ? "ssh ubuntu@${aws_lightsail_static_ip.this.ip_address} sudo automaton bls register"
    : ""
  )
}
