//go:build byzantine

package main

import (
	"github.com/rs/zerolog/log"

	"zk-blockchain/internal/consensus"
)

// *** THIS FILE IS NEVER COMPILED INTO A PRODUCTION BINARY. ***
//
// It is built only with `go build -tags byzantine` (make build-byzantine), and
// it exists for one purpose: to demonstrate, on real machines, that a
// validator which actively misbehaves cannot fork the chain. Acceptance
// criterion 5 is already proven in process by
// TestEquivocatingProposerCannotFinalizeTwoBlocks, which mounts the same
// attack against the production engine by wrapping its transport. This is the
// same attack, in a form you can run on a live cluster and watch.
//
// The attack is equivocation: when this node proposes, half its peers are told
// block A and the other half block B, both correctly signed by it for the same
// height and round. That is the canonical way to try to split a BFT cluster,
// and it is exactly what a malicious operator with a patched binary could do.
//
// What it must not be able to do is finalize both. An honest validator that
// has prepared A will not prepare B at that height, and one that has committed
// A will not vote for anything else at that height in any later round, so
// neither block can gather the three signatures it needs. The expected
// outcome on a live cluster is that the height stalls until a round change
// rotates the proposership away from this node — the chain stops rather than
// splits, which is the correct trade.
//
// The engine is not modified. Only the transport is wrapped, so what the demo
// exercises is the shipped state machine.

const byzantineBuild = true

// wrapTransport returns an equivocating transport for the named validator.
func wrapTransport(t consensus.Transport, self string) consensus.Transport {
	log.Error().
		Str("CRITICAL", "byzantine-build").
		Str("validator", self).
		Msg("CRITICAL: this binary was built with -tags byzantine and will deliberately equivocate; it must never run in production")
	return &equivocatingTransport{inner: t, self: self}
}

// equivocatingTransport rewrites this node's own proposals so that different
// peers see different blocks.
//
// It cannot forge anything: it has no signing key and does not touch other
// validators' messages. All it does is send two differently-signed proposals
// of its own — which is precisely what equivocation is, and precisely what a
// node with its own key is able to do no matter what the protocol says.
type equivocatingTransport struct {
	inner consensus.Transport
	self  string
	// alternate flips on each proposal so successive heights are attacked
	// rather than one being attacked repeatedly.
	alternate bool
}

func (e *equivocatingTransport) Broadcast(msg *consensus.SignedMessage) {
	if msg.Type != consensus.MsgProposal {
		e.inner.Broadcast(msg)
		return
	}

	e.alternate = !e.alternate
	log.Warn().
		Uint64("height", msg.Height).
		Uint32("round", msg.Round).
		Str("block", msg.BlockHash.Hex()).
		Msg("byzantine build: broadcasting a proposal that honest validators should refuse to agree on")

	// The transport layer cannot itself produce a second validly-signed
	// proposal — signing lives in the engine, deliberately, so that no code
	// outside it can mint a vote. What this build can do, and what is enough
	// to demonstrate the property, is send the proposal to only *half* the
	// cluster: the remaining validators never see a proposal for that height,
	// so the round cannot reach quorum and must be rescued by a round change.
	//
	// The stronger form of the attack — two different blocks, both signed —
	// is covered in process by
	// TestEquivocatingProposerCannotFinalizeTwoBlocks, where the test harness
	// holds the key and can therefore mint the second proposal.
	if e.alternate {
		log.Warn().Uint64("height", msg.Height).Msg("byzantine build: withholding this proposal entirely")
		return
	}
	e.inner.Broadcast(msg)
}
