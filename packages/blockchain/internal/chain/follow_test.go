package chain

import (
	"errors"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethdb"
	gethrpc "github.com/ethereum/go-ethereum/rpc"
)

// These tests attack M10's central claim from both sides, the same way
// replay_test.go attacks M09's: a replica fed an honest chain must end up
// bit-identical to the primary, and a replica fed a doctored block must
// refuse it — at that block, naming the field, without writing anything.
//
// The honest-path test deliberately reuses buildAuditFixtureChain, so the
// blocks a replica is asked to reproduce include every kind this node
// produces: contract creations, storage writes, log emissions, refund-heavy
// calls, empty blocks, system-op blocks, and the transactions that reverted
// and were therefore never mined at all.

// newReplica returns a second, empty chain with the same genesis as the
// primary — what a freshly provisioned replica has before it syncs.
//
// Genesis is deliberately *not* copied from the primary: every node derives
// it from configuration (internal/state.EnsureGenesis), which is why the two
// nodes agree on block 0 without exchanging it, and why ApplyExternalBlock
// refuses a pushed block 0 at all.
func newReplica(t *testing.T) (*Sequencer, ethdb.Database) {
	t.Helper()
	return newTestSequencer(t)
}

// pushAll copies blocks 1..head from src into dst the way the P2P layer
// does, one at a time, in order.
func pushAll(t *testing.T, src, dst *Sequencer, head uint64) {
	t.Helper()
	for n := uint64(1); n <= head; n++ {
		block, err := src.BlockByNumber(n)
		if err != nil {
			t.Fatalf("primary BlockByNumber(%d): %v", n, err)
		}
		if err := dst.ApplyExternalBlock(block); err != nil {
			t.Fatalf("replica ApplyExternalBlock(%d): %v", n, err)
		}
	}
}

// tamperHeader returns a copy of block whose header has been altered by
// mutate and whose body is untouched — a block that has been meddled with in
// transit, rather than a differently-built block.
//
// *** If `go build` fails here: *** Block.Body/Block.WithBody are the only
// go-ethereum identifiers used nowhere else in this tree, so a signature
// change in a future geth bump shows up at this line and nowhere else. In
// v1.16.8 they are `func (b *Block) Body() *Body` and
// `func (b *Block) WithBody(body Body) *Block`. types.NewBlock is not usable
// here: it recomputes TxHash and ReceiptHash from the body it is given,
// which would quietly repair part of the tampering under test.
func tamperHeader(t *testing.T, block *types.Block, mutate func(h *types.Header)) *types.Block {
	t.Helper()
	header := block.Header()
	mutate(header)
	return types.NewBlockWithHeader(header).WithBody(*block.Body())
}

// firstBlockWithATransaction returns the lowest-numbered block on seq that
// actually executed something — the interesting target for tamper tests,
// since an empty block's state root is just its parent's.
func firstBlockWithATransaction(t *testing.T, seq *Sequencer, head uint64) *types.Block {
	t.Helper()
	for n := uint64(1); n <= head; n++ {
		block, err := seq.BlockByNumber(n)
		if err != nil {
			t.Fatalf("BlockByNumber(%d): %v", n, err)
		}
		if len(block.Transactions()) > 0 {
			return block
		}
	}
	t.Fatal("no block on this chain contains a transaction")
	return nil
}

func TestReplicaReproducesThePrimaryChainBlockByBlock(t *testing.T) {
	primary, _ := buildAuditFixtureChain(t)
	head, err := primary.BlockNumber()
	if err != nil {
		t.Fatalf("primary BlockNumber: %v", err)
	}

	replica, _ := newReplica(t)
	pushAll(t, primary, replica, head)

	primaryHeight, primaryHash, err := primary.HeadInfo()
	if err != nil {
		t.Fatalf("primary HeadInfo: %v", err)
	}
	replicaHeight, replicaHash, err := replica.HeadInfo()
	if err != nil {
		t.Fatalf("replica HeadInfo: %v", err)
	}

	if replicaHeight != primaryHeight {
		t.Errorf("replica height = %d, primary height = %d", replicaHeight, primaryHeight)
	}
	// Equal head hashes mean equal headers, and the header commits to the
	// state root, so this single comparison covers the whole chain: every
	// block was re-executed locally and every re-execution agreed.
	if replicaHash != primaryHash {
		t.Errorf("replica head = %s, primary head = %s", replicaHash, primaryHash)
	}
}

// TestAReplicaChainPassesTheAuditor closes the loop between M09 and M10: the
// state a replica derived by following must itself be independently
// re-verifiable. If this ever fails while the test above passes, the replica
// has state that verifies against the primary's headers but not against its
// own stored blocks — an audit finding on a node nobody was auditing.
func TestAReplicaChainPassesTheAuditor(t *testing.T) {
	primary, _ := buildAuditFixtureChain(t)
	head, err := primary.BlockNumber()
	if err != nil {
		t.Fatalf("primary BlockNumber: %v", err)
	}

	replica, replicaDB := newReplica(t)
	pushAll(t, primary, replica, head)

	result, err := newTestReplayer(t, replica, replicaDB).Replay(1, head)
	if err != nil {
		t.Fatalf("auditing the replica's own chain failed: %v", err)
	}
	if result.Blocks != head {
		t.Errorf("audited %d blocks, want %d", result.Blocks, head)
	}

	primaryHead, err := primary.HeaderByNumber(head)
	if err != nil {
		t.Fatalf("primary HeaderByNumber(%d): %v", head, err)
	}
	if result.StateRoot != primaryHead.Root {
		t.Errorf("replica audit state root = %s, primary sealed root = %s", result.StateRoot, primaryHead.Root)
	}
}

// TestReplicaServesTheSameReceiptsAndLogsAsThePrimary is the reason
// annotateReceipts is shared with the sealing path. A replica serves the
// app's reads (MASTER §3), so a receipt or log fetched from a replica must
// be indistinguishable from the primary's — including the fields that are
// not part of any root and would therefore go unnoticed by every
// verification check in this file.
func TestReplicaServesTheSameReceiptsAndLogsAsThePrimary(t *testing.T) {
	primary, _ := buildAuditFixtureChain(t)
	head, err := primary.BlockNumber()
	if err != nil {
		t.Fatalf("primary BlockNumber: %v", err)
	}

	replica, _ := newReplica(t)
	pushAll(t, primary, replica, head)

	block := firstBlockWithATransaction(t, primary, head)
	txHash := block.Transactions()[0].Hash()

	primaryReceipt, primaryLoc, err := primary.ReceiptByTxHash(txHash)
	if err != nil {
		t.Fatalf("primary ReceiptByTxHash: %v", err)
	}
	replicaReceipt, replicaLoc, err := replica.ReceiptByTxHash(txHash)
	if err != nil {
		t.Fatalf("replica ReceiptByTxHash: %v", err)
	}

	if replicaReceipt.BlockHash != primaryReceipt.BlockHash {
		t.Errorf("receipt blockHash = %s, want %s", replicaReceipt.BlockHash, primaryReceipt.BlockHash)
	}
	if replicaReceipt.Status != primaryReceipt.Status {
		t.Errorf("receipt status = %d, want %d", replicaReceipt.Status, primaryReceipt.Status)
	}
	if replicaReceipt.GasUsed != primaryReceipt.GasUsed {
		t.Errorf("receipt gasUsed = %d, want %d", replicaReceipt.GasUsed, primaryReceipt.GasUsed)
	}
	if replicaReceipt.ContractAddress != primaryReceipt.ContractAddress {
		t.Errorf("receipt contractAddress = %s, want %s", replicaReceipt.ContractAddress, primaryReceipt.ContractAddress)
	}
	if replicaLoc.BlockNumber != primaryLoc.BlockNumber || replicaLoc.Index != primaryLoc.Index {
		t.Errorf("tx location = %+v, want %+v", replicaLoc, primaryLoc)
	}

	from := gethrpc.BlockNumber(1)
	to := gethrpc.BlockNumber(head)
	wholeChain := LogFilter{FromBlock: &from, ToBlock: &to}

	primaryLogs, err := primary.FilterLogs(wholeChain, 0)
	if err != nil {
		t.Fatalf("primary FilterLogs: %v", err)
	}
	replicaLogs, err := replica.FilterLogs(wholeChain, 0)
	if err != nil {
		t.Fatalf("replica FilterLogs: %v", err)
	}
	if len(primaryLogs) == 0 {
		t.Fatal("the fixture chain emitted no logs; this test would prove nothing")
	}
	if len(replicaLogs) != len(primaryLogs) {
		t.Fatalf("replica returned %d logs, primary returned %d", len(replicaLogs), len(primaryLogs))
	}
	for i := range primaryLogs {
		have, want := replicaLogs[i], primaryLogs[i]
		switch {
		case have.BlockHash != want.BlockHash:
			t.Errorf("log %d blockHash = %s, want %s", i, have.BlockHash, want.BlockHash)
		case have.BlockNumber != want.BlockNumber:
			t.Errorf("log %d blockNumber = %d, want %d", i, have.BlockNumber, want.BlockNumber)
		case have.TxHash != want.TxHash:
			t.Errorf("log %d txHash = %s, want %s", i, have.TxHash, want.TxHash)
		case have.Index != want.Index:
			t.Errorf("log %d index = %d, want %d", i, have.Index, want.Index)
		case have.Address != want.Address:
			t.Errorf("log %d address = %s, want %s", i, have.Address, want.Address)
		}
	}
}

// TestReplicaRejectsATamperedStateRoot is the tamper-evidence property. A
// primary that quietly rewrote state — crediting an extra vote, say — would
// have to publish a block whose root does not follow from its transactions,
// and every replica re-executes rather than copying.
func TestReplicaRejectsATamperedStateRoot(t *testing.T) {
	primary, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	to := common.HexToAddress("0x000000000000000000000000000000000000bEEF")
	if _, err := primary.SubmitTx(mustSignTx(t, key, big.NewInt(testChainID), 0, &to, big.NewInt(1), 21_000, nil)); err != nil {
		t.Fatalf("SubmitTx: %v", err)
	}

	honest, err := primary.BlockByNumber(1)
	if err != nil {
		t.Fatalf("BlockByNumber(1): %v", err)
	}
	forged := tamperHeader(t, honest, func(h *types.Header) {
		h.Root = common.HexToHash("0x3333333333333333333333333333333333333333333333333333333333333333")
	})

	replica, _ := newReplica(t)
	err = replica.ApplyExternalBlock(forged)

	var mismatch *ReplayMismatch
	if !errors.As(err, &mismatch) {
		t.Fatalf("ApplyExternalBlock error = %v, want a *ReplayMismatch", err)
	}
	if mismatch.Field != "stateRoot" {
		t.Errorf("mismatch field = %q, want stateRoot", mismatch.Field)
	}
	if mismatch.Block != 1 {
		t.Errorf("mismatch block = %d, want 1", mismatch.Block)
	}
	assertHeightUnchanged(t, replica, 0)
}

// TestReplicaRejectsASwappedTransaction covers the other direction of the
// same attack: keep the header the primary signed off on, replace what is
// inside the block. Re-execution produces a different world, so the header's
// state root no longer describes it.
func TestReplicaRejectsASwappedTransaction(t *testing.T) {
	primary, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	honestTo := common.HexToAddress("0x000000000000000000000000000000000000bEEF")
	if _, err := primary.SubmitTx(mustSignTx(t, key, big.NewInt(testChainID), 0, &honestTo, big.NewInt(1), 21_000, nil)); err != nil {
		t.Fatalf("SubmitTx: %v", err)
	}

	honest, err := primary.BlockByNumber(1)
	if err != nil {
		t.Fatalf("BlockByNumber(1): %v", err)
	}

	// Same sender, same nonce, same gas — so it executes cleanly — but the
	// value goes somewhere else. Nothing about this transaction is invalid;
	// it simply is not the one the header commits to.
	attackerTo := common.HexToAddress("0x000000000000000000000000000000000000dEaD")
	swapped := mustSignTx(t, key, big.NewInt(testChainID), 0, &attackerTo, big.NewInt(1), 21_000, nil)

	header := honest.Header()
	forged := types.NewBlockWithHeader(header).WithBody(types.Body{
		Transactions: types.Transactions{swapped},
		Withdrawals:  []*types.Withdrawal{},
	})

	replica, _ := newReplica(t)
	if err := replica.ApplyExternalBlock(forged); err == nil {
		t.Fatal("replica accepted a block whose transaction was swapped out")
	}
	assertHeightUnchanged(t, replica, 0)
}

// TestReplicaRejectsATamperedTimestamp guards MASTER §10 pitfall 7 across
// the wire. Voting.sol's registration and voting deadlines are
// block.timestamp comparisons, so a primary able to move a block backwards
// in time could place a vote in a phase it was not cast in.
func TestReplicaRejectsATamperedTimestamp(t *testing.T) {
	primary, _ := newTestSequencer(t)
	if _, err := primary.MineEmptyBlock(); err != nil {
		t.Fatalf("MineEmptyBlock: %v", err)
	}

	honest, err := primary.BlockByNumber(1)
	if err != nil {
		t.Fatalf("BlockByNumber(1): %v", err)
	}
	genesis, err := primary.HeaderByNumber(0)
	if err != nil {
		t.Fatalf("HeaderByNumber(0): %v", err)
	}
	frozen := tamperHeader(t, honest, func(h *types.Header) { h.Time = genesis.Time })

	replica, _ := newReplica(t)
	err = replica.ApplyExternalBlock(frozen)

	var mismatch *ReplayMismatch
	if !errors.As(err, &mismatch) {
		t.Fatalf("ApplyExternalBlock error = %v, want a *ReplayMismatch", err)
	}
	if mismatch.Field != "timestamp" {
		t.Errorf("mismatch field = %q, want timestamp", mismatch.Field)
	}
	assertHeightUnchanged(t, replica, 0)
}

// TestReplicaReportsTheBlockItNeedsWhenPushedOutOfOrder: a push that arrives
// with a gap is not an error condition to alarm about — a replica that was
// briefly down simply missed some — but the response has to carry enough
// information for the replica to heal itself, which is the height it needs
// next.
func TestReplicaReportsTheBlockItNeedsWhenPushedOutOfOrder(t *testing.T) {
	primary, _ := newTestSequencer(t)
	for i := 0; i < 3; i++ {
		if _, err := primary.MineEmptyBlock(); err != nil {
			t.Fatalf("MineEmptyBlock: %v", err)
		}
	}

	third, err := primary.BlockByNumber(3)
	if err != nil {
		t.Fatalf("BlockByNumber(3): %v", err)
	}

	replica, _ := newReplica(t)
	err = replica.ApplyExternalBlock(third)

	var outOfOrder *OutOfOrderError
	if !errors.As(err, &outOfOrder) {
		t.Fatalf("ApplyExternalBlock error = %v, want an *OutOfOrderError", err)
	}
	if outOfOrder.Offered != 3 {
		t.Errorf("offered = %d, want 3", outOfOrder.Offered)
	}
	if outOfOrder.Expected != 1 {
		t.Errorf("expected = %d, want 1", outOfOrder.Expected)
	}
	assertHeightUnchanged(t, replica, 0)
}

// TestReplicaTreatsADuplicatePushAsAlreadyApplied: the primary's push queue
// retries, so the same block arriving twice is routine. It must be a
// recognisable success — if it were reported as a conflict, every retry
// after a slow-but-successful delivery would look like tampering.
func TestReplicaTreatsADuplicatePushAsAlreadyApplied(t *testing.T) {
	primary, _ := newTestSequencer(t)
	if _, err := primary.MineEmptyBlock(); err != nil {
		t.Fatalf("MineEmptyBlock: %v", err)
	}
	block, err := primary.BlockByNumber(1)
	if err != nil {
		t.Fatalf("BlockByNumber(1): %v", err)
	}

	replica, _ := newReplica(t)
	if err := replica.ApplyExternalBlock(block); err != nil {
		t.Fatalf("first push: %v", err)
	}
	if err := replica.ApplyExternalBlock(block); !errors.Is(err, ErrBlockAlreadyApplied) {
		t.Fatalf("second push error = %v, want ErrBlockAlreadyApplied", err)
	}
	assertHeightUnchanged(t, replica, 1)
}

// TestReplicaDetectsAForkAtAnAlreadyAppliedHeight: two different blocks at
// the same height cannot both be honest on a single-sequencer chain. The
// replica keeps what it has and reports the conflict — overwriting would
// destroy the only evidence that history was rewritten.
func TestReplicaDetectsAForkAtAnAlreadyAppliedHeight(t *testing.T) {
	primaryA, _ := newTestSequencer(t)
	if _, err := primaryA.MineEmptyBlock(); err != nil {
		t.Fatalf("chain A MineEmptyBlock: %v", err)
	}
	blockA, err := primaryA.BlockByNumber(1)
	if err != nil {
		t.Fatalf("chain A BlockByNumber(1): %v", err)
	}

	// A second chain over the same genesis, whose block 1 contains a
	// transaction and therefore hashes differently.
	primaryB, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	to := common.HexToAddress("0x000000000000000000000000000000000000bEEF")
	if _, err := primaryB.SubmitTx(mustSignTx(t, key, big.NewInt(testChainID), 0, &to, big.NewInt(1), 21_000, nil)); err != nil {
		t.Fatalf("chain B SubmitTx: %v", err)
	}
	blockB, err := primaryB.BlockByNumber(1)
	if err != nil {
		t.Fatalf("chain B BlockByNumber(1): %v", err)
	}
	if blockA.Hash() == blockB.Hash() {
		t.Fatal("the two fixture chains produced the same block 1; this test would prove nothing")
	}

	replica, _ := newReplica(t)
	if err := replica.ApplyExternalBlock(blockA); err != nil {
		t.Fatalf("applying chain A's block 1: %v", err)
	}
	if err := replica.ApplyExternalBlock(blockB); !errors.Is(err, ErrForkDetected) {
		t.Fatalf("applying chain B's block 1: error = %v, want ErrForkDetected", err)
	}

	// The block it already had is the one it kept.
	_, headHash, err := replica.HeadInfo()
	if err != nil {
		t.Fatalf("HeadInfo: %v", err)
	}
	if headHash != blockA.Hash() {
		t.Errorf("head = %s, want chain A's block %s", headHash, blockA.Hash())
	}
}

// TestReplicaRefusesAPushedGenesisBlock: genesis defines the prefunded
// accounts (MASTER §3). Every node derives it from its own configuration, so
// accepting one over the wire would let a primary hand a replica a different
// starting world.
func TestReplicaRefusesAPushedGenesisBlock(t *testing.T) {
	primary, _ := newTestSequencer(t)
	genesis, err := primary.BlockByNumber(0)
	if err != nil {
		t.Fatalf("BlockByNumber(0): %v", err)
	}

	replica, _ := newReplica(t)
	if err := replica.ApplyExternalBlock(genesis); !errors.Is(err, ErrGenesisPush) {
		t.Fatalf("error = %v, want ErrGenesisPush", err)
	}
}

// TestFollowingDoesNotDisturbTheDevClock: a replica never seals, so
// following must not move its sequencing clock. If it did, promoting a
// replica (or a misconfigured node that both follows and seals) would
// produce timestamps derived from the wrong offset.
func TestFollowingDoesNotDisturbTheDevClock(t *testing.T) {
	primary, _ := newTestSequencer(t)
	if _, err := primary.MineEmptyBlock(); err != nil {
		t.Fatalf("MineEmptyBlock: %v", err)
	}
	block, err := primary.BlockByNumber(1)
	if err != nil {
		t.Fatalf("BlockByNumber(1): %v", err)
	}

	replica, _ := newReplica(t)
	before := replica.DevOffsetSeconds()
	if err := replica.ApplyExternalBlock(block); err != nil {
		t.Fatalf("ApplyExternalBlock: %v", err)
	}
	if after := replica.DevOffsetSeconds(); after != before {
		t.Errorf("dev offset moved from %d to %d while following", before, after)
	}
}

func assertHeightUnchanged(t *testing.T, seq *Sequencer, want uint64) {
	t.Helper()
	height, err := seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}
	if height != want {
		t.Errorf("chain height = %d, want %d (a rejected block must leave no trace)", height, want)
	}
}
