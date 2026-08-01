package chain

import (
	"fmt"
	"math/big"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/rawdb"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethdb"
	"github.com/ethereum/go-ethereum/trie"
)

// nextTimestamp picks the new block's header.Time: real wall-clock time
// (shifted by devOffset — zero until M07 wires up evm_increaseTime /
// evm_setNextBlockTimestamp), but never less than parent.Time+1. MASTER
// §10 pitfall 7: Voting.sol's phase deadlines depend on block.timestamp
// strictly increasing, and replicas re-execute using the header's *stored*
// timestamp, so this must be a pure function of (parent.Time, wall clock,
// devOffset) — nothing replica-local.
func nextTimestamp(parentTime uint64, devOffset time.Duration) uint64 {
	now := time.Now().Add(devOffset).Unix()
	if now < 0 {
		now = 0
	}
	if uint64(now) <= parentTime {
		return parentTime + 1
	}
	return uint64(now)
}

// buildHeader assembles every header field that does not depend on this
// block's execution outcome — GasUsed, Root, Bloom, TxHash, ReceiptHash are
// filled in afterward by finalizeBlock, once the transaction (if any) has
// actually run. Shanghai/Cancun/Prague are pinned active from block/time 0
// in internal/state.ChainConfig (MASTER §2/§3) unconditionally for this
// chain, so the withdrawals/blob/beacon-root/requests fields those forks
// require are populated unconditionally too — no per-block fork-activation
// check is needed the way a general-purpose chain builder would need one.
//
// timestamp is passed in already resolved rather than computed here (it was
// computed here through M06) because M07's evm_setNextBlockTimestamp makes
// the choice stateful: the pin it sets must be consumed exactly once, and
// only when a block is really sealed — see Sequencer.peekTimestamp /
// commitTimestamp. extra becomes the header's ExtraData: nil for every
// ordinary block, and a SysOp encoding for the system-op blocks
// hardhat_setBalance produces (sysop.go).
//
// *** If `go build` fails on RequestsHash: *** EIP-7685 (Prague) is the
// newest fork this chain activates, and `types.EmptyRequestsHash` is this
// file's least-certain identifier. Check
// `github.com/ethereum/go-ethereum/core/types` in $GOMODCACHE for v1.16.8's
// actual exported name (or compute it via whatever helper that version
// exports, e.g. types.CalcRequestsHash(nil)) and fix just this one line —
// nothing else in this file depends on it.
func buildHeader(parent *types.Header, gasLimit uint64, timestamp uint64, extra []byte) *types.Header {
	withdrawalsHash := types.EmptyWithdrawalsHash
	parentBeaconRoot := common.Hash{}
	excessBlobGas := uint64(0)
	blobGasUsed := uint64(0)
	requestsHash := types.EmptyRequestsHash

	return &types.Header{
		ParentHash:       parent.Hash(),
		UncleHash:        types.EmptyUncleHash,
		Coinbase:         common.Address{},
		Number:           new(big.Int).Add(parent.Number, big.NewInt(1)),
		GasLimit:         gasLimit,
		Time:             timestamp,
		Extra:            extra,
		MixDigest:        common.Hash{},
		Nonce:            types.BlockNonce{},
		Difficulty:       big.NewInt(0),
		BaseFee:          big.NewInt(0),
		WithdrawalsHash:  &withdrawalsHash,
		ParentBeaconRoot: &parentBeaconRoot,
		ExcessBlobGas:    &excessBlobGas,
		BlobGasUsed:      &blobGasUsed,
		RequestsHash:     &requestsHash,
	}
}

// finalizeBlock completes header (Root/Bloom/GasUsed/TxHash/ReceiptHash),
// assembles the block, back-fills each receipt/log's BlockHash (only
// knowable once the header — and therefore the block hash — is final;
// none of these fields are part of the receipt trie's RLP encoding per
// EIP-658, so setting them after hashing does not change Root/ReceiptHash;
// MASTER's "receipt fields viem awaits" pitfall 5), and persists
// block + receipts + canonical/head pointers atomically via a single rawdb
// batch (M03 spec point 4: "Persist atomically via rawdb batch").
//
// *** If `go build` fails around rawdb.Write*: *** these low-level
// persistence calls (WriteBlock, WriteReceipts, WriteCanonicalHash,
// WriteHeadBlockHash, WriteHeadHeaderHash, WriteTxLookupEntriesByBlock) are
// this file's other high-risk spot — verify their exact signatures against
// `github.com/ethereum/go-ethereum/core/rawdb` in $GOMODCACHE for v1.16.8.
func finalizeBlock(db ethdb.Database, header *types.Header, root common.Hash, txs types.Transactions, receipts types.Receipts) (*types.Block, error) {
	header.Root = root

	var gasUsed uint64
	var bloom types.Bloom
	for _, r := range receipts {
		gasUsed += r.GasUsed
		for i := range bloom {
			bloom[i] |= r.Bloom[i]
		}
	}
	header.GasUsed = gasUsed
	header.Bloom = bloom

	if len(txs) == 0 {
		header.TxHash = types.EmptyRootHash
		header.ReceiptHash = types.EmptyRootHash
	} else {
		header.TxHash = types.DeriveSha(txs, trie.NewStackTrie(nil))
		header.ReceiptHash = types.DeriveSha(receipts, trie.NewStackTrie(nil))
	}

	// Withdrawals must be a non-nil, empty slice — not nil. types.NewBlock
	// derives header.WithdrawalsHash from body.Withdrawals itself (found by
	// direct RLP inspection: a nil slice made it reset WithdrawalsHash back
	// to nil despite buildHeader pre-setting it, which produced a malformed
	// "present but empty" RLP list item once later optional fields forced
	// it to still occupy a slot). A non-nil empty slice is also the
	// semantically correct value: nil means "pre-Shanghai, no withdrawals
	// concept at all", empty-non-nil means "Shanghai active, zero
	// withdrawals in this block" — the latter is what this chain always is.
	body := &types.Body{Transactions: txs, Withdrawals: []*types.Withdrawal{}}
	block := types.NewBlock(header, body, receipts, trie.NewStackTrie(nil))
	blockHash := block.Hash()

	for i, r := range receipts {
		r.BlockHash = blockHash
		r.BlockNumber = block.Number()
		r.TransactionIndex = uint(i)
		for _, l := range r.Logs {
			l.BlockHash = blockHash
		}
	}

	if err := persist(db, block, receipts); err != nil {
		return nil, err
	}
	return block, nil
}

// persist writes block + receipts + the canonical/head pointers that make
// block the new chain head, all through one rawdb batch so a crash between
// writes can never leave the chain pointing at a block whose receipts (or
// vice versa) were never written.
func persist(db ethdb.Database, block *types.Block, receipts types.Receipts) error {
	batch := db.NewBatch()

	rawdb.WriteBlock(batch, block)
	rawdb.WriteReceipts(batch, block.Hash(), block.NumberU64(), receipts)
	rawdb.WriteCanonicalHash(batch, block.Hash(), block.NumberU64())
	rawdb.WriteHeadBlockHash(batch, block.Hash())
	rawdb.WriteHeadHeaderHash(batch, block.Hash())
	rawdb.WriteTxLookupEntriesByBlock(batch, block)

	if err := batch.Write(); err != nil {
		return fmt.Errorf("persist block %d (%s): %w", block.NumberU64(), block.Hash(), err)
	}
	return nil
}

// NewBlockEvent is published each time SubmitTx or MineEmptyBlock seals a
// new block. M10 (replication) subscribes to push sealed blocks to
// replicas; M03 only builds the plumbing — no subscriber exists yet.
type NewBlockEvent struct {
	Block *types.Block
}

// blockFeed is a minimal, mutex-protected multi-subscriber broadcaster.
// Sends are non-blocking: a subscriber that falls behind (its channel's
// buffer is full) simply misses events rather than stalling block
// production. MASTER §3's "single sequencer ⇒ no forks" design means a
// slow/disconnected replica catches up via M10's pull-based resync, not by
// replaying missed feed events, so dropping here is the correct choice, not
// a shortcut.
type blockFeed struct {
	mu   sync.Mutex
	subs []chan NewBlockEvent
}

// subscribe registers a new listener with the given buffer size. The
// returned channel is never closed by blockFeed (the Sequencer outlives
// every subscriber in this milestone); M10 is expected to manage its own
// subscription lifetime once it exists.
func (f *blockFeed) subscribe(buf int) <-chan NewBlockEvent {
	ch := make(chan NewBlockEvent, buf)
	f.mu.Lock()
	f.subs = append(f.subs, ch)
	f.mu.Unlock()
	return ch
}

func (f *blockFeed) publish(block *types.Block) {
	ev := NewBlockEvent{Block: block}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, ch := range f.subs {
		select {
		case ch <- ev:
		default:
		}
	}
}
