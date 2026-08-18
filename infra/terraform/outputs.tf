output "node_public_ips" {
  value = aws_instance.node[*].public_ip
}

output "node_private_ips" {
  value = aws_instance.node[*].private_ip
}

output "web_public_ip" {
  value = aws_instance.web.public_ip
}

output "web_private_ip" {
  value = aws_instance.web.private_ip
}

output "alb_dns" {
  description = "Internal HTTP entry (server-side + CloudFront origin)"
  value       = "http://${aws_lb.main.dns_name}"
}

output "chain_api_url" {
  description = "Blockchain API via ALB (HTTP, server-side use)"
  value       = "http://${aws_lb.main.dns_name}/chain-api"
}

output "cloudfront_url" {
  description = "Public HTTPS URL — use this in the mobile app and browser"
  value       = "https://${aws_cloudfront_distribution.main.domain_name}"
}

output "cloudfront_domain" {
  description = "CloudFront domain, no scheme (for CI and inventory)"
  value       = aws_cloudfront_distribution.main.domain_name
}

output "ssh_command_web" {
  value = "ssh -i zk-voting-key.pem ubuntu@${aws_instance.web.public_ip}"
}

output "ssh_command_node1" {
  value = "ssh -i zk-voting-key.pem ubuntu@${aws_instance.node[0].public_ip}"
}
