package chain

import (
	"errors"
	"fmt"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/rawdb"
	"github.com/ethereum/go-ethereum/core/types"
)

// This file is M10's replica side: applying a block that some *other* node
// produced.
//
// The design rule is that a replica trusts nothing it is told. A pushed
// block is a claim — "executing these transactions on top of your current
// head yields this state root" — and this node checks that claim by doing
// the work itself, with exactly the code M09's auditor uses (replay.go's
// replayBlock/verifyBlock/verifyLinkage). Only if its own re-execution
// reproduces every value the header commits to does the block become part of
// this replica's chain.
//
// That is the whole tamper-evidence property MASTER §3 claims: "replicas are
// trust-but-verify followers: they re-execute every block and refuse any
// block whose state root doesn't match". A replica that instead copied the
// primary's state would make the three-node topology a backup arrangement,
// not a check on the operator.
//
// Two consequences worth stating explicitly, because they shape the code:
//
//  1. Verification reuses replay.go rather than reimplementing it. If the
//     two ever diverged, one of them would be wrong about what this chain's
//     rules are, and the failure mode is silent: a replica that verifies
//     more loosely than the auditor accepts blocks the audit will later
//     reject.
//
//  2. Applying is serialised on the Sequencer's own mutex, not a separate
//     one. A node is either sealing or following, never both — but making
//     that true by construction costs one shared lock and removes the entire
//     class of "a replica was accidentally configured as a primary and both
//     paths raced on the head" bugs.

var (
	// ErrBlockAlreadyApplied means the pushed block is byte-identical to the
	// one this node already has at that height. It is a success, not a
	// failure: the primary's push retry queue (internal/p2p) is
	// at-least-once, so a duplicate arriving after a slow-but-successful
	// first delivery is routine and must not be logged as tampering.
	ErrBlockAlreadyApplied = errors.New("block already applied")

	// ErrForkDetected means a *different* block already occupies that
	// height on this node. On a single-sequencer chain (MASTER §3, "no
	// forks") this cannot happen honestly: it means either the primary
	// rewrote history, or this replica was pointed at a second chain. Either
	// way the correct response is to refuse and shout — never to overwrite,
	// which would destroy the evidence.
	ErrForkDetected = errors.New("fork detected: a different block is already canonical at this height")

	// ErrGenesisPush means the primary offered block 0. Genesis is created
	// locally from configuration (internal/state.EnsureGenesis) and is the
	// one block a replica must NOT accept from the wire — accepting it would
	// let a primary redefine the chain's prefunded accounts.
	ErrGenesisPush = errors.New("refusing a pushed genesis block: genesis is derived from local configuration")
)

// OutOfOrderError means the offered block is too far ahead: this node is
// missing at least one block in between, so it cannot execute this one yet.
//
// It carries the height this node needs next rather than just saying "no",
// because that number is the whole remedy — internal/p2p's follower uses it
// to pull the gap from the primary, and the HTTP layer returns it to the
// pusher so a human reading a 409 can see how far behind the replica is.
type OutOfOrderError struct {
	// Offered is the block number that was pushed.
	Offered uint64
	// Expected is the number this node needs next (local head + 1).
	Expected uint64
}

func (e *OutOfOrderError) Error() string {
	return fmt.Sprintf("block %d is out of order: this node needs block %d next", e.Offered, e.Expected)
}

// HeadInfo returns the current head's number and hash — the two values the
// P2P head endpoint (`GET /p2p/head`) reports and a replica compares against
// its own to decide whether it is synced.
//
// It exists alongside internal/state.Height because a height alone cannot
// answer "are we on the same chain": two nodes can agree on 787 and disagree
// on every block in it.
func (s *Sequencer) HeadInfo() (uint64, common.Hash, error) {
	header, err := s.currentHeader()
	if err != nil {
		return 0, common.Hash{}, err
	}
	return header.Number.Uint64(), header.Hash(), nil
}

// BlockByNumber returns the canonical block at height n. BlockByTag already
// does this for JSON-RPC's tag-or-number argument; this is the plain-uint64
// form the P2P catch-up endpoint needs, which has no concept of
// latest/pending tags.
func (s *Sequencer) BlockByNumber(n uint64) (*types.Block, error) {
	header, err := s.HeaderByNumber(n)
	if err != nil {
		return nil, err
	}
	return s.blockByHeader(header)
}

// ApplyExternalBlock verifies a block produced elsewhere and, if it holds up,
// makes it this node's new head.
//
// The checks, in order, and what each one is for:
//
//	block 0                 — never accepted from the wire (ErrGenesisPush)
//	number <= head, same    — already applied; idempotent success
//	number <= head, differs — ErrForkDetected; history rewrite or wrong chain
//	number > head+1         — *OutOfOrderError; caller must pull the gap
//	linkage                 — parent hash, numbering, strictly increasing time
//	re-execution            — state root, gasUsed, tx/receipt roots, bloom
//
// Only after all of them pass is anything written to disk, and the write is
// the same atomic rawdb batch the sequencer uses (persist), so an interrupted
// replica recovers exactly the way M09's TestChainRecoversFromAPartialWrite
// describes.
//
// A verification failure returns a *ReplayMismatch naming the field that
// disagreed — the same structured error `cmd/audit` prints. That is
// deliberate: "your replica rejected block 412 on stateRoot" and "the audit
// failed at block 412 on stateRoot" should be the same sentence, because
// they are the same finding.
func (s *Sequencer) ApplyExternalBlock(block *types.Block) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	number := block.NumberU64()
	if number == 0 {
		return ErrGenesisPush
	}

	head, err := s.currentHeader()
	if err != nil {
		return err
	}
	headNumber := head.Number.Uint64()

	if number <= headNumber {
		canonical := rawdb.ReadCanonicalHash(s.db, number)
		if canonical == block.Hash() {
			return ErrBlockAlreadyApplied
		}
		return fmt.Errorf("%w: block %d is %s here, offered %s", ErrForkDetected, number, canonical, block.Hash())
	}
	if number > headNumber+1 {
		return &OutOfOrderError{Offered: number, Expected: headNumber + 1}
	}

	parent, err := s.blockByHeader(head)
	if err != nil {
		return fmt.Errorf("reading the parent of block %d: %w", number, err)
	}
	if mismatch := verifyLinkage(block, parent); mismatch != nil {
		return mismatch
	}

	// src and work are both this node's own database: unlike the auditor —
	// which deliberately writes re-execution's trie nodes into a throwaway
	// overlay so the audited directory is never touched — a replica *wants*
	// to keep the state it just derived. That is its state.
	replayer := NewReplayer(s.db, s.db, s.chainCfg)
	root, receipts, gasUsed, err := replayer.replayBlock(block, parent.Root())
	if err != nil {
		return err
	}
	if mismatch := verifyBlock(block, root, receipts, gasUsed); mismatch != nil {
		return mismatch
	}

	// Annotating before persisting is symmetry with the sealing path rather
	// than a requirement: the stored receipt encoding is EIP-658's three
	// fields (status, cumulative gas, logs) and carries none of these, and
	// the RPC layer re-derives them on every read anyway
	// (txlookup.go's deriveReceiptFields). It is done because the two paths
	// producing a durable block should hand the same object to persist —
	// leaving one of them half-filled is how a later change that *does*
	// surface these receipts acquires a bug that only appears on replicas.
	annotateReceipts(block, receipts)

	if err := persist(s.db, block, receipts); err != nil {
		return err
	}

	// Publishing to the local feed lets a replica push to followers of its
	// own (a chain of replicas), and costs nothing when there are none —
	// blockFeed drops into a void with no subscribers. Nothing in the
	// current topology relies on it; it is here so that "a node announces
	// every block it accepts" is true of all nodes rather than only of the
	// primary.
	s.feed.publish(block)
	return nil
}
