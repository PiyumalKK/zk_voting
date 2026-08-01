#!/usr/bin/env python3
"""Generate blockchain-v2 diagrams for the final report (print-friendly, white bg)."""
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

OUT = "/sessions/beautiful-inspiring-maxwell/mnt/zk_voting/Final Report/Report Template/Images"

INK = "#1f2937"
BLUE = "#dbeafe"; BLUE_E = "#2563eb"
GREEN = "#dcfce7"; GREEN_E = "#16a34a"
ORANGE = "#ffedd5"; ORANGE_E = "#ea580c"
PURPLE = "#ede9fe"; PURPLE_E = "#7c3aed"
RED = "#fee2e2"; RED_E = "#dc2626"
GRAY = "#f3f4f6"; GRAY_E = "#6b7280"
plt.rcParams.update({"font.family": "DejaVu Sans", "text.color": INK})


def box(ax, x, y, w, h, text, fc, ec, fs=10, weight="normal", ls="-", pad=0.12):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle=f"round,pad={pad}",
                                fc=fc, ec=ec, lw=1.6, linestyle=ls, zorder=2))
    ax.text(x + w / 2, y + h / 2, text, ha="center", va="center",
            fontsize=fs, weight=weight, zorder=3, linespacing=1.45)


def arrow(ax, p1, p2, color=INK, lw=1.8, ls="-", style="-|>", ms=16):
    ax.add_patch(FancyArrowPatch(p1, p2, arrowstyle=style, mutation_scale=ms,
                                 color=color, lw=lw, linestyle=ls, zorder=4,
                                 shrinkA=2, shrinkB=2))


def canvas(w, h):
    fig, ax = plt.subplots(figsize=(w, h))
    ax.set_xlim(0, 100); ax.set_ylim(0, 100)
    ax.axis("off")
    return fig, ax


def save(fig, name):
    fig.savefig(f"{OUT}/{name}", dpi=200, bbox_inches="tight",
                facecolor="white")
    plt.close(fig)
    print("wrote", name)


# ---------------------------------------------------------------- architecture
fig, ax = canvas(13.5, 7.6)
ax.text(50, 97, "Custom Go Blockchain — Architecture", ha="center",
        fontsize=15, weight="bold")

clients = [
    ("Mobile Voter App\n(viem, raw signed txs)", 84),
    ("Web Portals\nadmin / GN / results / audit", 68),
    ("Next.js API Routes\n(election, merkle-path,\nverify-vote)", 50),
    ("Admin / GN Relay\n(server-side signer)", 32),
    ("hardhat-deploy\n(contract deployment)", 16),
]
for label, cy in clients:
    box(ax, 2, cy - 6, 22, 12, label, BLUE, BLUE_E, fs=9.5)
    arrow(ax, (24.6, cy), (33.4, cy), color=BLUE_E)

ax.text(12, 93.5, "Ethereum JSON-RPC (HTTP :9545)", ha="left", fontsize=9.5,
        weight="bold", color=BLUE_E)

# node outer
box(ax, 34, 6, 44, 84, "", "#ffffff", INK, pad=0.2)
ax.text(56, 86.5, "Go Node (packages/blockchain)", ha="center",
        fontsize=12, weight="bold")

box(ax, 37, 68, 38, 13,
    "JSON-RPC Server  [internal/rpc]\neth_  ·  net_  ·  web3_  ·  dev (gated)\nCORS + rate limiting", BLUE, BLUE_E, fs=9.5)
arrow(ax, (56, 67.2), (56, 60.3))
box(ax, 37, 47, 38, 13,
    "Sequencer  [internal/chain]\nvalidate → execute → seal 1-tx block\nreverts rejected at submission", GREEN, GREEN_E, fs=9.5)
arrow(ax, (56, 46.2), (56, 39.3))
box(ax, 37, 26, 38, 13,
    "Embedded EVM  [go-ethereum]\nvm.EVM + StateDB — contract-agnostic\n(zero base fee, gas metered not charged)", GREEN, GREEN_E, fs=9.5)
arrow(ax, (56, 25.2), (56, 18.3))
box(ax, 37, 8, 38, 10,
    "Pebble Storage (geth rawdb)  [internal/storage]\nblocks · receipts · tx-lookup · state trie", ORANGE, ORANGE_E, fs=9.5)

# p2p + replicas + audit (right column, no line crossings)
box(ax, 81, 60, 17, 13, "P2P Replication\n[internal/p2p]\nmTLS :9546", PURPLE, PURPLE_E, fs=9.5)
arrow(ax, (75.6, 53.5), (80.4, 64), color=PURPLE_E)
box(ax, 81, 42, 17, 11, "Replica 1\nre-execute + verify\nserve reads", PURPLE, PURPLE_E, fs=9)
box(ax, 81, 27, 17, 11, "Replica 2\nre-execute + verify\nserve reads", PURPLE, PURPLE_E, fs=9)
arrow(ax, (89.5, 59.2), (89.5, 54), color=PURPLE_E)
arrow(ax, (89.5, 41.2), (89.5, 39), color=PURPLE_E)
box(ax, 81, 6, 17, 13, "Audit CLI\n[cmd/audit]\nreplay from genesis,\nverify every root", GRAY, GRAY_E, fs=9)
arrow(ax, (80.4, 12.5), (75.9, 13), color=GRAY_E, ls=(0, (4, 3)))
save(fig, "fig_chain_v2_architecture.png")

# ---------------------------------------------------------------- tx lifecycle
fig, ax = canvas(13.5, 5.2)
ax.text(50, 95, "Transaction Lifecycle (auto-mine, one transaction per block)",
        ha="center", fontsize=14, weight="bold")

box(ax, 2, 55, 15, 22, "Signed raw tx\n(eth_sendRaw-\nTransaction)", BLUE, BLUE_E, fs=9.5)
box(ax, 21, 55, 17, 22, "1 · Validate\nsignature + chain id\nexact nonce\ngas ≤ 60M cap", GREEN, GREEN_E, fs=9.5)
box(ax, 42, 55, 17, 22, "2 · Execute\napply in EVM on\ncopy of state,\nbuild receipt + logs", GREEN, GREEN_E, fs=9.5)
box(ax, 63, 55, 17, 22, "3 · Seal block\n1 tx, ts strictly ↑\nbase fee 0, roots\n(state/tx/receipt)", GREEN, GREEN_E, fs=9.5)
box(ax, 84, 55, 14, 22, "4 · Persist\natomic batch;\npush to replicas", ORANGE, ORANGE_E, fs=9.5)

for x1, x2 in [(17.6, 20.4), (38.6, 41.4), (59.6, 62.4), (80.6, 83.4)]:
    arrow(ax, (x1, 66), (x2, 66))

box(ax, 21, 12, 38, 18,
    "Revert or validation failure → rejected at submission:\nJSON-RPC error carries ABI-encoded custom error\n(e.g. Voting__NullifierHashAlreadyUsed) — no block is mined",
    RED, RED_E, fs=9.5)
arrow(ax, (50.5, 54.2), (44, 31.2), color=RED_E)
ax.text(41, 44, "on failure", fontsize=9, color=RED_E, style="italic")
ax.text(91, 44, "receipt final\nimmediately\n(no reorgs)", ha="center",
        fontsize=9, color=GRAY_E, style="italic")
save(fig, "fig_chain_v2_tx_lifecycle.png")

# ---------------------------------------------------------------- replication
fig, ax = canvas(12, 6.8)
ax.text(50, 96, "Replicated Topology — Sequencer + Verifying Replicas",
        ha="center", fontsize=14, weight="bold")

box(ax, 36, 66, 28, 20,
    "Sequencer (primary)\norders + executes all txs\nseals blocks — no forks,\ninstant finality", GREEN, GREEN_E, fs=10)
box(ax, 6, 26, 26, 20,
    "Replica 1\nre-execute every tx\nverify state root\nreject mismatch (409)", PURPLE, PURPLE_E, fs=10)
box(ax, 68, 26, 26, 20,
    "Replica 2\nre-execute every tx\nverify state root\nreject mismatch (409)", PURPLE, PURPLE_E, fs=10)

arrow(ax, (42, 65), (24, 47.5), color=PURPLE_E)
arrow(ax, (58, 65), (76, 47.5), color=PURPLE_E)
ax.text(24.5, 58.5, "push sealed block\n(mTLS :9546)", fontsize=9, color=PURPLE_E,
        ha="center")
ax.text(75.5, 58.5, "push sealed block\n(mTLS :9546)", fontsize=9, color=PURPLE_E,
        ha="center")
arrow(ax, (30, 47.5), (44, 66.5), color=GRAY_E, ls=(0, (4, 3)))
arrow(ax, (70, 47.5), (56, 66.5), color=GRAY_E, ls=(0, (4, 3)))
ax.text(38, 51, "forward writes /\ncatch-up pull", fontsize=8.5, color=GRAY_E,
        ha="center")
ax.text(62.5, 51, "forward writes /\ncatch-up pull", fontsize=8.5, color=GRAY_E,
        ha="center")

box(ax, 6, 4, 26, 12, "Results / audit / explorer\nread from replicas", BLUE, BLUE_E, fs=9.5)
box(ax, 68, 4, 26, 12, "Results / audit / explorer\nread from replicas", BLUE, BLUE_E, fs=9.5)
arrow(ax, (19, 17), (19, 25), color=BLUE_E)
arrow(ax, (81, 17), (81, 25), color=BLUE_E)

box(ax, 38, 22, 24, 14,
    "Tamper evidence:\nany falsified block fails\nre-execution on every\nhonest replica", RED, RED_E, fs=9.5)
save(fig, "fig_chain_v2_replication.png")

# ---------------------------------------------------------------- auth relay
fig, ax = canvas(13.5, 6.4)
ax.text(50, 96, "Wallet-Free Authentication (custom-chain mode)", ha="center",
        fontsize=14, weight="bold")

box(ax, 2, 66, 20, 16, "Admin browser\n(no wallet)", BLUE, BLUE_E, fs=10)
box(ax, 2, 44, 20, 16, "GN officer browser\n(no wallet)", BLUE, BLUE_E, fs=10)
box(ax, 28, 55, 20, 16,
    "Login + session\nusername / password\n(bcrypt, rate-limited,\nlockout)", GRAY, GRAY_E, fs=9.5)
arrow(ax, (22.6, 73), (28.5, 66.5), color=BLUE_E)
arrow(ax, (22.6, 52), (28.5, 59.5), color=BLUE_E)

box(ax, 54, 51, 22, 24,
    "Signing relay (server)\n• function whitelist per role\n• admin key + per-GN keys\n  (encrypted at rest)\n• GN scoped to own division\n• append-only audit log", GREEN, GREEN_E, fs=9.5)
arrow(ax, (48.6, 63), (53.4, 63))

box(ax, 85, 55, 13, 16, "Go chain\nnode\n(JSON-RPC)", ORANGE, ORANGE_E, fs=10)
arrow(ax, (76.6, 63), (84.4, 63), color=GREEN_E)
ax.text(80.5, 76.5, "signed lifecycle tx", fontsize=8.5, ha="center",
        color=GREEN_E)
arrow(ax, (80.5, 74.5), (80.5, 65), color=GREEN_E, lw=0.9, ls=(0, (2, 2)),
      style="-")

box(ax, 2, 6, 30, 20,
    "Voter mobile app\nkeystore key → register()\nfresh burner + ZK proof → vote()\n(zero balance — gasless)", PURPLE, PURPLE_E, fs=9.5)
arrow(ax, (32.6, 16), (90, 54), color=PURPLE_E)
ax.text(48, 13, "direct JSON-RPC — never via server",
        fontsize=9.5, color=PURPLE_E, style="italic", ha="center")

box(ax, 66, 6, 28, 15,
    "Relay cannot sign register() or vote():\nvotes are unforgeable even\nif the server is compromised", RED, RED_E, fs=9)
save(fig, "fig_chain_v2_auth_relay.png")

# ---------------------------------------------------------------- testing
fig, ax = canvas(13.5, 5.6)
ax.text(50, 96, "Blockchain Verification Methodology", ha="center",
        fontsize=14, weight="bold")

box(ax, 39, 40, 22, 24,
    "Custom Go node\n(chain id 9494)\n+ Go unit tests\nper package", GREEN, GREEN_E, fs=10)
box(ax, 4, 40, 22, 24, "Reference\nHardhat node\n(chain id 31337)", GRAY, GRAY_E, fs=10)

arrow(ax, (26.6, 55), (38.4, 55), color=BLUE_E, style="<|-|>")
ax.text(32.5, 60, "differential harness:\nidentical viem calls,\nresponses diffed\n(incl. revert errors)",
        fontsize=8.5, ha="center", color=BLUE_E)

box(ax, 33, 74, 34, 14,
    "Unmodified Hardhat contract test suite\n(55 tests) run with --network custom", BLUE, BLUE_E, fs=9.5)
arrow(ax, (50, 73), (50, 65))

box(ax, 33, 8, 34, 14,
    "Audit replay: re-execute all blocks from\ngenesis; verify every state/receipt/tx root", ORANGE, ORANGE_E, fs=9.5)
arrow(ax, (50, 39), (50, 23))

box(ax, 72, 40, 24, 24,
    "Cluster tests (3 nodes)\n• replicas verify + serve reads\n• tampered block rejected\n• catch-up after downtime\n• writes forwarded", PURPLE, PURPLE_E, fs=9)
arrow(ax, (61.6, 52), (71.4, 52), color=PURPLE_E)
save(fig, "fig_chain_v2_testing.png")
