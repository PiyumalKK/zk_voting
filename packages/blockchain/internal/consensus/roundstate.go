package consensus

import (
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

// phase is how far this node has got at the current height.
type phase uint8

const (
	// phaseIdle: no valid proposal held for this (height, round).
	phaseIdle phase = iota
	// phasePrePrepared: a valid proposal is held and this node has broadcast
	// its PREPARE.
	phasePrePrepared
	// phasePrepared: a quorum of prepares has been seen, this node has locked
	// the block and broadcast its COMMIT. From here it will not vote for any
	// other block at this height, in any round, ever.
	phasePrepared
)

func (p phase) String() string {
	switch p {
	case phaseIdle:
		return "idle"
	case phasePrePrepared:
		return "pre-prepared"
	case phasePrepared:
		return "prepared"
	default:
		return "unknown"
	}
}

// voteKey identifies one validator's vote in one phase of one round. It is
// the key of the dedup map, and therefore the thing that turns a second,
// contradictory vote into detected equivocation rather than a second tally
// entry.
type voteKey struct {
	round  uint32
	typ    MsgType
	signer common.Address
}

// roundState is the consensus state for exactly one height.
//
// It is owned by Engine.run and read or written by nothing else, which is why
// it carries no lock. That is not a performance choice — at four validators
// and one transaction per block there is nothing to optimise — it is a
// correctness one. The safety argument rests on "an honest validator
// broadcasts a COMMIT for at most one block per height", and with a single
// owning goroutine that is a property of the code: there is no interleaving
// in which two commits could be produced. Under a mutex it would instead be a
// discipline that every future edit has to maintain.
type roundState struct {
	height uint64
	round  uint32

	proposer Validator
	isSelf   bool
	ph       phase

	// proposal is the block being voted on this round, nil until a valid
	// PRE-PREPARE arrives or this node builds one.
	proposal *types.Block

	// prepares and commits are keyed by block hash *first*, because a vote
	// can legitimately arrive before the proposal it refers to — a broadcast
	// is not ordered, and a fast peer's PREPARE routinely overtakes the
	// proposer's PRE-PREPARE. Keying by round first would mean discarding
	// those, which costs a round timeout every time it happens.
	//
	// commits deliberately span every round at this height: commit
	// signatures are round-independent by construction (see Digest), so a
	// commit cast in round 0 and one cast in round 2 for the same block
	// aggregate toward the same quorum.
	prepares map[common.Hash]map[common.Address]*SignedMessage
	commits  map[common.Hash]map[common.Address]*SignedMessage

	// changes[r] holds round-change votes targeting round r.
	changes map[uint32]map[common.Address]*SignedMessage

	// The lock. Set the instant this node broadcasts a COMMIT, and surviving
	// every round change at this height. Two consequences, and they are the
	// whole of the safety argument:
	//
	//   - this node will never PREPARE a different block at this height, so
	//     it can never contribute to a second block reaching quorum;
	//   - a new proposer that sees this lock reported in a ROUND-CHANGE must
	//     re-propose the locked block, so a block that may already have been
	//     committed somewhere cannot be orphaned.
	lockedHash  common.Hash
	lockedRound uint32
	lockedBlock *types.Block
	locked      bool

	// seen maps each (round, type, signer) to the block hash that validator
	// voted for. A repeat with the same hash is ordinary at-least-once
	// delivery; a repeat with a different hash is equivocation.
	seen map[voteKey]common.Hash

	// faulty records validators caught equivocating at this height, for
	// zk_consensusStatus and the logs.
	faulty map[common.Address]bool

	// timerArmed tracks whether a round timeout is pending, so the engine can
	// keep the quiescence rule (no timer while there is nothing to propose)
	// without inspecting the timer itself.
	timerArmed bool

	// peerActivity records that some other validator has sent a message for
	// this height, which means somebody out there is trying to make progress.
	//
	// This is what lets the quiescence rule coexist with round changes. A
	// node with nothing queued runs no timer, so it would never time out and
	// never call for a round change — and a single validator holding the only
	// pending transaction would then ask for a new round entirely alone,
	// never reaching quorum, and the chain would deadlock exactly when one
	// node has work and the proposer does not. Treating a peer's message as
	// evidence that this height matters arms the timer, so the rest of the
	// cluster joins the round change on its next tick.
	//
	// A Byzantine validator can use this to force round rotation. It gains
	// nothing by it: rotation cannot affect safety, and that node could
	// already force exactly the same rotation by staying silent when its own
	// turn came.
	peerActivity bool
	// deadline is when the current round gives up, for status reporting.
	deadline time.Time
}

func newRoundState(height uint64, round uint32, proposer Validator, isSelf bool) *roundState {
	return &roundState{
		height:   height,
		round:    round,
		proposer: proposer,
		isSelf:   isSelf,
		ph:       phaseIdle,
		prepares: make(map[common.Hash]map[common.Address]*SignedMessage),
		commits:  make(map[common.Hash]map[common.Address]*SignedMessage),
		changes:  make(map[uint32]map[common.Address]*SignedMessage),
		seen:     make(map[voteKey]common.Hash),
		faulty:   make(map[common.Address]bool),
	}
}

// record files a verified vote, reporting whether it is new and whether it is
// equivocation.
//
// When a validator is caught voting twice for different blocks, *both* votes
// are discarded — including the one already tallied. Keeping the first would
// let a Byzantine validator choose which honest node's tally it contributes
// to simply by controlling arrival order, which is exactly the power the
// quorum-intersection argument assumes it does not have. Discarding both
// costs at most liveness: the round may die by timeout, and with N=4 the
// remaining three honest validators still make quorum.
func (rs *roundState) record(sm *SignedMessage) (accepted bool, equivocated bool) {
	signer, ok := sm.Signer()
	if !ok {
		// Unreachable: the engine verifies before recording. Refusing here
		// anyway means an unauthenticated message can never reach a tally,
		// whatever a future caller does.
		return false, false
	}

	key := voteKey{round: sm.Round, typ: sm.Type, signer: signer}
	// Commits are round-independent, so a validator's commit is one vote per
	// height however many rounds it is repeated in.
	if sm.Type == MsgCommit {
		key.round = 0
	}

	if previous, exists := rs.seen[key]; exists {
		if previous == sm.BlockHash {
			return false, false // ordinary duplicate; the transport is at-least-once
		}
		rs.faulty[signer] = true
		rs.withdraw(sm.Type, previous, signer)
		return false, true
	}

	rs.seen[key] = sm.BlockHash
	switch sm.Type {
	case MsgPrepare:
		rs.tally(rs.prepares, sm.BlockHash, signer, sm)
	case MsgCommit:
		rs.tally(rs.commits, sm.BlockHash, signer, sm)
	case MsgRoundChange:
		if rs.changes[sm.Round] == nil {
			rs.changes[sm.Round] = make(map[common.Address]*SignedMessage)
		}
		rs.changes[sm.Round][signer] = sm
	}
	return true, false
}

func (rs *roundState) tally(into map[common.Hash]map[common.Address]*SignedMessage, hash common.Hash, signer common.Address, sm *SignedMessage) {
	if into[hash] == nil {
		into[hash] = make(map[common.Address]*SignedMessage)
	}
	into[hash][signer] = sm
}

// withdraw removes a vote already counted, used when its sender is caught
// equivocating.
func (rs *roundState) withdraw(typ MsgType, hash common.Hash, signer common.Address) {
	switch typ {
	case MsgPrepare:
		delete(rs.prepares[hash], signer)
	case MsgCommit:
		delete(rs.commits[hash], signer)
	}
}

func (rs *roundState) prepareCount(hash common.Hash) int { return len(rs.prepares[hash]) }
func (rs *roundState) commitCount(hash common.Hash) int  { return len(rs.commits[hash]) }

// commitSignatures returns the seals for a block that reached quorum.
func (rs *roundState) commitSignatures(hash common.Hash) [][]byte {
	votes := rs.commits[hash]
	seals := make([][]byte, 0, len(votes))
	for _, sm := range votes {
		seals = append(seals, sm.Signature)
	}
	return seals
}

// lock records that this node has committed to a block at this height.
func (rs *roundState) lock(block *types.Block, round uint32) {
	rs.lockedBlock = block
	rs.lockedHash = block.Hash()
	rs.lockedRound = round
	rs.locked = true
}

// acceptableProposal reports whether this node may vote for hash at this
// height. Once locked, only the locked block is acceptable — this is the
// guard that makes an equivocating proposer's second block unable to gather
// prepares from anyone who already prepared the first.
func (rs *roundState) acceptableProposal(hash common.Hash) bool {
	return !rs.locked || rs.lockedHash == hash
}

// highestLock scans the round-change votes for round r and returns the block
// a new proposer is obliged to re-propose: the one locked in the highest
// round, if any validator reported a lock.
//
// This is what stops a round change from orphaning a block that some
// validator may already have committed. Without it, a new proposer could
// propose a fresh block at a height where another node was already locked,
// and the two would deadlock — the locked node refusing to prepare anything
// else, the rest unable to reach quorum without it.
func (rs *roundState) highestLock(r uint32) (common.Hash, []byte, bool) {
	var (
		best      common.Hash
		bestRLP   []byte
		bestRound uint32
		found     bool
	)
	for _, sm := range rs.changes[r] {
		if sm.LockedHash == (common.Hash{}) {
			continue
		}
		if !found || sm.LockedRound > bestRound {
			best, bestRLP, bestRound, found = sm.LockedHash, sm.BlockRLP, sm.LockedRound, true
		}
	}
	return best, bestRLP, found
}

// changeCount counts distinct validators asking to move to round r.
func (rs *roundState) changeCount(r uint32) int { return len(rs.changes[r]) }

// faultyAddresses lists validators caught equivocating at this height.
func (rs *roundState) faultyAddresses() []common.Address {
	out := make([]common.Address, 0, len(rs.faulty))
	for addr := range rs.faulty {
		out = append(out, addr)
	}
	return out
}

// enterRound advances to a new round at the same height.
//
// Prepares and the current proposal are cleared: they belonged to a round
// that failed, and a prepare is bound to its round by its signature anyway.
// Commits and the lock deliberately survive — commits are round-independent
// and still count toward the same quorum, and the lock is the safety
// invariant that must not be forgotten under any circumstances.
func (rs *roundState) enterRound(round uint32, proposer Validator, isSelf bool) {
	rs.round = round
	rs.proposer = proposer
	rs.isSelf = isSelf
	rs.ph = phaseIdle
	rs.proposal = nil
	rs.prepares = make(map[common.Hash]map[common.Address]*SignedMessage)
}
