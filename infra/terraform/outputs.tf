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

output "ssh_command_web" {
  value = "ssh -i zk-voting-key.pem ubuntu@${aws_instance.web.public_ip}"
}

output "ssh_command_node1" {
  value = "ssh -i zk-voting-key.pem ubuntu@${aws_instance.node[0].public_ip}"
}
