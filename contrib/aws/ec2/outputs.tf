output "instance_id" {
  description = "EC2 instance ID — use as the target for `aws ssm start-session` to get a shell without SSH."
  value       = aws_instance.this.id
}

output "instance_arn" {
  description = "EC2 instance ARN."
  value       = aws_instance.this.arn
}

output "iam_role_arn" {
  description = "ARN of the per-instance IAM role. Useful for cross-account audit, or for adding extra inline policies (e.g. CloudWatch Logs)."
  value       = aws_iam_role.this.arn
}

output "iam_role_name" {
  description = "Name of the per-instance IAM role."
  value       = aws_iam_role.this.name
}

output "public_ip" {
  description = "Public IPv4 (Elastic IP when assign_eip = true; otherwise the auto-assigned address — note that auto-assigned addresses change on stop/start)."
  value       = var.assign_eip ? aws_eip.this[0].public_ip : aws_instance.this.public_ip
}

output "private_ip" {
  description = "Private IPv4 within the VPC."
  value       = aws_instance.this.private_ip
}

output "ssm_path" {
  description = "SSM Parameter Store base path the instance reads its secrets from. Echo'd back so the operator can confirm what they uploaded matches."
  value       = var.ssm_path
}

output "ssm_session_command" {
  description = "Get an interactive shell on the instance without opening any inbound port. Requires the operator's local AWS CLI to have `ssm:StartSession` on this instance."
  value       = "aws ssm start-session --target ${aws_instance.this.id} --region ${data.aws_region.current.name}"
}

output "ssh_command" {
  description = "SSH command — only works if you've populated `allowed_ssh_cidrs` AND attached an EC2 Instance Connect / key pair via the AWS console. Empty string otherwise."
  value = (
    length(var.allowed_ssh_cidrs) > 0
    ? "ssh ec2-user@${var.assign_eip ? aws_eip.this[0].public_ip : aws_instance.this.public_ip}"
    : ""
  )
}

output "bootstrap_log_command" {
  description = "Tail the user-data bootstrap log over SSM Session Manager — debug a failed first boot."
  value       = "aws ssm start-session --target ${aws_instance.this.id} --region ${data.aws_region.current.name} --document-name AWS-StartInteractiveCommand --parameters command='sudo tail -200 /var/log/titon-automaton-bootstrap.log'"
}

output "fortuna_register_command" {
  description = "When enable_fortuna = true, the one-time SSM command to register the BLS pkShare at Atlas (operator-driven, after the wallet is ForgeTON-active). Empty string when Fortuna is disabled."
  value = (
    var.enable_fortuna
    ? "aws ssm start-session --target ${aws_instance.this.id} --region ${data.aws_region.current.name} --document-name AWS-StartInteractiveCommand --parameters command='sudo /usr/local/bin/automaton bls register'"
    : ""
  )
}
