.PHONY: build run test clean

# Build the blockchain node binary
build:
	go build -o bin/zk-node.exe ./cmd/node

# Run the blockchain node
run: build
	./bin/zk-node.exe

# Run all tests
test:
	go test ./... -v

# Run tests with coverage
test-cover:
	go test ./... -v -cover -coverprofile=coverage.out
	go tool cover -html=coverage.out -o coverage.html

# Clean build artifacts and runtime data
clean:
	rm -rf bin/
	rm -rf data/
	rm -f coverage.out coverage.html

# Format code
fmt:
	go fmt ./...

# Vet code for issues
vet:
	go vet ./...

# Run all checks
check: fmt vet test
