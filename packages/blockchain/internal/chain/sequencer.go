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

	// devOffset shifts nextTimestamp's wall-clock read. M07's
	// evm_increaseTime/evm_setNextBlockTimestamp will mutate it via
	// SetDevOffset; M03 only carries the field (always zero) so those
	// methods have somewhere to write later without another struct-layout
	// change.
	devOffset time.Duration

	feed blockFeed
}

// New builds a Sequencer over an already-open database that already has a
// genesis block — cmd/node calls internal/state.EnsureGenesis before
// constructing a Sequencer, same ordering M02 already established.
func New(db ethdb.Database, chainCfg *params.ChainConfig, blockGasLimit uint64) *Sequencer {
	return &Sequencer{db: db, chainCfg: chainCfg, gasLimit: blockGasLimit}
}

// Subscribe registers for NewBlockEvents (M10 consumes this). buf sizes the
// channel's buffer; a slow subscriber misses events rather than blocking
// sealing — see blockFeed's doc comment in seal.go.
func (s *Sequencer) Subscribe(buf int) <-chan NewBlockEvent {
	return s.feed.subscribe(buf)
}

// SetDevOffset sets the wall-clock shift nextTimestamp applies. Unused
// until M07 wires up evm_increaseTime, but exercised directly by this
// package's own tests to prove nextTimestamp's monotonicity rule without
// a test needing to sleep past a real wall-clock second.
func (s *Sequencer) SetDevOffset(d time.Duration) {
	s.mu.Lock()
	s.devOffset = d
	s.mu.Unlock()
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

// HeaderByNumber looks up a historical header by block number. Exported for
// M04's eth_getBlockByNumber and for this package's own tests (e.g.
// asserting timestamps strictly increase across blocks).
func (s *Sequencer) HeaderByNumber(n uint64) (*types.Header, error) {
	hash := rawdb.ReadCanonicalHash(s.db, n)
	if hash == (common.Hash{}) {
		return nil, fmt.Errorf("block %d not found", n)
	}
	header := rawdb.ReadHeader(s.db, hash, n)
	if header == nil {
		return nil, fmt.Errorf("header %d not found", n)
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

	header := buildHeader(parent, s.gasLimit, s.devOffset)

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

// EstimateGas runs msg read-only against the current head and returns a
// 10%-padded version of the gas it actually used (M03 spec point 1's
// documented simple choice, not geth's binary-search estimator — nothing
// in this app depends on a tight estimate: the mobile app submits vote()
// with a fixed 15,000,000 gas limit regardless of what this returns,
// MASTER §2).
func (s *Sequencer) EstimateGas(msg CallMsg) (uint64, error) {
	header, err := s.currentHeader()
	if err != nil {
		return 0, err
	}

	statedb, err := state.At(s.db, header.Root)
	if err != nil {
		return 0, err
	}

	result, err := applyMessage(vm.Config{}, s.db, s.chainCfg, statedb, header, msg.toMessage(header.GasLimit))
	if err != nil {
		return 0, err
	}
	if result.Failed() {
		return 0, &RevertError{Data: result.Revert()}
	}

	estimate := result.UsedGas + result.UsedGas/10
	if estimate < result.UsedGas { // overflow guard; unreachable at real gas magnitudes, cheap to keep
		estimate = result.UsedGas
	}
	return estimate, nil
}

// MineEmptyBlock seals a block with zero transactions (used by M07's
// evm_mine). State does not change — the new header's Root is simply the
// parent's Root.
func (s *Sequencer) MineEmptyBlock() (*types.Block, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	parent, err := s.currentHeader()
	if err != nil {
		return nil, err
	}

	header := buildHeader(parent, s.gasLimit, s.devOffset)
	block, err := finalizeBlock(s.db, header, parent.Root, nil, nil)
	if err != nil {
		return nil, err
	}

	s.feed.publish(block)
	return block, nil
}
