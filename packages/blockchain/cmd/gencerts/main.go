// Command gencerts creates the mTLS material the P2P cluster runs on: one
// local certificate authority, and one certificate per node signed by it
// (M10 deliverable 1).
//
// Usage:
//
//	go run ./cmd/gencerts                                  # ca + every local cluster name into ./certs
//	go run ./cmd/gencerts -dir ./certs -nodes primary,replica1
//	go run ./cmd/gencerts -nodes authority,jvp,unp,sjb     # the BFT validators only
//	go run ./cmd/gencerts -hosts 10.0.0.7,node-a.internal  # extra SANs for a non-local cluster
//	go run ./cmd/gencerts -days 30
//
// or, from packages/blockchain: `make gen-certs`.
//
// Each run creates a NEW authority and overwrites everything in -dir. That is
// deliberate: a half-rotated cluster, where some nodes hold certificates from
// the old CA and some from the new, fails with handshake errors that look
// like network problems. Regenerate all of it, restart all of it.
//
// The CA private key is written alongside the node certificates because this
// is a development convenience. A real deployment keeps ca.key off the nodes
// entirely — see the cert rotation note in README.md.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"zk-blockchain/internal/p2p"
)

func main() {
	dir := flag.String("dir", "./certs", "directory to write the CA and node certificates into")
	// The default covers both local clusters at once — the solo topology and
	// the four BFT validators — so `make gen-certs` prepares whichever one
	// you then run. Issuing seven certificates rather than three costs
	// milliseconds and removes a class of "handshake failed" confusion when
	// switching between them.
	nodes := flag.String("nodes", "primary,replica1,replica2,authority,jvp,unp,sjb",
		"comma-separated node names; one certificate is issued per name")
	hosts := flag.String("hosts", "", "comma-separated extra hostnames/IPs to add to every certificate (localhost, 127.0.0.1, ::1 and the node name are always included)")
	days := flag.Int("days", 365, "certificate lifetime in days")
	flag.Parse()

	nodeNames := splitList(*nodes)
	if len(nodeNames) == 0 {
		fail("-nodes must name at least one node")
	}
	if *days <= 0 {
		fail("-days must be greater than 0")
	}

	validity := time.Duration(*days) * 24 * time.Hour
	if err := p2p.GenerateCluster(*dir, nodeNames, splitList(*hosts), validity); err != nil {
		fail("%v", err)
	}

	absDir, err := filepath.Abs(*dir)
	if err != nil {
		absDir = *dir
	}

	fmt.Printf("wrote a new certificate authority and %d node certificate(s) to %s\n", len(nodeNames), absDir)
	fmt.Printf("  ca.crt / ca.key            the cluster's authority (keep ca.key off the nodes in a real deployment)\n")
	for _, name := range nodeNames {
		fmt.Printf("  %-26s %s\n", name+".crt / "+name+".key", "TLS_CERT / TLS_KEY for "+name)
	}
	fmt.Printf("\nvalid for %d day(s). Every node also needs TLS_CA=%s\n", *days, filepath.Join(*dir, "ca.crt"))
}

func splitList(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "gencerts: "+format+"\n", args...)
	os.Exit(1)
}
