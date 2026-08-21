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
  description = "Public URL of the application (use this to access)"
  value       = "http://${aws_lb.main.dns_name}"
}

output "chain_api_url" {
  description = "Blockchain API via ALB"
  value       = "http://${aws_lb.main.dns_name}/chain-api"
}

output "ssh_command_web" {
  value = "ssh -i zk-voting-key.pem ubuntu@${aws_instance.web.public_ip}"
}

output "ssh_command_node1" {
  value = "ssh -i zk-voting-key.pem ubuntu@${aws_instance.node[0].public_ip}"
}
