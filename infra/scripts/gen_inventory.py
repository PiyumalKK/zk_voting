"""Generate Ansible inventory from Terraform output.

Topology — BFT consensus (CONSENSUS_MODE=bft, the default here):
  Every node is a co-equal VALIDATOR. Each one can propose blocks, each one
  votes, and a block is final only once a quorum (ceil(2N/3) = 3 of 4) has
  signed a COMMIT for it. The election survives losing any one validator,
  including the authority, and halts rather than weakening if it loses two.

  Every validator therefore needs to reach every other validator, so each host
  gets its own CONSENSUS_PEERS list — unlike the solo topology below, where
  only node1 got a peer list.

Topology — solo (CONSENSUS_MODE=solo, set CONSENSUS_MODE=solo to fall back):
  node1  = PRIMARY (sequencer). PEERS = every other node's P2P URL.
  node2+ = REPLICA. Follow node1: pull blocks from its P2P port,
           forward writes to its RPC port.

  This is the pre-consensus arrangement, kept as an instant revert path: one
  variable puts the cluster back on the single-sequencer model it ran on
  through M14.

Validator names are the four parties of the election. Their order is
protocol-significant — the proposer for a height is validators[(H+round) % N]
— so every node must be given the same VALIDATOR_SET in the same order, which
is why it is built once here and shared rather than per host.

Ports (must match systemd env + nginx + security groups):
  RPC = 3001  (JSON-RPC + /health, nginx proxies /chain-api here)
  P2P = 4001  (mTLS block replication and consensus messages between nodes)
"""
import json
import subprocess
import sys
import os

RPC_PORT = 3001
P2P_PORT = 4001

# The validator set, in protocol order. Names are cosmetic to the protocol
# (only addresses are signed over) but they are what operators, logs and
# zk_consensusStatus show, so they are the party names.
VALIDATOR_NAMES = ["authority", "jvp", "unp", "sjb"]

# Each validator's consensus address, in the same order. These are PUBLIC —
# an address is not a secret, and every node needs every other node's in order
# to check signatures. The matching private keys are passed to the playbook as
# --extra-vars from GitHub Actions secrets and are written to a 0600 file on
# each host; they are never in this repository.
#
# The defaults below are the addresses of Hardhat's well-known test accounts
# #0-#3, which is what the local cluster uses. Override them with
# VALIDATOR_ADDRESSES for a real deployment, or the cluster will be running on
# keys that are published in Hardhat's documentation.
DEFAULT_VALIDATOR_ADDRESSES = [
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
]

ROUND_TIMEOUT_MS = os.environ.get("ROUND_TIMEOUT_MS", "4000")


def validator_addresses(count):
    """The configured consensus addresses, or the Hardhat defaults."""
    raw = os.environ.get("VALIDATOR_ADDRESSES", "").strip()
    if raw:
        addresses = [a.strip() for a in raw.split(",") if a.strip()]
    else:
        addresses = DEFAULT_VALIDATOR_ADDRESSES
    if len(addresses) < count:
        print(
            f"Error: {count} nodes but only {len(addresses)} validator addresses. "
            "Set VALIDATOR_ADDRESSES to a comma-separated list, one per node.",
            file=sys.stderr,
        )
        sys.exit(1)
    return addresses[:count]


def main():
    tf_dir = sys.argv[1] if len(sys.argv) > 1 else "../terraform"
    consensus_mode = os.environ.get("CONSENSUS_MODE", "bft").strip().lower()

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

    node_count = len(node_pub)
    primary_priv = node_priv[0]

    # Primary announces sealed blocks to every other node (solo mode only).
    primary_peers = ",".join(f"https://{ip}:{P2P_PORT}" for ip in node_priv[1:])

    # Comma-separated private IPs — the certs role builds SANs from this so the
    # shared cluster cert is valid for every node (including node4).
    node_priv_csv = ",".join(node_priv)

    if consensus_mode == "bft":
        if node_count < 4:
            print(
                f"Error: BFT consensus needs at least 4 nodes to tolerate a failure, got {node_count}. "
                "Raise node_count in Terraform, or set CONSENSUS_MODE=solo.",
                file=sys.stderr,
            )
            sys.exit(1)
        names = VALIDATOR_NAMES[:node_count]
        if node_count > len(VALIDATOR_NAMES):
            names += [f"validator{i + 1}" for i in range(len(VALIDATOR_NAMES), node_count)]
        addresses = validator_addresses(node_count)
        # Identical on every host, in identical order: two nodes given the same
        # members in a different order would disagree about whose turn it is at
        # every height and the cluster would never make progress.
        validator_set = ",".join(f"{n}:{a}" for n, a in zip(names, addresses))

    lines = ["all:", "  vars:"]
    lines.append(f"    node1_priv: {primary_priv}")
    lines.append(f"    node_priv_csv: \"{node_priv_csv}\"")
    lines.append(f"    consensus_mode: {consensus_mode}")
    if consensus_mode == "bft":
        lines.append(f"    validator_set: \"{validator_set}\"")
        lines.append(f"    round_timeout_ms: {ROUND_TIMEOUT_MS}")
    lines.append("  children:")
    lines.append("    nodes:")
    lines.append("      hosts:")
    for i in range(node_count):
        lines.append(f"        node{i + 1}:")
        lines.append(f"          ansible_host: {node_pub[i]}")
        lines.append(f"          private_ip: {node_priv[i]}")

        if consensus_mode == "bft":
            others = [j for j in range(node_count) if j != i]
            # Every validator, not just node1: consensus is a full mesh, and a
            # validator that could not reach one of its peers would be unable
            # to count that peer's votes — spending the cluster's single
            # failure of slack on a configuration gap.
            consensus_peers = ",".join(
                f"{names[j]}=https://{node_priv[j]}:{P2P_PORT}" for j in others
            )
            # Where to forward a write when this node is not the proposer.
            # Optional to the node — without it every validator handles its own
            # submissions, which is still correct, just one round slower.
            validator_rpc_urls = ",".join(
                f"{names[j]}=http://{node_priv[j]}:{RPC_PORT}" for j in others
            )
            lines.append(f"          role: primary")
            lines.append(f"          validator_id: {names[i]}")
            lines.append(f"          consensus_peers: \"{consensus_peers}\"")
            lines.append(f"          validator_rpc_urls: \"{validator_rpc_urls}\"")
        elif i == 0:
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
