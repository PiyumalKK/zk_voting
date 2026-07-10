.PHONY: build run test clean sync-artifacts

# Recompile the Solidity contracts and copy the four artifacts this node
# embeds into assets\. Run this after ANY change to packages\hardhat\contracts
# or to the circuit's generated Verifier.sol — a stale artifact means the Go
# node silently runs a different contract than Hardhat does. The node logs
# voting_code_hash at startup so drift is detectable; this target is the fix.
HARDHAT_DIR = ..\hardhat
HH_ARTIFACTS = $(HARDHAT_DIR)\artifacts
sync-artifacts:
	cd $(HARDHAT_DIR) && npx hardhat compile
	copy "$(HH_ARTIFACTS)\contracts\Voting.sol\Voting.json"                assets
	copy "$(HH_ARTIFACTS)\contracts\Verifier.sol\HonkVerifier.json"        assets
	copy "$(HH_ARTIFACTS)\poseidon-solidity\PoseidonT3.sol\PoseidonT3.json" assets
	copy "$(HH_ARTIFACTS)\@zk-kit\lean-imt.sol\LeanIMT.sol\LeanIMT.json"    assets
	@echo "assets\ synced from packages\hardhat"

# Build the blockchain node binary
build:
	go build -o bin\zk-node.exe .\cmd\node

# Run the blockchain node
run: build
	.\bin\zk-node.exe

# Run all tests
test:
	go test .\... -v

# Run tests with coverage
test-cover:
	go test .\... -v -cover -coverprofile=coverage.out
	go tool cover -html=coverage.out -o coverage.html

# Clean build artifacts and runtime data
clean:
	rm -rf bin\
	rm -rf data\
	rm -f coverage.out coverage.html

# Format code
fmt:
	go fmt .\...

# Vet code for issues
vet:
	go vet .\...

# Run all checks
check: fmt vet test
