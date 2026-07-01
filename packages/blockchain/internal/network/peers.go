package network

import (
	"os"
	"strings"
)

// Peers is the list of peer node URLs this node broadcasts to and syncs from.
// Configured via the PEERS environment variable as a comma-separated list.
// Example: PEERS=https://node2:3002,https://node3:3003
var Peers []string

func init() {
	env := os.Getenv("PEERS")
	if env == "" {
		return
	}
	for _, p := range strings.Split(env, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			Peers = append(Peers, p)
		}
	}
}
