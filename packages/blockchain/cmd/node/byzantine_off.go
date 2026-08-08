//go:build !byzantine

package main

import (
	"zk-blockchain/internal/consensus"
)

// The honest build. This file and byzantine_on.go are the only two places the
// `byzantine` build tag appears, and they exist so that the equivocation
// demonstration in CONSENSUS.md can be run against real processes on real
// machines without a misbehaving code path ever existing in the binary that
// ships.
//
// A production build has no branch to take: wrapTransport is the identity
// function, and the compiler removes it entirely.
func wrapTransport(t consensus.Transport, _ string) consensus.Transport { return t }

// byzantineBuild reports whether this binary can misbehave. Logged at
// startup by the tagged build so that a node built with the tag announces
// itself loudly, and never quietly.
const byzantineBuild = false
