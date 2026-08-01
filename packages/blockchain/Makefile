.PHONY: build run test vet fmt reset tidy diff diff-write diff-logs diff-install shape-check smoke probe-build

BINARY  := bin/zk-blockchain-node
DATA_DIR ?= data

# Build the node binary.
build:
	go build -o $(BINARY) ./cmd/node

# Build and run the node (reads config from the environment / .env; see
# .env.example).
run: build
	./$(BINARY)

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

# Recompile e2e/diff/contracts/Probe.sol into its committed artifact. Only
# needed after editing Probe.sol; the artifact is checked in so running the
# harnesses never requires a Solidity toolchain.
probe-build:
	cd e2e && node diff/contracts/build.mjs
