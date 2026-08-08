terraform {
  required_version = ">= 1.5"

  backend "s3" {
    bucket         = "zk-voting-tfstate"
    key            = "infra/terraform.tfstate"
    region         = "ap-south-1"
    dynamodb_table = "zk-voting-tflock"
    encrypt        = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
