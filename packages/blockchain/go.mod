module zk-blockchain

go 1.25.0

require github.com/rs/zerolog v1.35.1

// NOTE (M01): `go mod tidy` correctly pruned github.com/ethereum/go-ethereum (and
// go.etcd.io/bbolt, github.com/holiman/uint256, golang.org/x/time) because nothing in
// the current source tree imports them yet — M01 only touches config/logging/health,
// not the EVM. This is expected, not a regression: M02 (internal/state) will run
// `go get github.com/ethereum/go-ethereum@v1.16.8` (current stable per MASTER §3,
// Prague/Cancun support) when it first imports go-ethereum packages, then `go mod tidy`
// will repopulate this block with the real v1.16.8 dependency graph.
require (
	github.com/joho/godotenv v1.5.1
	github.com/mattn/go-colorable v0.1.14 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	golang.org/x/sys v0.29.0 // indirect
)
