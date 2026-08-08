package consensus

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"fmt"
	"math/big"
	"sync/atomic"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/rlp"
	"github.com/rs/zerolog/log"

	"zk-blockchain/internal/chain"
)

// ChainOps is everything the engine needs from the local chain.
// *chain.Sequencer satisfies it; the interface exists so the engine can be
// tested against a real chain but reasoned about without one.
type ChainOps interface {
	HeadInfo() (uint64, common.Hash, error)
	BuildCandidate(tx *types.Transaction) (*chain.Candidate, error)
	BuildEmptyCandidate(at *uint64) (*chain.Candidate, error)
	BuildSysOpCandidate(op *chain.SysOp) (*chain.Candidate, error)
	VerifyCandidate(block *types.Block) error
	ApplyExternalBlock(block *types.Block) error
	Subscribe(buf int) <-chan chain.NewBlockEvent
}

// Transport delivers signed consensus messages to the other validators.
//
// Broadcast excludes self: the engine feeds its own votes straight into its
// tally, so a message that looped back would be a duplicate the dedup map
// would have to absorb — harmless but confusing when reading a trace.
//
// It is deliberately fire-and-forget and returns no error. A consensus
// message is only worth delivering promptly; a stale one is worthless, and
// the recovery mechanism for a lost message is the round-change timer, not a
// retry queue. Making this fallible would invite callers to block the state
// machine on the network.
type Transport interface {
	Broadcast(msg *SignedMessage)
}

const (
	// defaultSubmitQueue bounds how many write requests may await consensus.
	// Back-pressure, not a mempool: nothing here is persisted or gossiped, so
	// a longer queue is only a longer list of clients waiting for the same
	// timeout.
	defaultSubmitQueue = 64
	// defaultInboxSize buffers inbound consensus messages. Lossy on overflow
	// by design — dropping a message costs at most one round timeout, whereas
	// blocking the P2P handler would cost the peer a 30-second request.
	defaultInboxSize = 512
	// maxRoundBackoff caps the round timer's growth. A linear backoff on a
	// chain whose entire election lasts minutes should never reach the point
	// where a human thinks it has hung.
	maxRoundBackoff = 30 * time.Second
	// maxFutureHeights bounds how far ahead messages are buffered while this
	// node catches up, so a peer that is far ahead cannot push it out of
	// memory.
	maxFutureHeights = 64
	// maxFuturePerHeight bounds buffered messages per future height.
	maxFuturePerHeight = 32
)

// Config configures an Engine.
type Config struct {
	ChainID    uint64
	Self       Validator
	Key        *ecdsa.PrivateKey
	Validators *ValidatorSet

	// RoundTimeout is the base round-change timer; the effective timeout
	// grows linearly with the round number.
	RoundTimeout time.Duration
	// SubmitTimeout is how long an RPC caller waits before being told the
	// transaction did not reach quorum. Must stay below the HTTP client
	// timeouts above it so the caller gets a typed error rather than a
	// socket hang-up.
	SubmitTimeout time.Duration

	Chain     ChainOps
	Seals     SealStore
	Transport Transport

	// CatchUp asks the follower to pull missing blocks. May be nil in tests.
	CatchUp func()

	// Now and NewTimer are test seams, so round timeouts are deterministic
	// rather than a sleep.
	Now      func() time.Time
	NewTimer func(time.Duration) *time.Timer
}

// Engine is the IBFT state machine.
//
// Everything reachable from outside it is either a channel send or an atomic
// read. All round state lives on the goroutine running Run; see roundState
// for why that is a correctness property and not a performance one.
type Engine struct {
	cfg Config
	vs  *ValidatorSet
	q   int

	inbox   chan *SignedMessage
	submits chan *submitRequest
	blocks  <-chan chain.NewBlockEvent

	rs *roundState

	// future buffers messages for heights beyond head+1.
	future map[uint64][]*SignedMessage

	// queue holds accepted-but-not-yet-included write requests, oldest first.
	queue []*submitRequest

	timer *time.Timer

	// Status snapshot, read by /health and zk_consensusStatus on other
	// goroutines. Atomics because those readers must never block the state
	// machine.
	stHeight   atomic.Uint64
	stRound    atomic.Uint32
	stProposer atomic.Value // string
	stSynced   atomic.Bool
	stFaulty   atomic.Value // []string
}

// submitRequest is one pending write.
type submitRequest struct {
	// build produces the candidate block. A closure rather than a
	// *types.Transaction so that evm_mine and hardhat_setBalance ride the
	// identical path — under consensus a validator may not seal outside the
	// protocol, dev method or not.
	build func(ChainOps) (*chain.Candidate, error)
	reply chan submitResult

	// candidate is the block currently proposed for this request, so the
	// engine can recognise its own transaction landing in a finalized block.
	candidate *chain.Candidate

	deadline time.Time
	// done guards against replying twice to a request that was both timed
	// out and finalized in the same instant.
	done bool
}

type submitResult struct {
	Candidate *chain.Candidate
	Err       error
}

// NewEngine validates the configuration and builds an Engine.
func NewEngine(cfg Config) (*Engine, error) {
	switch {
	case cfg.Validators == nil:
		return nil, fmt.Errorf("consensus: no validator set")
	case cfg.Key == nil:
		return nil, fmt.Errorf("consensus: no signing key")
	case cfg.Chain == nil:
		return nil, fmt.Errorf("consensus: no chain")
	case cfg.Seals == nil:
		return nil, fmt.Errorf("consensus: no seal store")
	case cfg.Transport == nil:
		return nil, fmt.Errorf("consensus: no transport")
	}
	if !cfg.Validators.Contains(cfg.Self.Address) {
		return nil, fmt.Errorf("consensus: this node (%s) is not in the validator set", cfg.Self)
	}

	if cfg.RoundTimeout <= 0 {
		cfg.RoundTimeout = 4 * time.Second
	}
	if cfg.SubmitTimeout <= 0 {
		cfg.SubmitTimeout = 3 * cfg.RoundTimeout
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.NewTimer == nil {
		cfg.NewTimer = time.NewTimer
	}

	e := &Engine{
		cfg:     cfg,
		vs:      cfg.Validators,
		q:       cfg.Validators.Quorum(),
		inbox:   make(chan *SignedMessage, defaultInboxSize),
		submits: make(chan *submitRequest, defaultSubmitQueue),
		future:  make(map[uint64][]*SignedMessage),
	}
	e.stProposer.Store("")
	e.stFaulty.Store([]string{})
	// Subscribe before Run so no block sealed between construction and the
	// loop starting is missed — the same ordering cmd/node already observes
	// for the block pusher.
	e.blocks = cfg.Chain.Subscribe(64)
	return e, nil
}

// Deliver hands an inbound consensus message to the engine. Non-blocking: a
// busy engine must never turn into slow HTTP responses for peers.
func (e *Engine) Deliver(msg *SignedMessage) {
	select {
	case e.inbox <- msg:
	default:
		log.Warn().
			Str("type", msg.Type.String()).
			Uint64("height", msg.Height).
			Msg("consensus inbox is full; dropping a message (the round timer will recover)")
	}
}

// Run drives the state machine until ctx is cancelled.
func (e *Engine) Run(ctx context.Context) {
	e.startHeightFromChain()

	for {
		select {
		case <-ctx.Done():
			e.failAllWaiters(ErrShuttingDown)
			e.stopTimer()
			return
		case req := <-e.submits:
			e.onSubmit(req)
		case msg := <-e.inbox:
			e.onMessage(msg)
		case ev := <-e.blocks:
			e.onHeadMoved(ev.Block.NumberU64())
		case <-e.timerC():
			e.onRoundTimeout()
		}
		e.expireWaiters()
		e.publishStatus()
	}
}

func (e *Engine) timerC() <-chan time.Time {
	if e.timer == nil {
		return nil // a nil channel blocks forever, which is the quiescent state
	}
	return e.timer.C
}

// --- height and round management ---

// startHeightFromChain reads the local head and starts consensus for the next
// block.
func (e *Engine) startHeightFromChain() {
	height, _, err := e.cfg.Chain.HeadInfo()
	if err != nil {
		log.Error().Err(err).Msg("consensus cannot read the chain head")
		return
	}
	e.startHeight(height + 1)
}

func (e *Engine) startHeight(height uint64) {
	proposer := e.vs.ProposerAt(height, 0)
	e.rs = newRoundState(height, 0, proposer, proposer.Address == e.cfg.Self.Address)

	// Replay anything buffered for this height, now that it is current.
	if buffered, ok := e.future[height]; ok {
		delete(e.future, height)
		for _, msg := range buffered {
			e.onMessage(msg)
		}
	}
	// Drop everything now in the past.
	for h := range e.future {
		if h <= height {
			delete(e.future, h)
		}
	}

	e.armTimerIfWorkPending()
	e.maybePropose()
}

// armTimerIfWorkPending implements the quiescence rule: a round timer runs
// only when there is something to make progress on.
//
// Without it, an idle cluster would round-change forever, rotating proposers
// and producing nothing — burning CPU and filling the log with warnings that
// mean nothing. With it, an idle BFT cluster is indistinguishable from an
// idle solo one: blocks exist only when someone writes, exactly as MASTER §3
// has always specified.
//
// "Something to make progress on" is any of four things, and the last is the
// one that keeps the rule from deadlocking the cluster:
//
//	a queued write        this node has work to propose
//	a proposal in flight  this node is mid-round and the round can fail
//	a lock                this node has committed and owes the height an outcome
//	peer activity         somebody else is trying to make progress here
//
// Without the fourth, a validator holding the only pending transaction would
// time out and call for a round change entirely alone: every other node,
// having nothing queued, would be running no timer, would never time out, and
// would never add its own vote. One request short of quorum, forever — and
// precisely in the case where one node has work and the proposer does not.
func (e *Engine) armTimerIfWorkPending() {
	rs := e.rs
	if len(e.queue) == 0 && rs.ph == phaseIdle && !rs.locked && !rs.peerActivity {
		e.stopTimer()
		return
	}
	e.armTimer()
}

func (e *Engine) armTimer() {
	e.stopTimer()
	// Linear backoff. Flat risks two validators round-changing in lockstep
	// indefinitely; doubling reaches minutes on a chain whose whole election
	// lasts minutes.
	d := e.cfg.RoundTimeout * time.Duration(1+e.rs.round)
	if d > maxRoundBackoff {
		d = maxRoundBackoff
	}
	e.timer = e.cfg.NewTimer(d)
	e.rs.timerArmed = true
	e.rs.deadline = e.cfg.Now().Add(d)
}

func (e *Engine) stopTimer() {
	if e.timer != nil {
		e.timer.Stop()
		e.timer = nil
	}
	if e.rs != nil {
		e.rs.timerArmed = false
	}
}

// onHeadMoved reacts to the chain head advancing, whether by this engine's
// own commit or by the follower catching up from a peer.
func (e *Engine) onHeadMoved(height uint64) {
	if e.rs == nil || height < e.rs.height {
		return
	}
	e.resolveWaiters(height)
	e.startHeight(height + 1)
}

// --- proposing ---

// maybePropose proposes when it is this node's turn and there is something to
// propose.
func (e *Engine) maybePropose() {
	rs := e.rs
	if rs == nil || !rs.isSelf || rs.ph != phaseIdle {
		return
	}
	// A validator that has just restarted must not propose at a height it has
	// not caught up to: everyone would drop the proposal and the round would
	// burn a timeout for nothing.
	if !e.stSynced.Load() && !e.checkSynced() {
		return
	}

	// A lock outranks the queue. If this node committed to a block at this
	// height in an earlier round, it must re-propose exactly that block —
	// some other validator may already have finalized it.
	if rs.locked {
		e.broadcastProposal(rs.lockedBlock)
		return
	}

	for len(e.queue) > 0 {
		req := e.queue[0]
		candidate, err := req.build(e.cfg.Chain)
		if err != nil {
			// The transaction cannot be included — it reverts, or its nonce
			// is wrong against the head as it now stands. That is the
			// caller's answer, and it is the same error solo mode would have
			// produced (MASTER §10 pitfall 2).
			e.reply(req, submitResult{Err: err})
			e.queue = e.queue[1:]
			continue
		}
		req.candidate = candidate
		e.broadcastProposal(candidate.Block)
		return
	}
}

func (e *Engine) broadcastProposal(block *types.Block) {
	rs := e.rs
	encoded, err := rlp.EncodeToBytes(block)
	if err != nil {
		log.Error().Err(err).Uint64("height", rs.height).Msg("cannot encode a block to propose")
		return
	}

	msg, err := Sign(e.cfg.ChainID, e.cfg.Key, Message{
		Type:      MsgProposal,
		Height:    rs.height,
		Round:     rs.round,
		BlockHash: block.Hash(),
		BlockRLP:  encoded,
	})
	if err != nil {
		log.Error().Err(err).Msg("cannot sign a proposal")
		return
	}

	log.Debug().
		Uint64("height", rs.height).
		Uint32("round", rs.round).
		Str("block", block.Hash().Hex()).
		Msg("proposing")

	rs.proposal = block
	e.cfg.Transport.Broadcast(msg)
	// The proposer prepares its own block: it built and executed it, so it
	// has already done the work a PREPARE attests to.
	e.castPrepare(block.Hash())
	e.armTimer()
}

// --- message handling ---

func (e *Engine) onMessage(sm *SignedMessage) {
	if e.rs == nil {
		return
	}

	switch {
	case sm.Height < e.rs.height:
		return // decided; nothing at a settled height can change
	case sm.Height > e.rs.height:
		// This node is behind. Buffer, and ask the follower to pull the gap.
		// Note what is *not* happening: the message is never tallied. A node
		// cannot vote at a height it has not reached, by construction rather
		// than by policy — which is the whole of the rejoin story (see
		// CONSENSUS.md).
		e.bufferFuture(sm)
		if e.cfg.CatchUp != nil {
			e.cfg.CatchUp()
		}
		return
	}

	// Verification happens here, on the engine's goroutine, after the cheap
	// height filter — so a peer cannot make this node spend ECDSA recoveries
	// on messages for heights it does not care about.
	signer, err := Verify(e.cfg.ChainID, e.vs, sm)
	if err != nil {
		log.Warn().Err(err).Str("type", sm.Type.String()).Uint64("height", sm.Height).Msg("rejecting a consensus message")
		return
	}

	accepted, equivocated := e.rs.record(sm)
	if equivocated {
		// CRITICAL matches internal/p2p/server.go's convention for
		// tamper evidence: this is never routine, and an operator grepping
		// for it should find every instance.
		log.Error().
			Str("CRITICAL", "equivocation").
			Str("validator", signer.Name).
			Str("address", signer.Address.Hex()).
			Uint64("height", sm.Height).
			Uint32("round", sm.Round).
			Str("type", sm.Type.String()).
			Msg("CRITICAL: a validator signed two different blocks for the same height and round; both of its votes are discarded")
		return
	}
	if !accepted {
		return // duplicate; the transport is at-least-once by design
	}

	// Somebody else is working on this height, so this node keeps a round
	// timer even with nothing of its own queued — see armTimerIfWorkPending.
	e.rs.peerActivity = true
	if !e.rs.timerArmed {
		e.armTimer()
	}

	switch sm.Type {
	case MsgProposal:
		e.onProposal(sm, signer)
	case MsgPrepare:
		e.onPrepare(sm)
	case MsgCommit:
		e.onCommit(sm)
	case MsgRoundChange:
		e.onRoundChange(sm)
	}
}

func (e *Engine) bufferFuture(sm *SignedMessage) {
	if len(e.future) >= maxFutureHeights {
		if _, tracked := e.future[sm.Height]; !tracked {
			return // already buffering as many distinct heights as is sane
		}
	}
	bucket := e.future[sm.Height]
	if len(bucket) >= maxFuturePerHeight {
		bucket = bucket[1:] // drop oldest
	}
	e.future[sm.Height] = append(bucket, sm)
}

func (e *Engine) onProposal(sm *SignedMessage, signer Validator) {
	rs := e.rs

	// Only the round's proposer may propose. Round-robin makes whose turn it
	// is a pure function of (height, round), so every honest validator agrees
	// and this is unambiguously the sender's error.
	if !e.vs.IsProposerAt(signer.Address, rs.height, sm.Round) {
		log.Warn().
			Str("from", signer.Name).
			Uint64("height", rs.height).
			Uint32("round", sm.Round).
			Str("expected", rs.proposer.Name).
			Msg("ignoring a proposal from a validator whose turn it is not")
		return
	}
	if sm.Round != rs.round {
		return // for a round this node has left or not yet reached
	}
	if rs.ph != phaseIdle {
		return // already voting on this round's proposal
	}

	// The lock. If this node has committed to a block at this height, it will
	// not vote for any other — which is what makes an equivocating proposer's
	// second block unable to gather prepares from anyone who prepared the
	// first, and therefore unable to reach quorum.
	if !rs.acceptableProposal(sm.BlockHash) {
		log.Warn().
			Uint64("height", rs.height).
			Str("locked", rs.lockedHash.Hex()).
			Str("offered", sm.BlockHash.Hex()).
			Msg("refusing a proposal that differs from the block this node is locked on")
		return
	}

	block, err := sm.Block()
	if err != nil {
		log.Warn().Err(err).Msg("rejecting an undecodable proposal")
		return
	}

	// Re-execute. This is the point of the whole design: a validator's vote
	// means "I ran this block myself and reproduced every value its header
	// commits to", never "the proposer says so". Same replay.go the auditor
	// and every replica use.
	if err := e.cfg.Chain.VerifyCandidate(block); err != nil {
		log.Error().Err(err).
			Str("from", signer.Name).
			Uint64("height", rs.height).
			Msg("refusing to prepare a proposal that failed re-execution")
		return
	}

	rs.proposal = block
	e.castPrepare(block.Hash())
	e.armTimer()
}

func (e *Engine) castPrepare(hash common.Hash) {
	rs := e.rs
	msg, err := Sign(e.cfg.ChainID, e.cfg.Key, Message{
		Type: MsgPrepare, Height: rs.height, Round: rs.round, BlockHash: hash,
	})
	if err != nil {
		log.Error().Err(err).Msg("cannot sign a prepare")
		return
	}
	rs.ph = phasePrePrepared
	rs.record(msg)
	e.cfg.Transport.Broadcast(msg)
	e.checkPrepareQuorum(hash)
}

func (e *Engine) onPrepare(sm *SignedMessage) {
	e.checkPrepareQuorum(sm.BlockHash)
}

// checkPrepareQuorum promotes this node to committed once a quorum of
// validators has attested that the proposal is valid.
func (e *Engine) checkPrepareQuorum(hash common.Hash) {
	rs := e.rs
	if rs.ph != phasePrePrepared || rs.proposal == nil || rs.proposal.Hash() != hash {
		return
	}
	if rs.prepareCount(hash) < e.q {
		return
	}

	// Lock first, broadcast second. The lock is what guarantees this node
	// will never vote for a different block at this height, and it must be
	// true before the commit that relies on it leaves the machine.
	rs.lock(rs.proposal, rs.round)
	rs.ph = phasePrepared

	msg, err := Sign(e.cfg.ChainID, e.cfg.Key, Message{
		Type: MsgCommit, Height: rs.height, Round: rs.round, BlockHash: hash,
	})
	if err != nil {
		log.Error().Err(err).Msg("cannot sign a commit")
		return
	}
	rs.record(msg)
	e.cfg.Transport.Broadcast(msg)
	e.checkCommitQuorum(hash)
}

func (e *Engine) onCommit(sm *SignedMessage) {
	e.checkCommitQuorum(sm.BlockHash)
}

// checkCommitQuorum finalizes once Q distinct validators have committed.
func (e *Engine) checkCommitQuorum(hash common.Hash) {
	rs := e.rs
	if rs.commitCount(hash) < e.q {
		return
	}

	block := rs.proposal
	if block == nil || block.Hash() != hash {
		if rs.locked && rs.lockedHash == hash {
			block = rs.lockedBlock
		}
	}
	if block == nil || block.Hash() != hash {
		// A quorum committed a block whose body this node never received.
		// The block is final and this node will get it from a peer over the
		// ordinary catch-up path, which re-executes it like any other.
		log.Warn().
			Uint64("height", rs.height).
			Str("block", hash.Hex()).
			Msg("a quorum committed a block this node does not hold; catching up")
		if e.cfg.CatchUp != nil {
			e.cfg.CatchUp()
		}
		return
	}

	e.finalize(block, rs.commitSignatures(hash))
}

// finalize records the certificate and commits the block.
func (e *Engine) finalize(block *types.Block, seals [][]byte) {
	rs := e.rs
	height, hash := block.NumberU64(), block.Hash()

	// Seals before the block, and outside persist's batch — see Store.Put for
	// the full argument. A node that cannot record why a block is final must
	// not adopt it, so a failure here abandons the height rather than
	// committing silently.
	if err := e.cfg.Seals.Put(height, hash, &CommitSeals{Round: rs.round, Seals: seals}); err != nil {
		log.Error().Err(err).Uint64("height", height).Msg("cannot record commit seals; not committing this block")
		return
	}

	// The same path a follower uses. ApplyExternalBlock re-executes the block
	// and is itself the compare-and-swap against the head as it stands right
	// now: it returns ErrBlockAlreadyApplied if someone else landed this
	// exact block, ErrForkDetected if a different one occupies the height,
	// *OutOfOrderError if this node fell behind. There is no input for which
	// it corrupts the chain, which is why no separate re-validation is done
	// here.
	err := e.cfg.Chain.ApplyExternalBlock(block)
	switch {
	case err == nil:
		log.Info().
			Uint64("height", height).
			Uint32("round", rs.round).
			Int("seals", len(seals)).
			Int("quorum", e.q).
			Str("block", hash.Hex()).
			Msg("block finalized")
	case isAlreadyApplied(err):
		// Already ours; a success.
	default:
		log.Error().Err(err).Uint64("height", height).Msg("failed to commit a block that reached quorum")
		return
	}

	e.resolveWaiters(height)
	e.startHeight(height + 1)
}

// --- round changes ---

// onRoundTimeout is the liveness mechanism: the current proposer has not
// produced a block anyone could commit, so ask everyone to move on.
func (e *Engine) onRoundTimeout() {
	rs := e.rs
	if rs == nil {
		return
	}
	next := rs.round + 1

	log.Warn().
		Uint64("height", rs.height).
		Uint32("round", rs.round).
		Str("proposer", rs.proposer.Name).
		Uint32("nextRound", next).
		Str("nextProposer", e.vs.ProposerAt(rs.height, next).Name).
		Msg("round timed out; calling for a round change")

	m := Message{Type: MsgRoundChange, Height: rs.height, Round: next}
	// A validator that has locked must say so, so the next proposer knows it
	// is obliged to re-propose that block rather than orphan it.
	if rs.locked {
		m.LockedRound = rs.lockedRound
		m.LockedHash = rs.lockedHash
		if encoded, err := rlp.EncodeToBytes(rs.lockedBlock); err == nil {
			m.BlockRLP = encoded
		}
	}

	msg, err := Sign(e.cfg.ChainID, e.cfg.Key, m)
	if err != nil {
		log.Error().Err(err).Msg("cannot sign a round change")
		return
	}
	rs.record(msg)
	e.cfg.Transport.Broadcast(msg)

	// Re-arm before the quorum check: if this node is alone in wanting a new
	// round, it must keep asking.
	e.armTimer()
	e.checkRoundChangeQuorum(next)
}

func (e *Engine) onRoundChange(sm *SignedMessage) {
	if sm.Round <= e.rs.round {
		return
	}
	e.checkRoundChangeQuorum(sm.Round)
}

// checkRoundChangeQuorum advances the round once Q validators agree the
// current one is not working.
//
// Requiring a quorum, rather than acting on the first request, is what stops
// a single faulty validator from being able to skip the schedule past an
// honest proposer at will.
func (e *Engine) checkRoundChangeQuorum(round uint32) {
	rs := e.rs
	if round <= rs.round || rs.changeCount(round) < e.q {
		return
	}

	proposer := e.vs.ProposerAt(rs.height, round)
	lockedHash, lockedRLP, hasLock := rs.highestLock(round)

	log.Info().
		Uint64("height", rs.height).
		Uint32("round", round).
		Str("proposer", proposer.Name).
		Bool("carriesLock", hasLock).
		Msg("advancing to a new round")

	rs.enterRound(round, proposer, proposer.Address == e.cfg.Self.Address)

	// A block locked by any validator in the quorum must be re-proposed, or
	// that validator would refuse to prepare anything else and the height
	// would deadlock. Adopt the lock locally if this node did not have it.
	if hasLock && !rs.locked && len(lockedRLP) > 0 {
		block := new(types.Block)
		if err := rlp.DecodeBytes(lockedRLP, block); err == nil && block.Hash() == lockedHash {
			rs.lock(block, round)
		}
	}

	e.armTimer()
	e.maybePropose()
}

// --- submissions ---

// SubmitTx implements rpc.Proposer: it runs a transaction through consensus
// and returns its receipt once the block containing it is final.
func (e *Engine) SubmitTx(tx *types.Transaction) (*types.Receipt, error) {
	candidate, err := e.submit(func(c ChainOps) (*chain.Candidate, error) { return c.BuildCandidate(tx) })
	if err != nil {
		return nil, err
	}
	return candidate.Receipt, nil
}

// MineEmptyBlock implements rpc.Proposer (evm_mine).
func (e *Engine) MineEmptyBlock() (*types.Block, error) {
	candidate, err := e.submit(func(c ChainOps) (*chain.Candidate, error) { return c.BuildEmptyCandidate(nil) })
	if err != nil {
		return nil, err
	}
	return candidate.Block, nil
}

// MineEmptyBlockAt implements rpc.Proposer (evm_mine with a timestamp).
func (e *Engine) MineEmptyBlockAt(timestamp uint64) (*types.Block, error) {
	candidate, err := e.submit(func(c ChainOps) (*chain.Candidate, error) {
		at := timestamp
		return c.BuildEmptyCandidate(&at)
	})
	if err != nil {
		return nil, err
	}
	return candidate.Block, nil
}

// SetBalance implements rpc.Proposer (hardhat_setBalance / anvil_setBalance).
func (e *Engine) SetBalance(addr common.Address, balance *big.Int) (*types.Block, error) {
	if balance == nil || balance.Sign() < 0 {
		return nil, fmt.Errorf("%w: balance must be non-negative, got %v", chain.ErrMalformedSysOp, balance)
	}
	op := &chain.SysOp{Kind: chain.SysOpSetBalance, Address: addr, Value: new(big.Int).Set(balance)}
	candidate, err := e.submit(func(c ChainOps) (*chain.Candidate, error) { return c.BuildSysOpCandidate(op) })
	if err != nil {
		return nil, err
	}
	return candidate.Block, nil
}

// submit queues a write and blocks until consensus finalizes it, rejects it,
// or the deadline passes.
//
// Every validator accepts a submission, whether or not it is this round's
// proposer. That is not a convenience: if only the proposer accepted writes,
// then killing the validator whose turn it is would leave nothing in flight
// to time out, so no round change would ever fire and the chain would freeze
// on a single failure — exactly the outcome this feature exists to prevent.
// A non-proposer queues the request, the round times out, the proposership
// rotates, and the transaction lands one round later.
func (e *Engine) submit(build func(ChainOps) (*chain.Candidate, error)) (*chain.Candidate, error) {
	// Fail fast on a transaction that cannot be included at all — a revert, a
	// bad nonce, a wrong chain id. The caller gets exactly the error solo
	// mode would have produced, before any peer is asked to vote on it.
	if _, err := build(e.cfg.Chain); err != nil {
		return nil, err
	}

	req := &submitRequest{
		build:    build,
		reply:    make(chan submitResult, 1),
		deadline: e.cfg.Now().Add(e.cfg.SubmitTimeout),
	}

	select {
	case e.submits <- req:
	default:
		return nil, ErrBusy
	}

	select {
	case res := <-req.reply:
		if res.Err != nil {
			return nil, res.Err
		}
		return res.Candidate, nil
	case <-time.After(e.cfg.SubmitTimeout):
		// The engine's own expireWaiters normally answers first; this is the
		// backstop for an engine that has stopped scheduling entirely.
		return nil, ErrConsensusTimeout
	}
}

func (e *Engine) onSubmit(req *submitRequest) {
	if len(e.queue) >= defaultSubmitQueue {
		e.reply(req, submitResult{Err: ErrBusy})
		return
	}
	e.queue = append(e.queue, req)
	e.armTimerIfWorkPending()
	e.maybePropose()
}

// resolveWaiters answers the request whose block just finalized.
func (e *Engine) resolveWaiters(height uint64) {
	remaining := e.queue[:0]
	for _, req := range e.queue {
		if req.candidate != nil && req.candidate.Block.NumberU64() == height {
			e.reply(req, submitResult{Candidate: req.candidate})
			continue
		}
		// Anything else stays queued and is rebuilt against the new head when
		// this node next proposes. A request whose block lost the height is
		// not an error to the client — it simply has not been mined yet.
		req.candidate = nil
		remaining = append(remaining, req)
	}
	e.queue = remaining
}

// expireWaiters fails requests whose deadline has passed, rather than leaving
// orphan waiters in the queue.
func (e *Engine) expireWaiters() {
	if len(e.queue) == 0 {
		return
	}
	now := e.cfg.Now()
	remaining := e.queue[:0]
	for _, req := range e.queue {
		if now.After(req.deadline) {
			e.reply(req, submitResult{Err: ErrConsensusTimeout})
			continue
		}
		remaining = append(remaining, req)
	}
	e.queue = remaining
}

func (e *Engine) failAllWaiters(err error) {
	for _, req := range e.queue {
		e.reply(req, submitResult{Err: err})
	}
	e.queue = nil
}

func (e *Engine) reply(req *submitRequest, res submitResult) {
	if req.done {
		return
	}
	req.done = true
	select {
	case req.reply <- res:
	default:
	}
}

// --- status ---

// checkSynced decides whether this node is caught up enough to propose.
//
// The gate on *voting* is the height window in onMessage and needs no flag.
// This is only about proposing: a just-restarted validator whose turn it is
// would otherwise propose at a stale height, be dropped by everyone, and burn
// a round timeout for nothing.
func (e *Engine) checkSynced() bool {
	height, _, err := e.cfg.Chain.HeadInfo()
	if err != nil {
		return false
	}
	synced := e.rs != nil && e.rs.height == height+1
	e.stSynced.Store(synced)
	return synced
}

// Status is a snapshot of the engine for /health and zk_consensusStatus.
type Status struct {
	Mode       string   `json:"mode"`
	Self       string   `json:"self"`
	Height     uint64   `json:"height"`
	Round      uint32   `json:"round"`
	Proposer   string   `json:"proposer"`
	Validators []string `json:"validators"`
	Quorum     int      `json:"quorum"`
	Synced     bool     `json:"synced"`
	Faulty     []string `json:"faulty"`
}

// Status reads the snapshot. Safe from any goroutine; never blocks the state
// machine.
func (e *Engine) Status() Status {
	names := make([]string, 0, e.vs.Size())
	for _, v := range e.vs.Members() {
		names = append(names, v.Name)
	}
	proposer, _ := e.stProposer.Load().(string)
	faulty, _ := e.stFaulty.Load().([]string)
	return Status{
		Mode:       "bft",
		Self:       e.cfg.Self.Name,
		Height:     e.stHeight.Load(),
		Round:      e.stRound.Load(),
		Proposer:   proposer,
		Validators: names,
		Quorum:     e.q,
		Synced:     e.stSynced.Load(),
		Faulty:     faulty,
	}
}

func (e *Engine) publishStatus() {
	if e.rs == nil {
		return
	}
	e.stHeight.Store(e.rs.height)
	e.stRound.Store(e.rs.round)
	e.stProposer.Store(e.rs.proposer.Name)

	faulty := make([]string, 0, len(e.rs.faulty))
	for _, addr := range e.rs.faultyAddresses() {
		if v, ok := e.vs.Lookup(addr); ok {
			faulty = append(faulty, v.Name)
		}
	}
	e.stFaulty.Store(faulty)
	e.checkSynced()
}

// isAlreadyApplied treats "this node already has exactly this block" as
// success, which it is: pushes and commits are both at-least-once, so a block
// arriving from a peer's push before this node's own commit path reaches it
// is routine.
func isAlreadyApplied(err error) bool {
	return errors.Is(err, chain.ErrBlockAlreadyApplied)
}
