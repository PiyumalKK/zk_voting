package chain

import (
	"errors"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/rawdb"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethdb"

	"zk-blockchain/internal/state"
	"zk-blockchain/internal/storage"
)

// M09's central claim is that this chain's state is a pure function of its
// block list. These tests attack that claim from both sides: an honest chain
// must verify end to end, and a chain whose stored data has been altered
// must be reported at the block where the alteration is, not later and not
// as a vague failure.

// buildAuditFixtureChain seals a chain that exercises every kind of block
// this node produces: contract creations, storage-mutating calls,
// log-emitting calls, storage-clearing calls (the EIP-3529 refund path),
// empty blocks, system-op blocks, and transactions that revert and are
// therefore never mined at all.
//
// M09's spec asks for a 50-block chain; the loop below produces comfortably
// more than that, and the test asserts the floor so a future edit that
// shrinks the fixture is caught rather than silently weakening every test in
// this file.
func buildAuditFixtureChain(t *testing.T) (*Sequencer, ethdb.Database) {
	t.Helper()

	seq, db := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)

	nonce := uint64(0)
	submit := func(tx *types.Transaction) {
		t.Helper()
		if _, err := seq.SubmitTx(tx); err != nil {
			t.Fatalf("SubmitTx(nonce %d): %v", nonce, err)
		}
		nonce++
	}
	call := func(to common.Address, data []byte) {
		t.Helper()
		submit(mustSignTx(t, key, chainID, nonce, &to, big.NewInt(0), 500_000, data))
	}

	_, counter := deploy(t, seq, key, chainID, nonce, counterRuntime())
	nonce++
	_, logger := deploy(t, seq, key, chainID, nonce, logRuntime())
	nonce++
	_, reverter := deploy(t, seq, key, chainID, nonce, revertRuntime())
	nonce++
	_, churn := deploy(t, seq, key, chainID, nonce, storageChurnRuntime())
	nonce++

	// One block of each non-legacy transaction type. Real deployments arrive
	// as EIP-1559 (ethers v6 / hardhat-deploy) while the mobile app sends
	// legacy, so a fixture made only of legacy transactions is not
	// representative — and specifically cannot distinguish a receipt field
	// that is stored from one that is derived, since the derived ones all
	// equal zero for a legacy transaction. That is exactly what let the audit
	// ship comparing receipt.Type.
	submit(mustSignDynamicFeeTx(t, key, chainID, nonce, &counter, big.NewInt(0), 500_000, []byte{0x01}))
	submit(mustSignAccessListTx(t, key, chainID, nonce, &counter, big.NewInt(0), 500_000, []byte{0x01}))

	for i := 0; i < 20; i++ {
		call(counter, []byte{0x01}) // storage write
		call(logger, nil)           // three LOG1s -> a non-empty bloom

		switch {
		case i%6 == 0:
			// Fill then clear ten slots: the clear earns EIP-3529 refunds, so
			// these two blocks are where a replay that got gas accounting
			// subtly wrong would diverge.
			call(churn, []byte{0x01})
			call(churn, nil)
		case i%4 == 1:
			if _, err := seq.SetBalance(testSysOpAddr, big.NewInt(int64(1_000+i))); err != nil {
				t.Fatalf("SetBalance: %v", err)
			}
		case i%3 == 2:
			if _, err := seq.MineEmptyBlock(); err != nil {
				t.Fatalf("MineEmptyBlock: %v", err)
			}
		case i%5 == 3:
			// Reverts are rejected at submission and mine nothing, so this
			// must leave both the head and the sender's nonce untouched —
			// if it ever started mining a block, replay would find a block
			// whose transaction reverts and report it.
			revertTx := mustSignTx(t, key, chainID, nonce, &reverter, big.NewInt(0), 100_000, []byte{0x01})
			if _, err := seq.SubmitTx(revertTx); err == nil {
				t.Fatal("a reverting transaction was accepted; it must not be mined")
			}
		}
	}

	head, err := seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}
	if head < 50 {
		t.Fatalf("fixture chain is only %d blocks; M09 calls for at least 50 — the fixture drifted", head)
	}
	return seq, db
}

// newTestReplayer wraps db in the same overlay cmd/audit uses, so these
// tests cover the real composition (replay over a copy-on-write layer) and
// not just the replay logic in isolation.
func newTestReplayer(t *testing.T, seq *Sequencer, db ethdb.Database) *Replayer {
	t.Helper()

	work := storage.NewReplayOverlay(db)
	t.Cleanup(func() {
		if err := work.Close(); err != nil {
			t.Errorf("overlay Close: %v", err)
		}
	})
	return NewReplayer(db, work, seq.chainCfg)
}

func TestReplayVerifiesAnHonestChain(t *testing.T) {
	seq, db := buildAuditFixtureChain(t)

	head, err := seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}

	result, err := newTestReplayer(t, seq, db).Replay(1, head)
	if err != nil {
		t.Fatalf("Replay(1, %d) error = %v", head, err)
	}

	if result.Blocks != head {
		t.Errorf("replayed %d blocks, want %d", result.Blocks, head)
	}
	if result.Transactions == 0 {
		t.Error("replayed 0 transactions; the fixture chain has many")
	}
	if result.GasUsed == 0 {
		t.Error("replayed gas total is 0; the fixture chain deploys contracts")
	}

	headHeader, err := seq.HeaderByNumber(head)
	if err != nil {
		t.Fatalf("HeaderByNumber(%d): %v", head, err)
	}
	if result.StateRoot != headHeader.Root {
		t.Errorf("replayed state root = %s, sealed head root = %s", result.StateRoot, headHeader.Root)
	}
}

// TestAuditFixtureCoversEveryTransactionType keeps the fixture honest. The
// audit compares recomputed receipts against stored ones, and the difference
// between a stored field and a derived one is invisible on a legacy
// transaction — every derived field is zero there anyway. A fixture that
// drifted back to legacy-only would still pass every other test in this file
// while leaving that whole class of bug undetectable.
func TestAuditFixtureCoversEveryTransactionType(t *testing.T) {
	seq, db := buildAuditFixtureChain(t)
	head, err := seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}

	seen := map[uint8]bool{}
	for n := uint64(1); n <= head; n++ {
		block := rawdb.ReadBlock(db, rawdb.ReadCanonicalHash(db, n), n)
		if block == nil {
			t.Fatalf("block %d could not be read", n)
		}
		for _, tx := range block.Transactions() {
			seen[tx.Type()] = true
		}
	}

	for _, want := range []uint8{types.LegacyTxType, types.AccessListTxType, types.DynamicFeeTxType} {
		if !seen[want] {
			t.Errorf("fixture chain contains no transaction of type %d", want)
		}
	}
}

func TestReplayReportsProgress(t *testing.T) {
	// Progress is what makes a long audit legible; a callback that never
	// fires (or fires with the wrong target) would only be noticed during a
	// real multi-thousand-block run.
	seq, db := buildAuditFixtureChain(t)
	head, err := seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}

	replayer := newTestReplayer(t, seq, db)
	var lastBlock, lastTarget uint64
	calls := 0
	replayer.OnProgress(func(block, target uint64) {
		lastBlock, lastTarget = block, target
		calls++
	})

	if _, err := replayer.Replay(1, head); err != nil {
		t.Fatalf("Replay: %v", err)
	}

	if calls == 0 {
		t.Fatal("progress callback never fired")
	}
	if lastBlock != head || lastTarget != head {
		t.Errorf("final progress = (%d, %d), want (%d, %d)", lastBlock, lastTarget, head, head)
	}
}

func TestReplayIsIncrementalFromAMidChainBlock(t *testing.T) {
	// The incremental path is the one that reads historical trie nodes back
	// out of the audited database through the overlay, rather than
	// recomputing them — a different code path from the full replay above,
	// and the one `audit --from N` depends on.
	seq, db := buildAuditFixtureChain(t)
	head, err := seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}
	from := head/2 + 1

	result, err := newTestReplayer(t, seq, db).Replay(from, head)
	if err != nil {
		t.Fatalf("Replay(%d, %d) error = %v", from, head, err)
	}

	if result.Blocks != head-from+1 {
		t.Errorf("replayed %d blocks, want %d", result.Blocks, head-from+1)
	}

	headHeader, err := seq.HeaderByNumber(head)
	if err != nil {
		t.Fatalf("HeaderByNumber(%d): %v", head, err)
	}
	if result.StateRoot != headHeader.Root {
		t.Errorf("incremental replay state root = %s, sealed head root = %s", result.StateRoot, headHeader.Root)
	}
}

func TestReplayOfAnEmptyRangeIsNotAFailure(t *testing.T) {
	// `audit --from N` against a chain whose head is N-1 has nothing to
	// check and has found nothing wrong — reporting that as a failure would
	// make incremental audits useless in a cron job.
	seq, db := buildAuditFixtureChain(t)
	head, err := seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}

	result, err := newTestReplayer(t, seq, db).Replay(head+1, head)
	if err != nil {
		t.Fatalf("Replay of an empty range error = %v, want nil", err)
	}
	if result.Blocks != 0 {
		t.Errorf("replayed %d blocks over an empty range, want 0", result.Blocks)
	}
}

func TestReplayReportsAMissingBlock(t *testing.T) {
	seq, db := buildAuditFixtureChain(t)
	head, err := seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}

	if _, err := newTestReplayer(t, seq, db).Replay(1, head+5); !errors.Is(err, ErrBlockNotFound) {
		t.Errorf("Replay past the head error = %v, want ErrBlockNotFound", err)
	}
}

// firstBlockWithTransactions returns the number of the lowest block holding
// at least one transaction — the tampering target for the tests below.
func firstBlockWithTransactions(t *testing.T, db ethdb.Database, head uint64) (uint64, common.Hash) {
	t.Helper()

	for n := uint64(1); n <= head; n++ {
		hash := rawdb.ReadCanonicalHash(db, n)
		block := rawdb.ReadBlock(db, hash, n)
		if block != nil && len(block.Transactions()) > 0 {
			return n, hash
		}
	}
	t.Fatal("fixture chain has no block with transactions")
	return 0, common.Hash{}
}

func TestReplayReportsATamperedReceipt(t *testing.T) {
	// The receipt records eth_getTransactionReceipt and eth_getLogs serve are
	// stored separately from the header, so altering one leaves every root in
	// the chain verifying. A voter checking their vote reads a receipt, not a
	// state root — so the audit has to compare them too.
	seq, db := buildAuditFixtureChain(t)
	head, err := seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}

	target, hash := firstBlockWithTransactions(t, db, head)
	receipts := rawdb.ReadRawReceipts(db, hash, target)
	if len(receipts) == 0 {
		t.Fatalf("block %d has no stored receipts", target)
	}
	receipts[0].CumulativeGasUsed++ // the smallest possible lie
	rawdb.WriteReceipts(db, hash, target, receipts)

	_, err = newTestReplayer(t, seq, db).Replay(1, head)

	var mismatch *ReplayMismatch
	if !errors.As(err, &mismatch) {
		t.Fatalf("Replay error = %v, want a *ReplayMismatch", err)
	}
	if mismatch.Block != target {
		t.Errorf("mismatch reported at block %d, want %d", mismatch.Block, target)
	}
	if mismatch.Field != "receipt[0].cumulativeGasUsed" {
		t.Errorf("mismatch field = %q, want receipt[0].cumulativeGasUsed", mismatch.Field)
	}
}

func TestReplayReportsMissingReceipts(t *testing.T) {
	// Truncation rather than alteration: a receipt record that cannot be
	// decoded reads back as no receipts at all, which must be reported at
	// that block rather than passed over.
	seq, db := buildAuditFixtureChain(t)
	head, err := seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}

	target, hash := firstBlockWithTransactions(t, db, head)
	rawdb.WriteReceipts(db, hash, target, types.Receipts{})

	_, err = newTestReplayer(t, seq, db).Replay(1, head)

	var mismatch *ReplayMismatch
	if !errors.As(err, &mismatch) {
		t.Fatalf("Replay error = %v, want a *ReplayMismatch", err)
	}
	if mismatch.Block != target {
		t.Errorf("mismatch reported at block %d, want %d", mismatch.Block, target)
	}
	if mismatch.Field != "storedReceipts" {
		t.Errorf("mismatch field = %q, want storedReceipts", mismatch.Field)
	}
}

// The two functions below are the audit's actual comparison rules. Driving
// them directly is how every field gets covered: fabricating a chain whose
// gasUsed is wrong but whose state root is right (and so on for each field)
// would take far more machinery than the rules themselves contain.

func TestVerifyBlockNamesTheFieldThatDisagrees(t *testing.T) {
	seq, db := buildAuditFixtureChain(t)
	head, err := seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}

	target, hash := firstBlockWithTransactions(t, db, head)
	block := rawdb.ReadBlock(db, hash, target)
	if block == nil {
		t.Fatalf("block %d could not be read", target)
	}
	header := block.Header()

	wrongHash := common.HexToHash("0x1111111111111111111111111111111111111111111111111111111111111111")

	tests := []struct {
		name      string
		root      common.Hash
		receipts  types.Receipts
		gasUsed   uint64
		wantField string
	}{
		{
			name:      "state root",
			root:      wrongHash,
			gasUsed:   header.GasUsed,
			wantField: "stateRoot",
		},
		{
			name:      "gas used",
			root:      header.Root,
			gasUsed:   header.GasUsed + 1,
			wantField: "gasUsed",
		},
		{
			// A block with transactions but no receipts hashes to the empty
			// receipt root, which cannot match the header's.
			name:      "receipts root",
			root:      header.Root,
			gasUsed:   header.GasUsed,
			receipts:  nil,
			wantField: "receiptsRoot",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			mismatch := verifyBlock(block, tc.root, tc.receipts, tc.gasUsed)
			if mismatch == nil {
				t.Fatal("verifyBlock returned nil, want a mismatch")
			}
			if mismatch.Field != tc.wantField {
				t.Errorf("field = %q, want %q", mismatch.Field, tc.wantField)
			}
			if mismatch.Block != target {
				t.Errorf("block = %d, want %d", mismatch.Block, target)
			}
		})
	}
}

func TestVerifyBlockDetectsABloomThatDoesNotMatchItsLogs(t *testing.T) {
	// Checked on an empty block, where the transaction and receipt roots are
	// both fixed at the empty value, so the bloom is the only field that can
	// disagree — otherwise an earlier check would fire first and this rule
	// would never be reached.
	seq, _ := newTestSequencer(t)
	block, err := seq.MineEmptyBlock()
	if err != nil {
		t.Fatalf("MineEmptyBlock: %v", err)
	}

	receipt := types.NewReceipt(nil, false, 0)
	receipt.Logs = []*types.Log{{Address: testSysOpAddr}}
	receipt.Bloom = types.CreateBloom(receipt)

	mismatch := verifyBlock(block, block.Root(), types.Receipts{receipt}, 0)
	if mismatch == nil {
		t.Fatal("verifyBlock returned nil, want a logsBloom mismatch")
	}
	if mismatch.Field != "logsBloom" {
		t.Errorf("field = %q, want logsBloom", mismatch.Field)
	}
}

func TestVerifyLinkageEnforcesTheChainShape(t *testing.T) {
	seq, _ := newTestSequencer(t)

	first, err := seq.MineEmptyBlock()
	if err != nil {
		t.Fatalf("MineEmptyBlock: %v", err)
	}
	second, err := seq.MineEmptyBlock()
	if err != nil {
		t.Fatalf("MineEmptyBlock: %v", err)
	}

	if mismatch := verifyLinkage(second, first); mismatch != nil {
		t.Fatalf("two consecutive sealed blocks failed linkage: %v", mismatch)
	}

	// A block whose parent hash points elsewhere.
	detached := second.Header()
	detached.ParentHash = common.HexToHash("0x2222222222222222222222222222222222222222222222222222222222222222")
	if mismatch := verifyLinkage(types.NewBlockWithHeader(detached), first); mismatch == nil || mismatch.Field != "parentHash" {
		t.Errorf("detached block: got %v, want a parentHash mismatch", mismatch)
	}

	// A block numbered out of sequence.
	misnumbered := second.Header()
	misnumbered.Number = new(big.Int).SetUint64(second.NumberU64() + 7)
	if mismatch := verifyLinkage(types.NewBlockWithHeader(misnumbered), first); mismatch == nil || mismatch.Field != "number" {
		t.Errorf("misnumbered block: got %v, want a number mismatch", mismatch)
	}

	// Time standing still. Voting.sol's phase deadlines are block.timestamp
	// comparisons, so this is a correctness rule, not a formality
	// (MASTER §10 pitfall 7).
	frozen := second.Header()
	frozen.Time = first.Time()
	if mismatch := verifyLinkage(types.NewBlockWithHeader(frozen), first); mismatch == nil || mismatch.Field != "timestamp" {
		t.Errorf("frozen-time block: got %v, want a timestamp mismatch", mismatch)
	}
}

func TestReplayerHeadMatchesTheSequencer(t *testing.T) {
	seq, db := buildAuditFixtureChain(t)

	want, err := seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}
	got, err := newTestReplayer(t, seq, db).Head()
	if err != nil {
		t.Fatalf("Replayer.Head: %v", err)
	}
	if got != want {
		t.Errorf("Replayer.Head() = %d, want %d", got, want)
	}
}

func TestVerifyGenesisRejectsAMismatchedConfig(t *testing.T) {
	// cmd/audit calls this before replaying: without it an audit would
	// happily verify a chain built from a different chain id or prefund set,
	// since every later block only has to agree with the block before it.
	_, db := newTestSequencer(t)

	if _, err := state.VerifyGenesis(db, testConfig(testChainID, 60_000_000)); err != nil {
		t.Fatalf("VerifyGenesis with the fixture's own config: %v", err)
	}

	var mismatch *state.GenesisMismatchError
	_, err := state.VerifyGenesis(db, testConfig(testChainID+1, 60_000_000))
	if !errors.As(err, &mismatch) {
		t.Errorf("VerifyGenesis with a different CHAIN_ID error = %v, want a *GenesisMismatchError", err)
	}
}
