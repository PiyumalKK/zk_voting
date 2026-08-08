// Package consensus implements QBFT/IBFT-style Byzantine-fault-tolerant
// block production for this chain: a fixed, known set of validators takes
// turns proposing blocks, and a block becomes final only once a quorum of
// them has cryptographically signed a COMMIT for it.
//
// # Why this exists
//
// Through M14 this chain had exactly one writer. That is simple and
// fork-free, and it means the machine running the sequencer is a single point
// of both failure and trust: if it stops, the election stops, and whatever it
// seals is the truth. For a national-scale vote neither is acceptable. With
// four validators (authority, jvp, unp, sjb) and a quorum of three, no single
// party can halt the election and no single party can decide its contents.
//
// # What this package does and does not do
//
// It decides *ordering and finality*. It does not execute anything: block
// building goes through chain.BuildCandidate, verification through
// chain.VerifyCandidate, and commitment through chain.ApplyExternalBlock —
// all of which are the pre-existing paths, and all of which route through
// replay.go. A validator that votes for a block has re-executed it and
// reproduced its state root itself; it never takes a peer's word for
// anything.
//
// # The shape of the protocol
//
//	PRE-PREPARE  the round's proposer broadcasts a block
//	PREPARE      every validator that re-executes it and agrees broadcasts one
//	COMMIT       on Q prepares, a validator locks the block and broadcasts one
//	FINALIZE     on Q commits, the block is applied and its seals stored
//	ROUND-CHANGE on timeout, Q of these rotate to the next proposer
//
// Single-slot final: once Q commits exist for a height, that block is
// immutable and no reorg above it is possible. See CONSENSUS.md for the
// safety argument and the failure-mode demonstrations.
package consensus

import "errors"

var (
	// ErrNotValidator means a message's signature recovered to an address
	// that is not in the validator set. Not necessarily an attack — a node
	// left over from an older set, or one whose key does not match the
	// address it is listed under, produces exactly this.
	ErrNotValidator = errors.New("message signer is not a validator")

	// ErrBadSignature means the signature is malformed or does not recover.
	ErrBadSignature = errors.New("consensus message signature is invalid")

	// ErrWrongProposer means a PRE-PREPARE arrived from a validator whose
	// turn it is not. Round-robin makes whose turn it is a pure function of
	// (height, round), so every honest validator agrees on the answer and
	// this is always the sender's error.
	ErrWrongProposer = errors.New("proposal is not from this round's proposer")

	// ErrEquivocation means a validator signed two different block hashes for
	// the same height, round and message type. This is the definition of
	// Byzantine behaviour in this protocol and the only kind this code can
	// detect locally.
	ErrEquivocation = errors.New("validator signed two different blocks at the same height and round")

	// ErrConsensusTimeout means a submitted transaction did not reach quorum
	// before its deadline. It is reported to the client as a plain failure
	// with an explicit "not mined" so a resubmission is safe: the transaction
	// either never entered a block, or would be rejected as a duplicate nonce
	// if it somehow did.
	ErrConsensusTimeout = errors.New("consensus did not reach quorum for this transaction; it was not mined — safe to resubmit")

	// ErrBusy means the submit queue is full. Back-pressure, not a mempool:
	// nothing here is persisted or gossiped, so a queue that grows without
	// bound would just be a longer list of clients waiting for the same
	// timeout.
	ErrBusy = errors.New("too many transactions are awaiting consensus")

	// ErrShuttingDown means the engine stopped while a request was in flight.
	ErrShuttingDown = errors.New("consensus engine is shutting down")

	// ErrNotSynced means this node has not caught up far enough to
	// participate. A validator that has just restarted must replay the blocks
	// it missed — verifying each one itself — before it votes, or it would be
	// voting on a height it cannot evaluate.
	ErrNotSynced = errors.New("this validator is still catching up")
)
