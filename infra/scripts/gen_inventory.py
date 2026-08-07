"""Generate Ansible inventory from Terraform output.

Topology (matches packages/blockchain replication design):
  node1  = PRIMARY (sequencer). PEERS = every other node's P2P URL.
  node2+ = REPLICA. Follow node1: pull blocks from its P2P port,
           forward writes to its RPC port.

Ports (must match systemd env + nginx + security groups):
  RPC = 3001  (JSON-RPC + /health, nginx proxies /chain-api here)
  P2P = 4001  (mTLS block replication between nodes)
"""
import json
import subprocess
import sys
import os

RPC_PORT = 3001
P2P_PORT = 4001


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

    primary_priv = node_priv[0]

    # Primary announces sealed blocks to every other node.
    primary_peers = ",".join(f"https://{ip}:{P2P_PORT}" for ip in node_priv[1:])

    # Comma-separated private IPs — the certs role builds SANs from this so the
    # shared cluster cert is valid for every node (including node4).
    node_priv_csv = ",".join(node_priv)

    lines = ["all:", "  vars:"]
    lines.append(f"    node1_priv: {primary_priv}")
    lines.append(f"    node_priv_csv: \"{node_priv_csv}\"")
    lines.append("  children:")
    lines.append("    nodes:")
    lines.append("      hosts:")
    for i in range(len(node_pub)):
        lines.append(f"        node{i + 1}:")
        lines.append(f"          ansible_host: {node_pub[i]}")
        lines.append(f"          private_ip: {node_priv[i]}")
        if i == 0:
            lines.append(f"          role: primary")
            lines.append(f"          peers: \"{primary_peers}\"")
        else:
            lines.append(f"          role: replica")
            lines.append(f"          primary_rpc_url: \"http://{primary_priv}:{RPC_PORT}\"")
            lines.append(f"          replica_pull_url: \"https://{primary_priv}:{P2P_PORT}\"")

    lines.append("    web:")
    lines.append("      hosts:")
    lines.append("        webserver:")
    lines.append(f"          ansible_host: {web_pub}")
    lines.append(f"          node1_ip: {primary_priv}")
    lines.append(f"          alb_dns: {tf['alb_dns']['value'].replace('http://', '')}")

    print("\n".join(lines))


if __name__ == "__main__":
    main()
