.PHONY: build run test vet fmt reset tidy

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
