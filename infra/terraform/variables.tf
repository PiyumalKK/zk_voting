variable "aws_region" {
  default = "ap-south-1"
}

variable "project" {
  default = "zk-voting"
}

variable "key_name" {
  description = "EC2 key pair name (created in AWS Console)"
  default     = "zk-voting-key"
}

variable "node_count" {
  default = 4
}

variable "instance_type" {
  default = "t3.small"
}

variable "web_instance_type" {
  default = "t3.medium"
}

variable "domain" {
  description = "Domain for the app (optional — set after deploy)"
  default     = ""
}
