"""Generate Ansible inventory from Terraform output."""
import json
import subprocess
import sys
import os

def main():
    tf_dir = sys.argv[1] if len(sys.argv) > 1 else "../terraform"
    
    result = subprocess.run(
        ["terraform", "output", "-json"],
        capture_output=True, text=True,
        cwd=tf_dir,
        env={**os.environ}
    )
    if result.returncode != 0:
        print(f"Error: {result.stderr}", file=sys.stderr)
        sys.exit(1)

    tf = json.loads(result.stdout)

    node_pub = tf["node_public_ips"]["value"]
    node_priv = tf["node_private_ips"]["value"]
    web_pub = tf["web_public_ip"]["value"]

    # Build peer lists (each node peers with the others)
    def peers_for(idx):
        others = []
        for i, ip in enumerate(node_priv):
            if i != idx:
                others.append(f"https://{ip}:4001")
        return ",".join(others)

    # Build shared variables for all nodes
    shared_vars = []
    for i in range(len(node_priv)):
        shared_vars.append(f"    node{i+1}_priv: {node_priv[i]}")

    lines = ["all:", "  vars:"]
    lines.extend(shared_vars)
    lines.append("  children:")
    lines.append("    nodes:")
    lines.append("      hosts:")
    for i in range(len(node_pub)):
        nid = 3001 + i
        lines.append(f"        node{i+1}:")
        lines.append(f"          ansible_host: {node_pub[i]}")
        lines.append(f"          node_id: {nid}")
        lines.append(f"          private_ip: {node_priv[i]}")
        lines.append(f"          peers: \"{peers_for(i)}\"")
        lines.append(f"          allowed_origin: \"*\"")

    lines.append("    web:")
    lines.append("      hosts:")
    lines.append("        webserver:")
    lines.append(f"          ansible_host: {web_pub}")
    lines.append(f"          node1_ip: {node_priv[0]}")
    lines.append(f"          alb_dns: {tf['alb_dns']['value'].replace('http://', '')}")

    print("\n".join(lines))

if __name__ == "__main__":
    main()
