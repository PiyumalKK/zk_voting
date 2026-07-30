.PHONY: init plan apply inventory deploy destroy status

## Full deploy: infra + app
all: apply inventory deploy

## Terraform
init:
	cd terraform && terraform init

plan:
	cd terraform && terraform plan

apply:
	cd terraform && terraform apply -auto-approve

## Generate Ansible inventory from Terraform
inventory:
	cd terraform && python ../scripts/gen_inventory.py . > ../ansible/inventory.yml

## Run Ansible
deploy:
	cd ansible && ansible-playbook playbook.yml

## Destroy all AWS resources
destroy:
	cd terraform && terraform destroy -auto-approve

## Check health of all nodes
status:
	@cd terraform && for ip in $$(terraform output -json node_public_ips | python -c "import sys,json;[print(x) for x in json.load(sys.stdin)]"); do \
		echo "$$ip: $$(curl -sf http://$$ip:3001/health || echo DOWN)"; \
	done
