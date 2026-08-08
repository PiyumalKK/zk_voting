# AWS Deployment Steps

> **Switching the blockchain nodes to BFT consensus?** That is a one-time
> rollout with its own prerequisites (four validator keys, four new secrets)
> and two things that will trip you up — the servers clone `Piyumal` rather
> than your branch, and deploying the nodes wipes the chain. Follow
> [`DEPLOY-BFT.md`](DEPLOY-BFT.md) instead of this file.

## Prerequisites

1. **AWS Setup:**
   - Create S3 bucket: `zk-voting-tfstate` (ap-south-1)
   - Create DynamoDB table: `zk-voting-tflock` (ap-south-1)
   - Create EC2 key pair: `zk-voting-key` (download .pem file)

2. **GitHub Secrets Required:**
   ```
   AWS_ACCESS_KEY_ID=<your-aws-access-key>
   AWS_SECRET_ACCESS_KEY=<your-aws-secret-key>
   EC2_SSH_PRIVATE_KEY=<content-of-zk-voting-key.pem>
   EXPO_TOKEN=<expo-access-token-for-building-mobile-app>
   ```
   
   **Get EXPO_TOKEN:**
   ```bash
   npx eas login
   npx eas whoami
   # Go to expo.dev → Account Settings → Access Tokens → Create Token
   ```

3. **Ansible Variables (add to infra/ansible/group_vars/all.yml):**
   ```yaml
   session_secret: "rRMfEsrP1JONk9hTkt92qbYIsN7lU8bIlTKBmQU7xEs="
   admin_password_hash: "\\$2b\\$12\\$CtGZgokkPVopzWbR4enIBOYp2H1aFq099XjbHsgN8fd8X7wHFj2UG"
   admin_relay_private_key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
   gn_key_encryption_key: "72395a28dcfa7a922f3585a6daa4392eca5cc55f12c14fc8ab51ffcebf5f4fc9"
   server_pepper: "9b4e7a1f3c8d6e2a5f0b9c7d4e1a8f6c3b5d2e9a7f1c8b4d6e0a3f9c2b7d5e8a1f4c6d9e2b8a0f7c3d5e1a9b6c4d8f2"
   ```

---

## Deployment Steps

### **Step 1: Deploy Infrastructure (Terraform)**

Run GitHub Action: **Infrastructure** workflow
- This creates: 4 EC2 nodes + 1 web server + VPC + ALB + security groups
- Takes ~5 minutes
- Outputs: ALB DNS, EC2 IPs

**OR locally:**
```bash
cd infra/terraform
terraform init
terraform apply -auto-approve
terraform output
```

---

### **Step 2: Deploy Application (Ansible)**

Run GitHub Action: **Deploy Application** workflow
- Deploys blockchain nodes (with P2P consensus)
- Deploys contracts to blockchain
- Deploys Next.js web app
- Takes ~15 minutes

**OR locally:**
```bash
cd infra
make inventory  # Generate from terraform outputs
make deploy     # Run ansible
```

---

### **Step 3: Verify Deployment**

1. **Check ALB URL:**
   ```bash
   curl http://zk-voting-alb-XXXXX.ap-south-1.elb.amazonaws.com
   ```

2. **Check Blockchain Nodes:**
   ```bash
   curl http://NODE_IP:3001/health
   ```

3. **Access Web App:**
   - Go to ALB URL in browser
   - Login: admin / admin123
   - Create GN officers
   - Test full election flow

---

## Mobile App Configuration

**AUTOMATIC:** The APK build pipeline now pulls ALB URL from Terraform automatically!

### Build Production APK

Run GitHub Action: **Build Mobile APK** workflow
- Automatically fetches ALB DNS from Terraform
- Creates `.env` with production URLs
- Builds APK with correct backend configuration
- Takes ~10-15 minutes

**OR manually:**
```bash
# Get ALB URL from Terraform
cd infra/terraform
ALB_DNS=$(terraform output -raw alb_dns | sed 's|http://||')

# Create .env
cat > packages/mobile/.env << EOF
EXPO_PUBLIC_API_URL=http://$ALB_DNS
EXPO_PUBLIC_RPC_URL=http://$ALB_DNS/chain-api
EXPO_PUBLIC_CHAIN_ID=9494
EOF

# Build with EAS
cd packages/mobile
npx eas build --platform android --profile preview
```

**Download APK:**
- Go to expo.dev/accounts/YOUR_ACCOUNT/projects/sl-vote/builds
- Download the APK and install on phone

---

## Troubleshooting

**Nodes not syncing?**
- Check mTLS certs: `ssh ubuntu@NODE_IP "ls -la /opt/zk-voting/packages/blockchain/data_3001/certs/"`
- Check systemd logs: `journalctl -u zk-node -f`

**Web app 502?**
- Check PM2: `ssh ubuntu@WEB_IP "pm2 status"`
- Check nginx: `ssh ubuntu@WEB_IP "sudo systemctl status nginx"`

**Contract deployment failed?**
- Blockchain node must be running FIRST
- Check hardhat config points to correct RPC
- Manually redeploy: `ssh ubuntu@WEB_IP "cd /opt/zk-voting/packages/hardhat && yarn deploy --network custom --reset"`

---

## Destroy Everything

```bash
cd infra/terraform
terraform destroy -auto-approve
```

**OR** GitHub Action: Infrastructure → Destroy job
