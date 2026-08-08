package chain

import (
	"fmt"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core"
	"github.com/ethereum/go-ethereum/core/rawdb"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/core/vm"

	"zk-blockchain/internal/state"
)

// This file is the BFT consensus mode's build half: producing a block that
// has been fully executed but not committed to.
//
// Solo mode has no use for it. There, SubmitTx executes and seals in one
// critical section, because the node that executes is by definition the node
// that decides (MASTER §3, "one writer"). Under consensus that stops being
// true: a proposer executes a block, puts it to a vote, and may lose — the
// round may time out, another proposer may win the height, or its own
// proposal may be rejected. A block that loses must leave no trace.
//
// So the lifecycle splits in two:
//
//	BuildCandidate    execute, assemble, return — nothing durable
//	  …consensus…
//	ApplyExternalBlock  verify from scratch, then persist
//
// and note which function does the committing: the *existing* replica path,
// unchanged. Every validator, the proposer included, adopts a finalized block
// through ApplyExternalBlock, which re-executes it with replay.go and refuses
// anything whose state root does not follow from its contents.
//
// That means the proposer executes each transaction twice, and that cost is
// bought deliberately. It leaves exactly one durable write path in the whole
// codebase, so a block this node proposed and a block it received from a peer
// are indistinguishable on disk — which is why `cmd/audit` needs no new
// argument to keep passing under consensus, and why a proposer cannot commit
// a block that a follower would have rejected.

// MaxFutureDrift bounds how far ahead of a validator's own (dev-adjusted)
// clock a proposed block's timestamp may be.
//
// It is a liveness guard, not a safety one. Nothing about the chain's
// integrity depends on wall clock — replay re-executes using the header's
// *stored* timestamp, so a block dated 2099 verifies perfectly. What breaks
// is the application: Voting.sol's phase deadlines are block.timestamp
// comparisons, so a proposer that sealed a far-future block would expire
// every deadline in the election at once, and no later block could undo it
// (timestamps must strictly increase — MASTER §10 pitfall 7).
//
// 15s covers ordinary skew across a datacentre-local cluster with room to
// spare. A validator whose clock is further off than that has a configuration
// problem, and it is far better for that to surface as a refused proposal
// than as silently corrupted deadlines.
//
// The *lower* bound needs no code here: verifyLinkage already requires
// block.Time() > parent.Time(). Deliberately, no wall-clock check is added to
// verifyLinkage itself — it is shared with cmd/audit and with solo-mode
// replicas, which re-verify historical blocks long after the fact, and wall
// clock is not a property of the chain.
const MaxFutureDrift = 15 * time.Second

// Candidate is a block that has been executed but not persisted.
//
// Every field the block hash covers is final: the same transaction against
// the same head yields a block whose hash equals the one SubmitTx would have
// sealed (TestCandidateBlockHashMatchesTheSealedBlock). Nothing has been
// written to the chain database.
type Candidate struct {
	// Block is the executed, unsealed block.
	Block *types.Block
	// Receipt is the transaction's receipt, or nil for empty and system-op
	// candidates. It is returned to the RPC caller once — and only once —
	// consensus finalizes this block.
	Receipt *types.Receipt
	// Parent is the head this candidate was built on. The engine uses it to
	// notice cheaply that the head moved and the candidate needs rebuilding;
	// ApplyExternalBlock checks the same thing again, authoritatively, at
	// commit time.
	Parent common.Hash
}

// BuildCandidate validates and executes tx against the current head and
// returns the block it would seal — writing nothing durable.
//
// The error contract is SubmitTx's, exactly: *RevertError on a revert,
// *NonceError / *GasLimitError / ErrWrongChainID on validation. That identity
// is what lets a BFT node reject a bad transaction at submission time with
// the same JSON-RPC error object solo mode produces (MASTER §10 pitfalls 1
// and 2 — a reverting transaction is never mined and the caller gets the
// revert data), instead of discovering it three consensus phases later with
// no way to report it.
//
// s.mu is held for exactly as long as SubmitTx holds it — one EVM execution —
// and released before returning. It is emphatically *not* held across a
// consensus round; see internal/consensus for how the engine sequences its
// short critical sections against a head that may move between them.
func (s *Sequencer) BuildCandidate(tx *types.Transaction) (*Candidate, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	parent, err := s.currentHeader()
	if err != nil {
		return nil, err
	}

	ws, err := state.Writable(s.work(), parent.Root)
	if err != nil {
		return nil, err
	}
	// Same single-close discipline as SubmitTx: the success path closes
	// explicitly and flips closed, every failure path falls through here.
	closed := false
	defer func() {
		if !closed {
			_ = ws.TrieDB.Close()
		}
	}()

	from, err := validateTx(tx, s.chainCfg.ChainID, ws.StateDB, s.gasLimit)
	if err != nil {
		return nil, err
	}

	// peekTimestamp, not commitTimestamp: a pin set by
	// evm_setNextBlockTimestamp must survive a candidate that never gets
	// sealed, exactly as it survives a transaction that reverts. Only a block
	// that consensus actually finalizes consumes it.
	header := buildHeader(parent, s.gasLimit, s.peekTimestamp(parent.Time), nil)

	msg, err := core.TransactionToMessage(tx, types.LatestSignerForChainID(s.chainCfg.ChainID), header.BaseFee)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrWrongChainID, err)
	}

	ws.StateDB.SetTxContext(tx.Hash(), 0)

	// The EVM reads historical block hashes (BLOCKHASH) from the real
	// database, not the overlay — s.db, same as SubmitTx. Only the *writes*
	// are speculative.
	result, err := applyMessage(vm.Config{}, s.db, s.chainCfg, ws.StateDB, header, msg)
	if err != nil {
		return nil, err
	}
	if result.Failed() {
		return nil, &RevertError{Data: result.Revert()}
	}

	receipt := buildReceipt(tx, from, result, ws.StateDB, header.Number.Uint64(), header.Time)

	root, err := ws.Commit(header.Number.Uint64(), true, false)
	if err != nil {
		return nil, fmt.Errorf("commit state: %w", err)
	}
	if err := ws.TrieDB.Commit(root, false); err != nil {
		return nil, fmt.Errorf("commit trie: %w", err)
	}
	if err := ws.TrieDB.Close(); err != nil {
		return nil, fmt.Errorf("close trie db: %w", err)
	}
	closed = true

	return &Candidate{
		Block:   assembleBlock(header, root, types.Transactions{tx}, types.Receipts{receipt}),
		Receipt: receipt,
		Parent:  parent.Hash(),
	}, nil
}

// BuildEmptyCandidate is MineEmptyBlock's build half; at, when non-nil, pins
// the timestamp the way MineEmptyBlockAt does.
//
// It exists because under consensus a validator may not seal a block outside
// the protocol, dev method or not: a node that mined its own empty block
// would create a second block at a height its peers are voting on and fork
// the cluster on the spot. evm_mine therefore goes through consensus too.
func (s *Sequencer) BuildEmptyCandidate(at *uint64) (*Candidate, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	parent, err := s.currentHeader()
	if err != nil {
		return nil, err
	}

	timestamp := s.peekTimestamp(parent.Time)
	if at != nil {
		if *at <= parent.Time {
			return nil, fmt.Errorf("%w: requested %d, current block is %d", ErrTimestampNotIncreasing, *at, parent.Time)
		}
		timestamp = *at
	}

	header := buildHeader(parent, s.gasLimit, timestamp, nil)
	return &Candidate{
		Block:  assembleBlock(header, parent.Root, nil, nil),
		Parent: parent.Hash(),
	}, nil
}

// BuildSysOpCandidate is SetBalance's build half — see sealSysOpBlock for why
// a balance change must be a block rather than a bare StateDB write (MASTER
// §10 pitfall 10).
func (s *Sequencer) BuildSysOpCandidate(op *SysOp) (*Candidate, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	parent, err := s.currentHeader()
	if err != nil {
		return nil, err
	}

	ws, err := state.Writable(s.work(), parent.Root)
	if err != nil {
		return nil, err
	}
	closed := false
	defer func() {
		if !closed {
			_ = ws.TrieDB.Close()
		}
	}()

	if err := ApplySysOp(ws.StateDB, op); err != nil {
		return nil, err
	}

	extra := op.Encode()
	// Round-trip the encoding before anyone votes on it, for the same reason
	// sealSysOpBlock does it before sealing: a block whose ExtraData cannot
	// be parsed back is unreplayable, and every other validator would refuse
	// it during verification anyway. Failing here turns a guaranteed round
	// timeout into an immediate, legible error.
	if _, err := ParseSysOp(extra); err != nil {
		return nil, fmt.Errorf("refusing to propose an unparseable system op %q: %w", extra, err)
	}

	header := buildHeader(parent, s.gasLimit, s.peekTimestamp(parent.Time), extra)

	root, err := ws.Commit(header.Number.Uint64(), true, false)
	if err != nil {
		return nil, fmt.Errorf("commit state: %w", err)
	}
	if err := ws.TrieDB.Commit(root, false); err != nil {
		return nil, fmt.Errorf("commit trie: %w", err)
	}
	if err := ws.TrieDB.Close(); err != nil {
		return nil, fmt.Errorf("close trie db: %w", err)
	}
	closed = true

	return &Candidate{
		Block:  assembleBlock(header, root, nil, nil),
		Parent: parent.Hash(),
	}, nil
}

// VerifyCandidate re-executes a proposed block over the current head and
// reports whether every value its header commits to follows from its
// contents. It writes nothing durable and does not move the head.
//
// This is ApplyExternalBlock's verification half, using the same replay.go
// and returning the same *ReplayMismatch — a validator runs it before it
// PREPAREs, so a proposer cannot get an unexecutable block to quorum and
// wedge the chain at a height nobody can commit.
//
// The one check here that ApplyExternalBlock does not make is the future
// timestamp bound (MaxFutureDrift). It belongs at proposal time and nowhere
// else: it is a judgement about a block being offered *now*, whereas
// ApplyExternalBlock and cmd/audit also verify historical blocks, for which
// wall clock is meaningless.
func (s *Sequencer) VerifyCandidate(block *types.Block) error {
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

	// Cheap rejections before the expensive one: a block dated far in the
	// future is not worth executing.
	limit := uint64(time.Now().Add(s.devOffset).Add(MaxFutureDrift).Unix())
	if block.Time() > limit {
		return &ReplayMismatch{
			Block: number,
			Field: "timestamp",
			Got:   fmt.Sprintf("%d", block.Time()),
			Want:  fmt.Sprintf("<= %d (this validator's clock plus %s)", limit, MaxFutureDrift),
		}
	}

	parent, err := s.blockByHeader(head)
	if err != nil {
		return fmt.Errorf("reading the parent of block %d: %w", number, err)
	}
	if mismatch := verifyLinkage(block, parent); mismatch != nil {
		return mismatch
	}

	// work is the scratch overlay: this node is only deciding whether the
	// block is valid, not adopting it. If it later commits, ApplyExternalBlock
	// re-executes into the real database, which is what makes the derived
	// state this node's own.
	replayer := NewReplayer(s.db, s.work(), s.chainCfg)
	root, receipts, gasUsed, err := replayer.replayBlock(block, parent.Root())
	if err != nil {
		return err
	}
	if mismatch := verifyBlock(block, root, receipts, gasUsed); mismatch != nil {
		return mismatch
	}
	return nil
}
