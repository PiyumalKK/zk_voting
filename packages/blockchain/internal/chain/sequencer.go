// Package chain is the node's sequencer: it validates incoming
// transactions, executes them against the current EVM state, and seals
// exactly one transaction per block (auto-mine, no mempool, no forks —
// MASTER §3). internal/rpc (M04/M05) is a thin JSON-RPC wrapper around the
// exported methods here; internal/p2p (M10) subscribes to Subscribe's block
// feed to push sealed blocks to replicas. Only this package and
// internal/state are allowed to import go-ethereum's core/vm and core/state
// packages directly (MASTER §4 package-boundary comment in
// internal/state/chainconfig.go).
package chain

import (
	"errors"
	"fmt"
	"math/big"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core"
	"github.com/ethereum/go-ethereum/core/rawdb"
	gethstate "github.com/ethereum/go-ethereum/core/state"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/core/vm"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethdb"
	"github.com/ethereum/go-ethereum/params"
	gethrpc "github.com/ethereum/go-ethereum/rpc"

	"zk-blockchain/internal/state"
)

// Sequencer is the node's single write path: it validates, executes, and
// seals every transaction into its own one-tx block. All mutation goes
// through mu, so SubmitTx/MineEmptyBlock never race each other; Call and
// EstimateGas take no lock — they run against an independently opened,
// disposable StateDB and never touch the head.
type Sequencer struct {
	db       ethdb.Database
	chainCfg *params.ChainConfig
	gasLimit uint64

	mu sync.Mutex

	// devOffset shifts nextTimestamp's wall-clock read. IncreaseTime (M07's
	// evm_increaseTime) accumulates into it; commitTimestamp rewrites it
	// after a pinned block so the clock continues forward from the pin
	// rather than snapping back to wall time.
	devOffset time.Duration
	// pinnedTime, when non-nil, is the exact timestamp the *next* sealed
	// block must carry (M07's evm_setNextBlockTimestamp). It is consumed by
	// commitTimestamp — i.e. only when a block is actually sealed, so a
	// transaction that reverts (and therefore mines nothing) leaves the pin
	// in place for the next attempt, matching Hardhat.
	pinnedTime *uint64

	feed blockFeed
}

// New builds a Sequencer over an already-open database that already has a
// genesis block — cmd/node calls internal/state.EnsureGenesis before
// constructing a Sequencer, same ordering M02 already established.
//
// The dev clock is seeded from the stored head (see seedDevClockFromHead)
// rather than left at zero, so restarting a node cannot make the chain
// appear to stall. Doing it here, instead of asking cmd/node to call a
// separate setup method, means every construction site — the node, the
// tests, M10's replicas — gets the behaviour without having to remember it.
func New(db ethdb.Database, chainCfg *params.ChainConfig, blockGasLimit uint64) *Sequencer {
	s := &Sequencer{db: db, chainCfg: chainCfg, gasLimit: blockGasLimit}
	s.seedDevClockFromHead()
	return s
}

// seedDevClockFromHead sets devOffset so the next block continues from
// where the stored head left off, when that head is ahead of wall clock
// (M09 deliverable 1).
//
// Why this is needed: devOffset lives only in memory, so a restart resets it
// to zero, while the blocks a previous run's evm_increaseTime jumped forward
// remain on disk. nextTimestamp then takes max(wall clock, parent+1) — and
// with the head hours or days in the future, wall clock always loses, so
// every block after the restart advances by exactly one second. A chain that
// had jumped a week ahead would need 604,800 blocks to catch up.
//
// That is not a hypothetical for this app. `yarn test:custom` (M08) pushes
// the chain days forward to cross Voting.sol's phase deadlines, and the M08
// gate deliberately leaves that data directory in place for M09's audit and
// for the frontend to use. Without seeding, the first restart afterwards
// would leave every subsequent election operating in one-second-per-block
// time — deadlines set relative to `block.timestamp` would then take
// thousands of blocks to expire rather than the seconds an operator expects.
//
// Hardhat does the same thing from the other direction: it seeds its clock
// from `initialDate` so a restarted in-memory chain resumes at a chosen
// time rather than snapping to now.
//
// A head *behind* wall clock needs no seeding — that is the ordinary case
// (nextTimestamp already picks wall clock) and forcing a negative offset
// would freeze the chain in the past. Failure to read a head is not an
// error: a database with no head yet has no time to seed from.
func (s *Sequencer) seedDevClockFromHead() {
	head, err := s.currentHeader()
	if err != nil {
		return
	}

	now := time.Now().Unix()
	if head.Time > uint64(maxDevOffsetSeconds)+uint64(now) {
		// Beyond what the offset can represent; SetDevOffset would clamp
		// anyway, and a head that far out is a corrupt timestamp rather than
		// a time jump worth honouring.
		return
	}
	ahead := int64(head.Time) - now
	if ahead <= 0 {
		return
	}
	// SetDevOffset applies the ±maxDevOffsetSeconds clamp, keeping the
	// "stored offset is always in range" invariant IncreaseTime's overflow
	// argument depends on.
	s.SetDevOffset(time.Duration(ahead) * time.Second)
}

// Subscribe registers for NewBlockEvents (M10 consumes this). buf sizes the
// channel's buffer; a slow subscriber misses events rather than blocking
// sealing — see blockFeed's doc comment in seal.go.
func (s *Sequencer) Subscribe(buf int) <-chan NewBlockEvent {
	return s.feed.subscribe(buf)
}

// SetDevOffset sets the wall-clock shift nextTimestamp applies, replacing
// whatever offset was there. IncreaseTime is the additive, RPC-facing
// version; this absolute setter is kept for this package's own tests, which
// use it to prove nextTimestamp's monotonicity rule without sleeping past a
// real wall-clock second.
// The offset is clamped to the same bound IncreaseTime enforces, so that
// "the stored offset is always within ±maxDevOffsetSeconds" is an invariant
// this type guarantees rather than one its callers have to remember —
// IncreaseTime's overflow argument depends on it.
func (s *Sequencer) SetDevOffset(d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()

	limit := time.Duration(maxDevOffsetSeconds) * time.Second
	switch {
	case d > limit:
		d = limit
	case d < -limit:
		d = -limit
	}
	s.devOffset = d
}

// maxDevOffsetSeconds bounds the dev clock shift at ~136 years in either
// direction. The bound exists so the seconds→time.Duration conversion
// (which multiplies by 1e9) cannot overflow int64 — 2^32 * 1e9 ≈ 4.3e18,
// comfortably inside int64's 9.2e18 ceiling. No legitimate use comes near
// it: the hardhat test suite's largest jump is a few days.
const maxDevOffsetSeconds = int64(1) << 32

// ErrDevOffsetOutOfRange means a requested time jump would push the dev
// clock past maxDevOffsetSeconds. Reported to the caller rather than
// silently clamped: a test that asks for an absurd jump has a bug, and
// quietly producing a different timestamp than requested is exactly the
// kind of failure that shows up much later as an unexplained phase-deadline
// mismatch in Voting.sol.
var ErrDevOffsetOutOfRange = errors.New("dev time offset out of range")

// IncreaseTime adds seconds to the dev clock offset and returns the new
// total offset in seconds — evm_increaseTime's semantics (M07 deliverable
// 1). Every block sealed afterward carries a timestamp shifted by the
// accumulated total, which is what the hardhat test suite relies on to push
// Voting.sol past its registration/voting deadlines.
//
// The total is *signed*, and returning it as such is not defensive
// programming — it is reachable. evm_increaseTime itself only moves time
// forward, but commitTimestamp is the offset's other writer, and pinning a
// block below wall clock leaves the offset deeply negative: this chain's
// genesis timestamp is 0, so `evm_setNextBlockTimestamp(1000)` is perfectly
// legal on a fresh chain and drives the offset to roughly minus the current
// Unix time. An earlier version of this method returned uint64 and reported
// 18446744071924556216 instead of -1784995400 in exactly that case.
// The offset is stored relative to wall clock, but the *guarantee* this
// method makes is relative to the chain: the next block will be at least
// `seconds` past the current head. Those differ whenever the head is
// already ahead of wall clock, which on a persistent chain is routine — an
// earlier run that jumped a day forward leaves the head a day ahead, and
// after a restart devOffset is back to zero while those blocks remain.
// Without the floor below, nextTimestamp's monotonicity rule (parent+1)
// silently swallows the whole jump.
//
// That is not theoretical: `make diff-dev` caught it as
// "our delta=1s hardhat delta=86400s" against a data directory left over
// from a previous run. Hardhat never hits it because its chain is
// in-memory and starts fresh every time — which is exactly the kind of
// divergence a differential harness exists to find.
func (s *Sequencer) IncreaseTime(seconds uint64) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if seconds > uint64(maxDevOffsetSeconds) {
		return 0, fmt.Errorf("%w: increment %d exceeds %d seconds", ErrDevOffsetOutOfRange, seconds, maxDevOffsetSeconds)
	}

	parent, err := s.currentHeader()
	if err != nil {
		return 0, err
	}

	// Both operands are bounded by maxDevOffsetSeconds (2^32) in magnitude —
	// the increment by the check above, the existing offset by SetDevOffset's
	// clamp and commitTimestamp's — so this addition cannot overflow int64.
	total := int64(s.devOffset/time.Second) + int64(seconds)

	// floor is the offset that would place the next block exactly `seconds`
	// past the head. Taking the maximum keeps plain accumulation intact when
	// the chain is near wall clock (the common case, where floor is smaller)
	// while making the jump effective when it is not.
	if floor := int64(parent.Time) + int64(seconds) - time.Now().Unix(); total < floor {
		total = floor
	}

	if total > maxDevOffsetSeconds || total < -maxDevOffsetSeconds {
		return 0, fmt.Errorf("%w: total offset %d is outside ±%d seconds (head is at %d, wall clock at %d)",
			ErrDevOffsetOutOfRange, total, maxDevOffsetSeconds, parent.Time, time.Now().Unix())
	}

	s.devOffset = time.Duration(total) * time.Second
	return total, nil
}

// DevOffsetSeconds reports the current dev clock offset in seconds.
// Exported for tests and for M14's swap-drill diagnostics; no RPC method
// returns it directly.
func (s *Sequencer) DevOffsetSeconds() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return int64(s.devOffset / time.Second)
}

// ErrTimestampNotIncreasing means a requested next-block timestamp is not
// strictly greater than the current head's. MASTER §10 pitfall 7 makes
// strictly-increasing timestamps a chain invariant (Voting.sol's phase
// deadlines depend on it), so this is rejected rather than clamped —
// Hardhat rejects the same request for the same reason.
var ErrTimestampNotIncreasing = errors.New("next block timestamp must be greater than the current block's")

// SetNextBlockTimestamp pins the exact timestamp the next sealed block will
// carry (evm_setNextBlockTimestamp, M07 deliverable 2). The pin survives
// until a block is actually sealed, so a reverted transaction — which mines
// nothing — does not consume it.
//
// Once the pinned block is sealed, commitTimestamp rewrites devOffset so
// that subsequent blocks continue forward *from the pinned time* instead of
// snapping back to wall clock. That is Hardhat's behavior and the reason
// mixing this method with evm_increaseTime behaves identically on both
// backends.
func (s *Sequencer) SetNextBlockTimestamp(ts uint64) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	parent, err := s.currentHeader()
	if err != nil {
		return err
	}
	if ts <= parent.Time {
		return fmt.Errorf("%w: requested %d, current block is %d", ErrTimestampNotIncreasing, ts, parent.Time)
	}

	pinned := ts
	s.pinnedTime = &pinned
	return nil
}

// peekTimestamp computes the timestamp the next block would carry without
// consuming a pin. Callers hold s.mu.
func (s *Sequencer) peekTimestamp(parentTime uint64) uint64 {
	if s.pinnedTime != nil {
		ts := *s.pinnedTime
		// SetNextBlockTimestamp already rejected a pin at or below the head,
		// but blocks can be sealed between the pin and its use; the
		// strictly-increasing invariant wins over the pin in that case.
		if ts <= parentTime {
			return parentTime + 1
		}
		return ts
	}
	return nextTimestamp(parentTime, s.devOffset)
}

// commitTimestamp consumes a pin once the block carrying it has actually
// been sealed, rolling devOffset forward so the dev clock continues from
// sealedTime rather than reverting to wall clock. A no-op when no pin was
// in effect. Callers hold s.mu.
func (s *Sequencer) commitTimestamp(sealedTime uint64) {
	if s.pinnedTime == nil {
		return
	}
	s.pinnedTime = nil

	delta := int64(sealedTime) - time.Now().Unix()
	// Clamp rather than error: the block is already sealed and durable at
	// this point, so there is nothing left to reject. Only a pin set
	// absurdly far from wall clock can reach either bound, and the clamp
	// still leaves the chain's own invariants (strictly increasing,
	// pure-function-of-header replay) intact.
	if delta > maxDevOffsetSeconds {
		delta = maxDevOffsetSeconds
	}
	if delta < -maxDevOffsetSeconds {
		delta = -maxDevOffsetSeconds
	}
	s.devOffset = time.Duration(delta) * time.Second
}

// currentHeader returns the chain head's header, mirroring
// internal/state.Height's rawdb access pattern exactly (M02, already
// proven working) rather than inventing a new one.
func (s *Sequencer) currentHeader() (*types.Header, error) {
	headHash := rawdb.ReadHeadHeaderHash(s.db)
	if headHash == (common.Hash{}) {
		return nil, errors.New("no head header found; has EnsureGenesis run?")
	}
	number, ok := rawdb.ReadHeaderNumber(s.db, headHash)
	if !ok {
		return nil, fmt.Errorf("header number for head hash %s not found", headHash)
	}
	header := rawdb.ReadHeader(s.db, headHash, number)
	if header == nil {
		return nil, fmt.Errorf("header %s not found", headHash)
	}
	return header, nil
}

// ErrBlockNotFound means the requested block number or hash has no
// canonical block on this chain. M04's eth_getBlockByNumber/ByHash use this
// (via errors.Is) to distinguish "no such block" — which the JSON-RPC spec
// says must return a null result, not an error — from a genuine failure.
var ErrBlockNotFound = errors.New("block not found")

// HeaderByNumber looks up a historical header by block number. Exported for
// M04's eth_getBlockByNumber and for this package's own tests (e.g.
// asserting timestamps strictly increase across blocks).
func (s *Sequencer) HeaderByNumber(n uint64) (*types.Header, error) {
	hash := rawdb.ReadCanonicalHash(s.db, n)
	if hash == (common.Hash{}) {
		return nil, fmt.Errorf("%w: block %d", ErrBlockNotFound, n)
	}
	header := rawdb.ReadHeader(s.db, hash, n)
	if header == nil {
		return nil, fmt.Errorf("%w: header for block %d", ErrBlockNotFound, n)
	}
	return header, nil
}

// headerForBlockNumber resolves the tag-or-number a JSON-RPC caller passes
// to eth_call/eth_estimateGas. This chain has no mempool and no
// safe/finalized-vs-latest distinction (single sequencer, no reorgs —
// MASTER §3), so pending/safe/finalized all resolve to the current head,
// matching MASTER §10 pitfall 4 ("map pending/safe/finalized -> latest").
func (s *Sequencer) headerForBlockNumber(bn gethrpc.BlockNumber) (*types.Header, error) {
	switch bn {
	case gethrpc.LatestBlockNumber, gethrpc.PendingBlockNumber, gethrpc.SafeBlockNumber, gethrpc.FinalizedBlockNumber:
		return s.currentHeader()
	case gethrpc.EarliestBlockNumber:
		return s.HeaderByNumber(0)
	default:
		if bn < 0 {
			return nil, fmt.Errorf("unsupported block tag %d", bn)
		}
		return s.HeaderByNumber(uint64(bn))
	}
}

// SubmitTx validates, executes, and — if execution did not revert — seals
// tx into a new block, returning its receipt. A revert produces no block at
// all (MASTER §10 pitfall 2; M03 spec §5): the caller gets a *RevertError
// carrying the revert data instead of a receipt, and the chain head does
// not move.
func (s *Sequencer) SubmitTx(tx *types.Transaction) (*types.Receipt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	parent, err := s.currentHeader()
	if err != nil {
		return nil, err
	}

	ws, err := state.Writable(s.db, parent.Root)
	if err != nil {
		return nil, err
	}
	// Every path out of this function must close ws.TrieDB exactly once.
	// The success path closes it explicitly (right after committing) and
	// sets closed=true so this deferred cleanup becomes a no-op; every
	// failure path (nothing durable was ever written for those) falls
	// through to this defer instead of duplicating the Close call at each
	// return site.
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

	// peekTimestamp, not commitTimestamp: an evm_setNextBlockTimestamp pin
	// must survive a transaction that reverts, since a revert mines no block
	// (see below). The pin is consumed only after finalizeBlock succeeds.
	header := buildHeader(parent, s.gasLimit, s.peekTimestamp(parent.Time), nil)

	msg, err := core.TransactionToMessage(tx, types.LatestSignerForChainID(s.chainCfg.ChainID), header.BaseFee)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrWrongChainID, err)
	}

	// StateDB tags every log AddLog records with whatever (tx hash, tx
	// index) SetTxContext last set — without this, logs the EVM actually
	// emits get attributed to the zero hash, and buildReceipt's
	// statedb.GetLogs(tx.Hash(), ...) below finds nothing (found by test:
	// TestThreeLogsHaveSequentialIndexAndBloomContainsAddress came back
	// with 0 logs instead of 3 until this was added). Single-tx blocks
	// make the index always 0.
	ws.StateDB.SetTxContext(tx.Hash(), 0)

	result, err := applyMessage(vm.Config{}, s.db, s.chainCfg, ws.StateDB, header, msg)
	if err != nil {
		return nil, err
	}
	if result.Failed() {
		// No block is sealed on revert (MASTER §10 pitfall 2) — ws.TrieDB
		// is closed by the deferred cleanup above, and nothing was ever
		// written to s.db, so the chain head is untouched.
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

	block, err := finalizeBlock(s.db, header, root, types.Transactions{tx}, types.Receipts{receipt})
	if err != nil {
		return nil, err
	}

	s.commitTimestamp(header.Time)
	s.feed.publish(block)
	return receipt, nil
}

// buildReceipt assembles tx's receipt from its execution result: status +
// cumulative gas from types.NewReceipt (single-tx blocks make
// CumulativeGasUsed == GasUsed trivially — M03 spec note), the deployed
// contract address when tx is a creation, the logs the EVM actually
// emitted, and this receipt's own bloom filter (the block-level bloom in
// the header is the OR of every receipt's bloom — computed in
// finalizeBlock, since a block can contain more than zero of these).
func buildReceipt(tx *types.Transaction, from common.Address, result *core.ExecutionResult, statedb *gethstate.StateDB, blockNumber uint64, blockTime uint64) *types.Receipt {
	receipt := types.NewReceipt(nil, result.Failed(), result.UsedGas)
	receipt.TxHash = tx.Hash()
	receipt.GasUsed = result.UsedGas
	receipt.Type = tx.Type()
	if tx.To() == nil {
		receipt.ContractAddress = crypto.CreateAddress(from, tx.Nonce())
	}
	// blockHash is unknown until the header is finalized (finalizeBlock
	// back-fills it) — GetLogs only needs blockNumber/blockTime to
	// annotate each log at this point.
	receipt.Logs = statedb.GetLogs(tx.Hash(), blockNumber, common.Hash{}, blockTime)
	receipt.Bloom = types.CreateBloom(receipt)
	return receipt
}

// Call runs msg read-only against the state at bn and returns its return
// data, or a *RevertError if it reverted. Used by eth_call (M04).
func (s *Sequencer) Call(msg CallMsg, bn gethrpc.BlockNumber) ([]byte, error) {
	header, err := s.headerForBlockNumber(bn)
	if err != nil {
		return nil, err
	}

	statedb, err := state.At(s.db, header.Root)
	if err != nil {
		return nil, err
	}

	result, err := applyMessage(vm.Config{}, s.db, s.chainCfg, statedb, header, msg.toMessage(header.GasLimit))
	if err != nil {
		return nil, err
	}
	if result.Failed() {
		return nil, &RevertError{Data: result.Revert()}
	}
	return result.Return(), nil
}

// EstimateGas returns the smallest gas limit msg can execute under, found by
// binary search — the same approach go-ethereum and Hardhat take.
//
// *** Why this is not `UsedGas * 1.1` (it was, through M07) ***
// core.ExecutionResult.UsedGas is reported *net of gas refunds*:
// TransitionDb applies st.refundGas() before computing it. But a transaction
// has to be *funded* with the gross amount to execute at all. EIP-3529 caps
// the refund at gross/5, so gross can be up to 1.25x the reported UsedGas —
// which a 1.1x pad cannot cover.
//
// That gap is not theoretical. It is what broke M08's contract test suite:
// Voting.resetElection() clears an array, a string and three slots, earning
// close to the maximum refund, so the estimate came back ~12% short and the
// transaction ran out of gas. Out-of-gas produces an *empty* revert, so all
// seven failures surfaced as a bare "execution reverted" with no decodable
// custom error — a symptom pointing nowhere near gas estimation.
//
// Padding to 1.25x would fix that specific case, but the refund cap is only
// one way a naive estimate can fall short (the 63/64 rule for nested calls
// is another), so this searches for the true minimum instead of guessing at
// a multiplier.
func (s *Sequencer) EstimateGas(msg CallMsg) (uint64, error) {
	header, err := s.currentHeader()
	if err != nil {
		return 0, err
	}

	statedb, err := state.At(s.db, header.Root)
	if err != nil {
		return 0, err
	}

	// execute runs msg under a specific gas limit against a snapshot, so
	// each trial starts from the same state the previous one did.
	execute := func(gas uint64) (*core.ExecutionResult, error) {
		trial := msg
		trial.Gas = gas
		snapshot := statedb.Snapshot()
		defer statedb.RevertToSnapshot(snapshot)
		return applyMessage(vm.Config{}, s.db, s.chainCfg, statedb, header, trial.toMessage(header.GasLimit))
	}

	hi := header.GasLimit
	if msg.Gas >= params.TxGas && msg.Gas < hi {
		hi = msg.Gas
	}

	// Run at the ceiling first: if it fails there, no smaller limit can help,
	// and the failure is worth reporting immediately with its revert data.
	result, err := execute(hi)
	if err != nil {
		return 0, err
	}
	if result.Failed() {
		if errors.Is(result.Err, vm.ErrOutOfGas) || errors.Is(result.Err, vm.ErrCodeStoreOutOfGas) {
			return 0, fmt.Errorf("gas required exceeds allowance (%d)", hi)
		}
		return 0, &RevertError{Data: result.Revert()}
	}

	// UsedGas is a valid lower bound: the execution above consumed at least
	// that much before refunds.
	lo := result.UsedGas - 1

	// Probe the analytical worst case before searching. gross <= net * 5/4
	// (EIP-3529's refund cap) and the 63/64 rule adds a little more for
	// nested calls, so net * (64*5)/(63*4) is above the answer for
	// essentially every real transaction. When the probe succeeds — the
	// overwhelmingly common case — the search range collapses from tens of
	// millions to a few thousand, which matters because the M08 suite calls
	// this before all ~220 of its transactions.
	// (Multiply before dividing: the other order loses hundreds of gas to
	// integer truncation. UsedGas is bounded by the block gas limit, so
	// UsedGas*320 cannot overflow uint64.)
	if probe := result.UsedGas * (64 * 5) / (63 * 4); probe > lo && probe < hi {
		if probeResult, probeErr := execute(probe); probeErr == nil && !probeResult.Failed() {
			hi = probe
		} else {
			lo = probe
		}
	}

	for lo+1 < hi {
		mid := lo + (hi-lo)/2
		// A trial below intrinsic gas fails before the EVM runs, returning a
		// Go error rather than a failed result; both mean "not enough gas".
		trialResult, trialErr := execute(mid)
		if trialErr != nil || trialResult.Failed() {
			lo = mid
		} else {
			hi = mid
		}
	}
	return hi, nil
}

// MineEmptyBlock seals a block with zero transactions (evm_mine, M07
// deliverable 3). State does not change — the new header's Root is simply
// the parent's Root — so unlike SetBalance below there is no StateDB to
// open or commit.
func (s *Sequencer) MineEmptyBlock() (*types.Block, error) {
	return s.mineEmpty(nil)
}

// MineEmptyBlockAt seals an empty block carrying exactly the given
// timestamp — evm_mine's optional timestamp argument.
//
// This exists instead of having the RPC layer call SetNextBlockTimestamp
// and then MineEmptyBlock, because those are two separate acquisitions of
// s.mu: a concurrent SubmitTx landing between them would consume the pin
// and this call would then seal at the wrong time. The JSON-RPC server
// handles requests concurrently, so that interleaving is reachable, not
// theoretical. Doing both under one lock makes "the block I just mined has
// the timestamp I asked for" true unconditionally.
func (s *Sequencer) MineEmptyBlockAt(timestamp uint64) (*types.Block, error) {
	return s.mineEmpty(&timestamp)
}

// mineEmpty is the shared body. at, when non-nil, pins this block's
// timestamp; the strictly-increasing invariant (MASTER §10 pitfall 7) is
// enforced against the head that is current *inside* the lock.
func (s *Sequencer) mineEmpty(at *uint64) (*types.Block, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	parent, err := s.currentHeader()
	if err != nil {
		return nil, err
	}

	// An explicit `at` overrides any pin already set by
	// evm_setNextBlockTimestamp, which is what Hardhat does — evm_mine's
	// timestamp argument is documented as setting the next block's time, not
	// as queueing behind an earlier request.
	var timestamp uint64
	if at != nil {
		if *at <= parent.Time {
			return nil, fmt.Errorf("%w: requested %d, current block is %d", ErrTimestampNotIncreasing, *at, parent.Time)
		}
		timestamp = *at
		s.pinnedTime = at
	} else {
		timestamp = s.peekTimestamp(parent.Time)
	}

	header := buildHeader(parent, s.gasLimit, timestamp, nil)
	block, err := finalizeBlock(s.db, header, parent.Root, nil, nil)
	if err != nil {
		return nil, err
	}

	// commitTimestamp consumes whichever pin was in effect (the caller's `at`,
	// staged into pinnedTime above, or one from an earlier
	// evm_setNextBlockTimestamp) and rolls the dev clock forward from it, so
	// that rule lives in exactly one place.
	s.commitTimestamp(header.Time)
	s.feed.publish(block)
	return block, nil
}

// SetBalance overwrites addr's balance and seals the change as a system-op
// block (hardhat_setBalance / anvil_setBalance, M07 deliverable 4). See
// sysop.go's package-level comment for why this cannot be a bare StateDB
// write: MASTER §10 pitfall 10 requires every state mutation to live inside
// a block so M09's audit replay and M10's replicas reproduce it.
//
// The returned block's header carries the operation in ExtraData and its
// Root already reflects the new balance, so eth_getBalance sees the change
// immediately after this returns.
func (s *Sequencer) SetBalance(addr common.Address, balance *big.Int) (*types.Block, error) {
	if balance == nil || balance.Sign() < 0 {
		return nil, fmt.Errorf("%w: balance must be non-negative, got %v", ErrMalformedSysOp, balance)
	}
	return s.sealSysOpBlock(&SysOp{Kind: SysOpSetBalance, Address: addr, Value: new(big.Int).Set(balance)})
}

// sealSysOpBlock applies op to a fresh writable state over the current head
// and seals the result as a zero-transaction block whose ExtraData encodes
// op. It mirrors SubmitTx's state lifecycle exactly (Writable → mutate →
// Commit → TrieDB.Commit → TrieDB.Close, with a deferred close covering
// every failure path) so there is one lifecycle to reason about, not two.
func (s *Sequencer) sealSysOpBlock(op *SysOp) (*types.Block, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	parent, err := s.currentHeader()
	if err != nil {
		return nil, err
	}

	ws, err := state.Writable(s.db, parent.Root)
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
	// Encoding is verified to round-trip *before* the block is sealed: a
	// block whose ExtraData cannot be parsed back is unreplayable, and
	// discovering that during an M09 audit — long after the fact, with the
	// block already durable — would be unrecoverable. Failing here instead
	// costs one parse per setBalance call and keeps the invariant "every
	// sysop block on this chain can be re-applied" true by construction.
	if _, err := ParseSysOp(extra); err != nil {
		return nil, fmt.Errorf("refusing to seal unparseable system op %q: %w", extra, err)
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

	block, err := finalizeBlock(s.db, header, root, nil, nil)
	if err != nil {
		return nil, err
	}

	s.commitTimestamp(header.Time)
	s.feed.publish(block)
	return block, nil
}
