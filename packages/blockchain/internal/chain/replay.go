package chain

import (
	"bytes"
	"errors"
	"fmt"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core"
	"github.com/ethereum/go-ethereum/core/rawdb"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/core/vm"
	"github.com/ethereum/go-ethereum/ethdb"
	"github.com/ethereum/go-ethereum/params"
	"github.com/ethereum/go-ethereum/trie"

	"zk-blockchain/internal/state"
)

// This file is M09's verification engine: rebuild the entire chain state
// from nothing but the stored block list, and check the result against what
// each block's header claims.
//
// It is the claim the whole "custom blockchain" story rests on. Anyone
// holding a copy of the data directory can re-derive every balance, every
// registered voter commitment and every tally from genesis, and prove the
// operator did not quietly rewrite history: state here is a pure function of
// the block list, and this is the function.
//
// It lives beside the sealing path rather than in a package of its own, and
// that is deliberate. Replay must execute transactions *exactly* the way the
// sequencer did — same EVM configuration, same block context, same receipt
// construction, same system-op semantics — so it calls the same unexported
// applyMessage/buildReceipt and the same exported ApplySysOp the sequencer
// uses. An audit tool that reimplemented any of those would eventually drift
// from the node and start reporting an honest chain as corrupt (or, far
// worse, the reverse). M07's TestChainWithSysOpBlocksReplaysToIdenticalRoot
// was the prototype for this; that test now drives this code instead of
// carrying its own copy.

// progressInterval is how often Replay reports progress, in blocks (M09
// deliverable 2: "per-1000-blocks progress").
const progressInterval = 1000

// ReplayResult summarises a completed replay.
type ReplayResult struct {
	// From and To are the inclusive block range that was re-executed. From
	// is 1 for a full audit (block 0 is genesis — there is nothing to
	// execute, only a hash to verify).
	From, To uint64
	// Blocks is how many blocks were re-executed, Transactions how many
	// transactions they contained in total.
	Blocks, Transactions uint64
	// GasUsed is the total gas consumed across every replayed block.
	GasUsed uint64
	// StateRoot is the state root after the last replayed block — equal to
	// block To's header root, since a mismatch would have aborted the replay.
	StateRoot common.Hash
}

// ReplayMismatch is the error a replay returns when a block's recomputed
// value disagrees with what the chain stored. It is a structured type rather
// than a formatted string because that disagreement *is* the audit's output:
// cmd/audit prints the block number and field verbatim, and a machine-
// readable --json summary carries the same three values.
type ReplayMismatch struct {
	// Block is the first block at which the chain failed to verify. Replay
	// stops there: every later block builds on this one's state, so
	// continuing would report a cascade of consequences instead of the cause.
	Block uint64
	// Field names what disagreed, using the JSON-RPC spelling an operator
	// would see in eth_getBlockByNumber output (stateRoot, receiptsRoot,
	// transactionsRoot, logsBloom, gasUsed, parentHash, timestamp, …).
	Field string
	// Got is the value the audit found, Want the value it required. Both are
	// pre-formatted, since they are hashes, numbers and blooms depending on
	// Field.
	//
	// The pair is deliberately named neutrally rather than
	// "replayed"/"stored". That framing fits the execution checks — where Got
	// really is re-execution's output and Want is what the header claims —
	// but not the structural ones: verifyLinkage compares one stored value
	// against another (this block's parent hash against the previous block's
	// actual hash), and nothing is replayed at all. Labelling those "replayed
	// vs stored" would send whoever debugs a linkage failure looking for a
	// bug in execution.
	Got, Want string
}

func (e *ReplayMismatch) Error() string {
	return fmt.Sprintf("block %d: %s mismatch: got %s, want %s", e.Block, e.Field, e.Got, e.Want)
}

// Replayer re-executes a stored chain and verifies each block against its
// header.
type Replayer struct {
	// src is the chain being audited. It is only ever read from: blocks,
	// receipts, canonical hashes, and (via applyMessage's block context) the
	// BLOCKHASH opcode's history lookups.
	src ethdb.Database
	// work is where re-execution's trie nodes are written. For cmd/audit it
	// is internal/storage's replay overlay — writes land in memory, reads
	// fall through to src — which is what keeps the audited data directory
	// untouched. Passing it in rather than constructing it here keeps this
	// package independent of internal/storage and lets tests supply a plain
	// scratch database.
	work     ethdb.Database
	chainCfg *params.ChainConfig

	progress func(block, to uint64)
}

// NewReplayer builds a Replayer over src, writing re-execution's trie nodes
// to work. work must be able to *read* src's historical trie nodes (an
// overlay, or src itself), since replaying from a block other than 1 starts
// at a state root only src knows about.
func NewReplayer(src, work ethdb.Database, chainCfg *params.ChainConfig) *Replayer {
	return &Replayer{src: src, work: work, chainCfg: chainCfg}
}

// OnProgress registers a callback invoked every progressInterval blocks with
// the block just verified and the target height. Optional; nil disables
// reporting.
func (r *Replayer) OnProgress(fn func(block, to uint64)) { r.progress = fn }

// Head returns the height of the chain being audited.
func (r *Replayer) Head() (uint64, error) {
	header, err := state.HeadHeader(r.src)
	if err != nil {
		return 0, err
	}
	return header.Number.Uint64(), nil
}

// Replay re-executes blocks from..to inclusive and verifies each one.
//
// from is clamped to 1: block 0 is genesis, which has no transactions to
// re-execute — its integrity is a matter of recomputing the genesis
// allocation, which internal/state.VerifyGenesis does and cmd/audit calls
// before getting here.
//
// The returned error is a *ReplayMismatch when the chain is internally
// inconsistent, and an ordinary error when it could not be read at all
// (missing block, undecodable system op, a transaction whose signature no
// longer recovers). Both mean "this chain does not verify"; only the first
// pinpoints a field.
func (r *Replayer) Replay(from, to uint64) (*ReplayResult, error) {
	if from == 0 {
		from = 1
	}

	parent, err := r.blockAt(from - 1)
	if err != nil {
		return nil, fmt.Errorf("reading the block before the replay range: %w", err)
	}

	result := &ReplayResult{From: from, To: to, StateRoot: parent.Root()}
	if to < from {
		// An empty range is not an error: `audit --from N` on a chain whose
		// head is N-1 has nothing to do and has found nothing wrong.
		result.To = from - 1
		return result, nil
	}

	parentRoot := parent.Root()
	for n := from; n <= to; n++ {
		block, err := r.blockAt(n)
		if err != nil {
			return nil, err
		}
		if mismatch := verifyLinkage(block, parent); mismatch != nil {
			return nil, mismatch
		}

		root, receipts, gasUsed, err := r.replayBlock(block, parentRoot)
		if err != nil {
			return nil, err
		}
		if mismatch := verifyBlock(block, root, receipts, gasUsed); mismatch != nil {
			return nil, mismatch
		}
		if mismatch := r.verifyStoredReceipts(block, receipts); mismatch != nil {
			return nil, mismatch
		}

		result.Blocks++
		result.Transactions += uint64(len(block.Transactions()))
		result.GasUsed += gasUsed
		result.StateRoot = root

		parent, parentRoot = block, root
		if r.progress != nil && n%progressInterval == 0 {
			r.progress(n, to)
		}
	}

	if r.progress != nil && to%progressInterval != 0 {
		r.progress(to, to)
	}
	return result, nil
}

// blockAt reads block n and checks that the header stored under the
// canonical hash really hashes to that hash. Without this check a tampered
// header would simply be replayed as authoritative — every subsequent
// comparison would be against the attacker's values.
func (r *Replayer) blockAt(n uint64) (*types.Block, error) {
	hash := rawdb.ReadCanonicalHash(r.src, n)
	if hash == (common.Hash{}) {
		return nil, fmt.Errorf("%w: block %d has no canonical hash", ErrBlockNotFound, n)
	}
	block := rawdb.ReadBlock(r.src, hash, n)
	if block == nil {
		return nil, fmt.Errorf("%w: block %d (%s) could not be read", ErrBlockNotFound, n, hash)
	}
	if got := block.Hash(); got != hash {
		return nil, &ReplayMismatch{Block: n, Field: "blockHash", Got: got.Hex(), Want: hash.Hex()}
	}
	return block, nil
}

// replayBlock re-executes one block over parentRoot and returns the state
// root it produces, the receipts it recomputes, and the gas it consumed.
//
// The state lifecycle mirrors Sequencer.SubmitTx exactly — Writable →
// mutate → Commit → TrieDB.Commit → TrieDB.Close, with a deferred close
// covering every failure path — so there is one lifecycle in this package,
// not two.
func (r *Replayer) replayBlock(block *types.Block, parentRoot common.Hash) (common.Hash, types.Receipts, uint64, error) {
	header := block.Header()
	number := header.Number.Uint64()

	ws, err := state.Writable(r.work, parentRoot)
	if err != nil {
		return common.Hash{}, nil, 0, fmt.Errorf("block %d: open state at %s: %w", number, parentRoot, err)
	}
	closed := false
	defer func() {
		if !closed {
			_ = ws.TrieDB.Close()
		}
	}()

	var (
		receipts   types.Receipts
		cumulative uint64
	)

	// The sysop-or-transactions fork is the entire replay rule (see
	// sysop.go): a block either carries transactions or encodes a system
	// operation in its extraData, never both.
	op, parseErr := ParseSysOp(header.Extra)
	switch {
	case parseErr == nil:
		if len(block.Transactions()) != 0 {
			return common.Hash{}, nil, 0, fmt.Errorf(
				"block %d carries a system operation %q *and* %d transactions; this chain never seals both",
				number, header.Extra, len(block.Transactions()))
		}
		if err := ApplySysOp(ws.StateDB, op); err != nil {
			return common.Hash{}, nil, 0, fmt.Errorf("block %d: apply system operation: %w", number, err)
		}

	case errors.Is(parseErr, ErrNotSysOp):
		for i, tx := range block.Transactions() {
			from, err := sender(r.chainCfg.ChainID, tx)
			if err != nil {
				return common.Hash{}, nil, 0, fmt.Errorf("block %d tx %d (%s): %w", number, i, tx.Hash(), err)
			}
			msg, err := core.TransactionToMessage(tx, types.LatestSignerForChainID(r.chainCfg.ChainID), header.BaseFee)
			if err != nil {
				return common.Hash{}, nil, 0, fmt.Errorf("block %d tx %d (%s): build message: %w", number, i, tx.Hash(), err)
			}

			// Same tagging the sequencer does, for the same reason: without
			// it the EVM's logs are attributed to the zero hash and
			// buildReceipt finds none, which would surface as a receipts-root
			// mismatch on every block that emitted an event.
			ws.StateDB.SetTxContext(tx.Hash(), i)

			result, err := applyMessage(vm.Config{}, r.src, r.chainCfg, ws.StateDB, header, msg)
			if err != nil {
				return common.Hash{}, nil, 0, fmt.Errorf("block %d tx %d (%s): %w", number, i, tx.Hash(), err)
			}
			if result.Failed() {
				// A transaction that reverts is never mined on this chain
				// (MASTER §10 pitfall 2), so finding a mined one that reverts
				// on replay means the block's state does not follow from its
				// contents.
				return common.Hash{}, nil, 0, &ReplayMismatch{
					Block: number, Field: "transactionStatus",
					Got:  fmt.Sprintf("tx %s reverted on replay", tx.Hash()),
					Want: "success (this chain does not mine reverting transactions)",
				}
			}

			cumulative += result.UsedGas
			receipt := buildReceipt(tx, from, result, ws.StateDB, number, header.Time)
			// Single-tx blocks make this equal to GasUsed today, but the
			// receipt trie encodes the cumulative figure, so it is tracked
			// across the loop rather than assumed.
			receipt.CumulativeGasUsed = cumulative
			receipts = append(receipts, receipt)
		}

	default:
		return common.Hash{}, nil, 0, fmt.Errorf("block %d: undecodable extra data %q: %w", number, header.Extra, parseErr)
	}

	root, err := ws.Commit(number, true, false)
	if err != nil {
		return common.Hash{}, nil, 0, fmt.Errorf("block %d: commit state: %w", number, err)
	}
	if err := ws.TrieDB.Commit(root, false); err != nil {
		return common.Hash{}, nil, 0, fmt.Errorf("block %d: commit trie: %w", number, err)
	}
	if err := ws.TrieDB.Close(); err != nil {
		return common.Hash{}, nil, 0, fmt.Errorf("block %d: close trie db: %w", number, err)
	}
	closed = true

	return root, receipts, cumulative, nil
}

// verifyLinkage checks the two properties that make the block list a chain
// rather than a set: each block names its parent and numbers itself one
// higher, and time moves strictly forward.
//
// The timestamp rule is not cosmetic here. Voting.sol's registration and
// voting deadlines are block.timestamp comparisons, so a chain with a
// non-increasing timestamp would let a vote be replayed into a phase it was
// not cast in — MASTER §10 pitfall 7.
func verifyLinkage(block, parent *types.Block) *ReplayMismatch {
	n := block.NumberU64()

	if got, want := block.ParentHash(), parent.Hash(); got != want {
		return &ReplayMismatch{Block: n, Field: "parentHash", Got: got.Hex(), Want: want.Hex()}
	}
	if want := parent.NumberU64() + 1; n != want {
		return &ReplayMismatch{Block: n, Field: "number",
			Got: fmt.Sprintf("%d", n), Want: fmt.Sprintf("%d", want)}
	}
	if block.Time() <= parent.Time() {
		return &ReplayMismatch{Block: n, Field: "timestamp",
			Got:  fmt.Sprintf("%d", block.Time()),
			Want: fmt.Sprintf("> %d (the parent's timestamp)", parent.Time())}
	}
	return nil
}

// verifyBlock compares everything re-execution recomputed against what the
// header commits to. Between them these cover the whole of a block's
// consensus content: which transactions it contained (transactionsRoot),
// what executing them did to the world (stateRoot), what they emitted
// (receiptsRoot, logsBloom) and what they cost (gasUsed).
func verifyBlock(block *types.Block, root common.Hash, receipts types.Receipts, gasUsed uint64) *ReplayMismatch {
	n := block.NumberU64()
	header := block.Header()

	if root != header.Root {
		return &ReplayMismatch{Block: n, Field: "stateRoot", Got: root.Hex(), Want: header.Root.Hex()}
	}
	if gasUsed != header.GasUsed {
		return &ReplayMismatch{Block: n, Field: "gasUsed",
			Got: fmt.Sprintf("%d", gasUsed), Want: fmt.Sprintf("%d", header.GasUsed)}
	}

	txRoot := types.EmptyRootHash
	receiptRoot := types.EmptyRootHash
	if txs := block.Transactions(); len(txs) > 0 {
		txRoot = types.DeriveSha(txs, trie.NewStackTrie(nil))
		receiptRoot = types.DeriveSha(receipts, trie.NewStackTrie(nil))
	}
	if txRoot != header.TxHash {
		return &ReplayMismatch{Block: n, Field: "transactionsRoot", Got: txRoot.Hex(), Want: header.TxHash.Hex()}
	}
	if receiptRoot != header.ReceiptHash {
		return &ReplayMismatch{Block: n, Field: "receiptsRoot", Got: receiptRoot.Hex(), Want: header.ReceiptHash.Hex()}
	}

	// The block bloom is the OR of its receipts' blooms — the same
	// computation finalizeBlock performs when sealing.
	var bloom types.Bloom
	for _, receipt := range receipts {
		for i := range bloom {
			bloom[i] |= receipt.Bloom[i]
		}
	}
	if bloom != header.Bloom {
		return &ReplayMismatch{Block: n, Field: "logsBloom",
			Got: fmt.Sprintf("%#x", bloom), Want: fmt.Sprintf("%#x", header.Bloom)}
	}
	return nil
}

// verifyStoredReceipts compares the receipts this node has on disk against
// the ones replay just recomputed.
//
// verifyBlock already proved the recomputed receipts hash to the header's
// receiptsRoot, so this is a check on the *database*, not on consensus: the
// receipt records that eth_getTransactionReceipt and eth_getLogs serve are
// stored separately from the header, and a corrupted or truncated one would
// hand a voter a receipt that does not match the block their vote is in
// while every root still verified.
//
// Only what the stored encoding actually contains is compared. go-ethereum's
// ReceiptForStorage is exactly three fields — PostStateOrStatus,
// CumulativeGasUsed and Logs — and everything else on a types.Receipt is
// reconstructed at read time from the transaction beside it (txlookup.go's
// deriveReceiptFields does the same job for the RPC layer). Comparing a
// derived field would either compare this file's arithmetic against itself
// or, worse, against a zero value that was never stored.
//
// *** Regression note (found by the first audit of a real chain) ***
// receipt.Type was in this list and had to be removed: it looks stored, and
// isn't. The audit failed at block 1 reporting 2 against 0 — a
// hardhat-deploy EIP-1559 deployment, where re-execution knows the type from
// the transaction and the stored record simply has no type field to hold it.
// The transaction's type is not left unchecked by dropping it here: the type
// byte is part of the transaction's own encoding, which the transactionsRoot
// comparison in verifyBlock covers.
func (r *Replayer) verifyStoredReceipts(block *types.Block, recomputed types.Receipts) *ReplayMismatch {
	n := block.NumberU64()
	stored := rawdb.ReadRawReceipts(r.src, block.Hash(), n)

	if len(stored) != len(recomputed) {
		return &ReplayMismatch{Block: n, Field: "storedReceipts",
			Got:  fmt.Sprintf("%d receipt(s) recomputed", len(recomputed)),
			Want: fmt.Sprintf("%d receipt(s) stored (unreadable or corrupt receipts read back as none)", len(stored))}
	}

	for i, want := range stored {
		have := recomputed[i]
		switch {
		case have.Status != want.Status:
			return &ReplayMismatch{Block: n, Field: fmt.Sprintf("receipt[%d].status", i),
				Got: fmt.Sprintf("%d", have.Status), Want: fmt.Sprintf("%d", want.Status)}
		case have.CumulativeGasUsed != want.CumulativeGasUsed:
			return &ReplayMismatch{Block: n, Field: fmt.Sprintf("receipt[%d].cumulativeGasUsed", i),
				Got: fmt.Sprintf("%d", have.CumulativeGasUsed), Want: fmt.Sprintf("%d", want.CumulativeGasUsed)}
		}
		if mismatch := compareLogs(n, i, have.Logs, want.Logs); mismatch != nil {
			return mismatch
		}
	}
	return nil
}

// compareLogs diffs one receipt's recomputed logs against the stored ones,
// field by field, and names the first difference precisely enough to act on.
func compareLogs(block uint64, receiptIndex int, have, want []*types.Log) *ReplayMismatch {
	field := func(format string, args ...any) string {
		return fmt.Sprintf("receipt[%d].%s", receiptIndex, fmt.Sprintf(format, args...))
	}

	if len(have) != len(want) {
		return &ReplayMismatch{Block: block, Field: field("logs"),
			Got: fmt.Sprintf("%d log(s)", len(have)), Want: fmt.Sprintf("%d log(s)", len(want))}
	}

	for i := range want {
		h, w := have[i], want[i]
		if h.Address != w.Address {
			return &ReplayMismatch{Block: block, Field: field("logs[%d].address", i),
				Got: h.Address.Hex(), Want: w.Address.Hex()}
		}
		if len(h.Topics) != len(w.Topics) {
			return &ReplayMismatch{Block: block, Field: field("logs[%d].topics", i),
				Got: fmt.Sprintf("%d topic(s)", len(h.Topics)), Want: fmt.Sprintf("%d topic(s)", len(w.Topics))}
		}
		for j := range w.Topics {
			if h.Topics[j] != w.Topics[j] {
				return &ReplayMismatch{Block: block, Field: field("logs[%d].topics[%d]", i, j),
					Got: h.Topics[j].Hex(), Want: w.Topics[j].Hex()}
			}
		}
		if !bytes.Equal(h.Data, w.Data) {
			return &ReplayMismatch{Block: block, Field: field("logs[%d].data", i),
				Got: fmt.Sprintf("%#x", h.Data), Want: fmt.Sprintf("%#x", w.Data)}
		}
	}
	return nil
}
