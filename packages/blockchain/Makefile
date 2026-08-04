.PHONY: build build-audit build-gencerts run run-dev audit test vet fmt reset reset-cluster reset-e2e tidy diff diff-write diff-logs diff-dev diff-install shape-check smoke probe-build gen-certs run-cluster cluster-test block-rlp-test e2e e2e-core-test

DATA_DIR ?= data

# The M14 full-election gate runs on its own chain, deliberately separate from
# $(DATA_DIR): `make e2e` resets the chain it uses, and the `data/` directory
# is the one M08 built, M09 audited and M11-M13 read from.
E2E_DATA_DIR ?= data-e2e

# Extra flags passed through to e2e/election.mjs, e.g.
#   make e2e E2E_ARGS="--quiet"
#   make e2e E2E_ARGS="--no-deploy"
# (Quoted arguments do not survive a cmd.exe make command line — see
# RUNNING-GATES §0; from cmd.exe, call `node e2e\election.mjs --quiet` instead.)
E2E_ARGS ?=

# Where `make gen-certs` writes the cluster's mTLS material, and where
# e2e/cluster.mjs expects to find it (M10).
CERTS_DIR ?= certs

# The 3-node cluster's data directories live under here, one per node.
CLUSTER_DATA_DIR ?= data-cluster

# Extra flags passed through to cmd/audit, e.g.
#   make audit AUDIT_ARGS="-from 1200"
#   make audit AUDIT_ARGS="-json"
AUDIT_ARGS ?=

# On Windows, GNU Make runs recipes through cmd.exe unless a POSIX shell is
# on PATH. cmd.exe cannot execute a "./bin/x" path at all — it reads the
# forward slashes as switches and fails with "'.' is not recognized as an
# internal or external command" — and it needs the .exe suffix to resolve
# the program. So the binary name and the way it is invoked both differ per
# platform. (`reset` below branches on $(OS) for the same reason.)
ifeq ($(OS),Windows_NT)
BINARY := bin/zk-blockchain-node.exe
RUN_BINARY := bin\zk-blockchain-node.exe
AUDIT_BINARY := bin/zk-blockchain-audit.exe
RUN_AUDIT_BINARY := bin\zk-blockchain-audit.exe
GENCERTS_BINARY := bin/zk-blockchain-gencerts.exe
RUN_GENCERTS_BINARY := bin\zk-blockchain-gencerts.exe
else
BINARY := bin/zk-blockchain-node
RUN_BINARY := ./bin/zk-blockchain-node
AUDIT_BINARY := bin/zk-blockchain-audit
RUN_AUDIT_BINARY := ./bin/zk-blockchain-audit
GENCERTS_BINARY := bin/zk-blockchain-gencerts
RUN_GENCERTS_BINARY := ./bin/zk-blockchain-gencerts
endif

# Build the node binary.
build:
	go build -o $(BINARY) ./cmd/node

# Build the audit binary (M09).
build-audit:
	go build -o $(AUDIT_BINARY) ./cmd/audit

# Build the certificate generator (M10).
build-gencerts:
	go build -o $(GENCERTS_BINARY) ./cmd/gencerts

# Build and run the node (reads config from the environment / .env; see
# .env.example).
run: build
	$(RUN_BINARY)

# Build and run with the M07 dev namespaces enabled (evm_*,
# hardhat_setBalance, anvil_setBalance). Required by `make diff-dev` and by
# M08's `npx hardhat test --network custom` run; never use this for anything
# resembling a production node.
#
# `make run DEV_RPC=true` would not work: make variables are not exported to
# recipe environments by default, and the node reads configuration from the
# environment only (internal/config).
#
# The cmd.exe form uses `set "VAR=value"` — the quotes keep the trailing
# space before && out of the value, which would otherwise make
# strconv.ParseBool reject "true ".
ifeq ($(OS),Windows_NT)
run-dev: build
	set "DEV_RPC=true" && $(RUN_BINARY)
else
run-dev: build
	DEV_RPC=true $(RUN_BINARY)
endif

# Replay-verify the chain in DATA_DIR from genesis (M09): re-execute every
# block, and check the state root, receipt root, transaction root, bloom, gas
# and linkage of each one against what the chain stored. Prints
# `AUDIT OK height=N stateRoot=0x…` and exits 0, or names the first block
# that failed and exits 1.
#
# The node must be STOPPED first — Pebble holds an exclusive lock on the data
# directory, and the audit deliberately opens it read-only rather than
# fighting for it. Audit a copy if the node has to stay up.
#
#   make audit
#   make audit DATA_DIR=./data_replica1
#   make audit AUDIT_ARGS="-from 1200"     # incremental
#   make audit AUDIT_ARGS="-json"          # machine-readable summary
#
# The AUDIT_ARGS forms need a shell that strips quotes, so they work from
# Git Bash / a POSIX shell but not reliably from cmd.exe, where make
# receives the quote characters themselves and splits on the space. From
# cmd.exe, run `make build-audit` once and then call the binary directly:
#
#   make build-audit
#   bin\zk-blockchain-audit.exe -data-dir data -from 1200
#   bin\zk-blockchain-audit.exe -data-dir data -json
audit: build-audit
	$(RUN_AUDIT_BINARY) -data-dir $(DATA_DIR) $(AUDIT_ARGS)

# Run the full unit test suite.
test:
	go test ./... -v

# Static analysis.
vet:
	go vet ./...

# List files that are not gofmt-clean (should print nothing).
fmt:
	gofmt -l .

# Delete this node's on-disk chain state so the next run starts from a
# fresh genesis. Override DATA_DIR to match a non-default $DATA_DIR env var,
# e.g. `make reset DATA_DIR=./data_replica2`.
#
# `rm -rf` is POSIX-only; this repo's `make` is also run on Windows where
# recipes execute via cmd.exe (no `rm` on PATH), so reset branches on
# $(OS), which GNU Make/cmd.exe set to "Windows_NT" and POSIX shells leave
# unset.
ifeq ($(OS),Windows_NT)
reset:
	if exist $(DATA_DIR) rmdir /s /q $(DATA_DIR)
else
reset:
	rm -rf $(DATA_DIR)
endif

# Sync go.mod/go.sum with the source tree (requires network access to the
# Go module proxy).
tidy:
	go mod tidy

# Install the e2e harnesses' Node dependencies (viem, plus solc for
# probe-build). One install serves the whole e2e/ tree — Node resolves
# node_modules by walking up, so e2e/diff/*.mjs share it. Run once, or
# whenever e2e/package.json changes.
diff-install:
	cd e2e && npm install

# Differential JSON-RPC harness — read methods (M04). Diffs this node's
# responses against a live `hardhat node`. Requires both nodes already
# running, both freshly started. HARDHAT_URL is required; OUR_URL defaults
# to http://127.0.0.1:9545.
#
#   make reset && make run &                 # this node, fresh chain
#   cd ../hardhat && yarn chain &            # a fresh hardhat node
#   make diff HARDHAT_URL=http://127.0.0.1:8545
diff:
	cd e2e/diff && node diff.mjs

# Differential JSON-RPC harness — write methods (M05). Same prerequisites as
# `diff`: both nodes running and freshly started (several checks compare
# address-derived fields exactly, which only holds while the deployer's
# nonce matches on both chains).
#
#   make diff-write HARDHAT_URL=http://127.0.0.1:8545
diff-write:
	cd e2e/diff && node write.mjs

# Differential JSON-RPC harness — eth_getLogs (M06). Same prerequisites as
# `diff` and `diff-write`: both nodes running and freshly started (Probe
# must deploy to the same address on both, which only holds while account
# #0's nonce matches).
#
#   make diff-logs HARDHAT_URL=http://127.0.0.1:8545
diff-logs:
	cd e2e/diff && node logs.mjs

# Differential JSON-RPC harness — dev/compat methods (M07). Diffs
# evm_increaseTime / evm_setNextBlockTimestamp / evm_mine /
# hardhat_setBalance / anvil_setBalance against a live `hardhat node`.
#
# Unlike the harnesses above this one does NOT need freshly-started chains —
# every check is a delta or a value it writes itself — but our node must be
# running with DEV_RPC=true (use `make run-dev`), or every method answers
# -32601 and the harness exits early saying so.
#
#   make run-dev &
#   make diff-dev HARDHAT_URL=http://127.0.0.1:8545
diff-dev:
	cd e2e/diff && node dev.mjs

# JSON-shape contract test (M05). Needs no node and no chain: it runs viem's
# own formatters and ABI decoders over the exact JSON internal/rpc's receipt,
# log and transaction structs marshal to. Fast enough to run on every change.
shape-check:
	cd e2e && node shape-check.mjs

# Realistic dry-run (M05): deploys the *actual* PoseidonT3 -> LeanIMT ->
# HonkVerifier -> Voting stack from packages/hardhat/artifacts onto a running
# node and drives a real registration. Requires `yarn compile` to have been
# run in packages/hardhat. RPC_URL defaults to this node; point it at
# http://127.0.0.1:8545 to run the same script against hardhat as a control.
#
#   make reset && make run &
#   make smoke
smoke:
	cd e2e && node smoke-deploy.mjs

# ── M10: replication ──────────────────────────────────────────────────────

# Generate the cluster's mTLS material: a fresh local CA plus one certificate
# per node, into $(CERTS_DIR). Every run creates a NEW authority and
# overwrites what is there — a half-rotated cluster fails with handshake
# errors that look like network faults, so rotation is all-or-nothing.
#
# Nothing here is a secret worth protecting (a dev CA for a loopback
# cluster), but certs/ is gitignored regardless: committing a CA key teaches
# the wrong habit, and the file is one command to recreate.
gen-certs: build-gencerts
	$(RUN_GENCERTS_BINARY) -dir $(CERTS_DIR)

# Start the 3-node cluster — sequencer on :9545, replicas on :9555 and :9565,
# each with its own data directory under $(CLUSTER_DATA_DIR). Runs in the
# foreground; Ctrl+C stops all three.
#
#   make gen-certs      # once
#   make run-cluster
#
# Add --reset by calling the script directly if you want a fresh chain:
#   cd e2e && node cluster.mjs --reset
run-cluster: build
	cd e2e && node cluster.mjs

# Offline unit tests for the JS block encoder the tamper scenario uses. Needs
# no node, no cluster and no network, so it is worth running before the gate:
# a wrong field order there produces the same symptom as a caught tamper.
block-rlp-test:
	cd e2e && node lib/block-rlp.test.mjs

# The M10 acceptance gate: starts a fresh 3-node cluster and runs all five
# scenarios (convergence, write-forwarding through a replica, kill/restart
# catch-up, read equality across nodes, and a tampered block being refused).
# Stops the cluster on the way out, pass or fail.
cluster-test: build block-rlp-test
	cd e2e && node cluster-test.mjs

# Delete the cluster's data directories (all three nodes).
ifeq ($(OS),Windows_NT)
reset-cluster:
	if exist $(CLUSTER_DATA_DIR) rmdir /s /q $(CLUSTER_DATA_DIR)
else
reset-cluster:
	rm -rf $(CLUSTER_DATA_DIR)
endif

# Recompile e2e/diff/contracts/Probe.sol into its committed artifact. Only
# needed after editing Probe.sol; the artifact is checked in so running the
# harnesses never requires a Solidity toolchain.
probe-build:
	cd e2e && node diff/contracts/build.mjs

# ── M14: the full election ────────────────────────────────────────────────

# Offline unit tests for the election's cryptography and Merkle-path logic.
# No node, no chain, no network, no proving — run this before `make e2e`, and
# after any change to e2e/lib/election-core.mjs. A failure here is a failure
# of arithmetic, which is much cheaper to read than the same fault surfacing
# as an invalid proof ten minutes into the full gate.
e2e-core-test:
	cd e2e && node --test lib/election-core.test.mjs

# The M14 acceptance gate: one complete election, end to end, on a chain this
# target creates and destroys.
#
#   fresh node -> yarn deploy --network custom -> admin lifecycle -> GN
#   enrols five voters -> each registers -> Merkle path from logs -> REAL
#   UltraHonk proof -> vote from an UNFUNDED burner -> tally / nullifier /
#   double-vote -> restart -> cmd/audit replays the whole chain
#
# It starts and stops its own node on :9545 against $(E2E_DATA_DIR), so
# nothing else may be listening there — `make run` in another terminal makes
# this fail immediately, on purpose, rather than driving the wrong chain.
#
# Needs, beyond the Go binaries: `yarn compile` at the repo root (contract
# artifacts and the deploy toolchain), `make diff-install` (viem, bb.js,
# noir_js, poseidon-lite), and internet access on the FIRST run only — bb.js
# downloads its structured reference string and caches it in ~/.bb-crs.
#
#   make e2e
#   make e2e E2E_ARGS="--quiet"        # don't echo the node's own log
e2e: build build-audit e2e-core-test
	cd e2e && node election.mjs $(E2E_ARGS)

# Delete the full-election gate's data directory. `make e2e` does this itself
# at the start of every run; this is for reclaiming the disk afterwards.
ifeq ($(OS),Windows_NT)
reset-e2e:
	if exist $(E2E_DATA_DIR) rmdir /s /q $(E2E_DATA_DIR)
else
reset-e2e:
	rm -rf $(E2E_DATA_DIR)
endif
