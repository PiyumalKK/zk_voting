data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }
}

# --- VPC ---
resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  tags                 = { Name = "${var.project}-vpc" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "${var.aws_region}a"
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.project}-subnet-a" }
}

resource "aws_subnet" "public_b" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.2.0/24"
  availability_zone       = "${var.aws_region}b"
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.project}-subnet-b" }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.project}-igw" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_b" {
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public.id
}

# --- Security Groups ---
resource "aws_security_group" "nodes" {
  name   = "${var.project}-nodes"
  vpc_id = aws_vpc.main.id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "Public API"
    from_port   = 3001
    to_port     = 3004
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "P2P between nodes"
    from_port   = 4001
    to_port     = 4004
    protocol    = "tcp"
    self        = true
  }

  ingress {
    description = "Web app"
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project}-sg" }
}

# --- EC2: 4 Blockchain Nodes ---
resource "aws_instance" "node" {
  count                  = var.node_count
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  key_name               = var.key_name
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.nodes.id]

  root_block_device {
    volume_size = 15
    volume_type = "gp3"
  }

  tags = {
    Name   = "${var.project}-node-${count.index + 1}"
    Role   = "blockchain"
    NodeID = tostring(3001 + count.index)
  }
}

# --- EC2: 1 Web Server ---
resource "aws_instance" "web" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  key_name               = var.key_name
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.nodes.id]

  root_block_device {
    volume_size = 15
    volume_type = "gp3"
  }

  tags = {
    Name = "${var.project}-web"
    Role = "web"
  }
}

# ═══════════════════════════════════════════════════════
# ALB — Application Load Balancer (HTTPS entry point)
# ═══════════════════════════════════════════════════════

resource "aws_lb" "main" {
  name               = "${var.project}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.nodes.id]
  subnets            = [aws_subnet.public.id, aws_subnet.public_b.id]
  tags               = { Name = "${var.project}-alb" }
}

# Target Group: Blockchain API (nodes on :3001)
resource "aws_lb_target_group" "chain" {
  name     = "${var.project}-chain-tg"
  port     = 3001
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
  }
}

# Target Group: Web App (web server on :3000)
resource "aws_lb_target_group" "web" {
  name     = "${var.project}-web-tg"
  port     = 3000
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id

  health_check {
    path                = "/"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
  }
}

# Register 4 nodes to chain target group
resource "aws_lb_target_group_attachment" "nodes" {
  count            = var.node_count
  target_group_arn = aws_lb_target_group.chain.arn
  target_id        = aws_instance.node[count.index].id
  port             = 3001
}

# Register web server to web target group
resource "aws_lb_target_group_attachment" "web" {
  target_group_arn = aws_lb_target_group.web.arn
  target_id        = aws_instance.web.id
  port             = 3000
}

# HTTP Listener (port 80) — default routes to web app
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

# Rule: /chain-api/* → blockchain nodes
resource "aws_lb_listener_rule" "chain_api" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.chain.arn
  }

  condition {
    path_pattern { values = ["/chain-api/*"] }
  }
}

# ═══════════════════════════════════════════════════════
# CloudWatch — Monitoring & Alarms
# ═══════════════════════════════════════════════════════

resource "aws_cloudwatch_log_group" "nodes" {
  name              = "/zk-voting/nodes"
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/zk-voting/web"
  retention_in_days = 7
}

# CPU alarm: alert if any node goes above 80%
resource "aws_cloudwatch_metric_alarm" "node_cpu" {
  count               = var.node_count
  alarm_name          = "${var.project}-node${count.index + 1}-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Node ${count.index + 1} CPU above 80%"

  dimensions = {
    InstanceId = aws_instance.node[count.index].id
  }
}

# ALB healthy host count alarm
resource "aws_cloudwatch_metric_alarm" "healthy_nodes" {
  alarm_name          = "${var.project}-unhealthy-nodes"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Minimum"
  threshold           = 3
  alarm_description   = "Fewer than 3 healthy blockchain nodes"

  dimensions = {
    TargetGroup  = aws_lb_target_group.chain.arn_suffix
    LoadBalancer = aws_lb.main.arn_suffix
  }
}
