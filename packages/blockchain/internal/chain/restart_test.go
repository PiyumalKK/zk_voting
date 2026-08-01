package chain

import (
	"math/big"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/core/rawdb"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethdb"

	"zk-blockchain/internal/config"
	"zk-blockchain/internal/state"
	"zk-blockchain/internal/storage"
)

// Restart is where a persistent chain differs from Hardhat, and therefore
// where this node has no upstream behaviour to copy. These tests cover the
// two ways a restart can go wrong: the chain forgets what time it is, and
// the chain comes back pointing at state it cannot read.

// timestampTolerance absorbs the wall-clock second that may tick over
// between a test computing an expected timestamp and the node computing the
// real one. Every assertion below is about a rule (does the clock continue
// from the head?), never about an exact instant.
const timestampTolerance = int64(3)

// openChainAt opens (or reopens) a chain in dir and returns a Sequencer over
// it. The caller owns the returned database and must close it: these tests
// reopen the same directory, which is only possible once Pebble's exclusive
// lock has been released, so closing is part of what they are testing rather
// than housekeeping to hide in a cleanup hook.
func openChainAt(t *testing.T, dir string) (*Sequencer, ethdb.Database, *config.Config) {
	t.Helper()

	db, err := storage.Open(dir)
	if err != nil {
		t.Fatalf("storage.Open(%s): %v", dir, err)
	}

	cfg := testConfig(testChainID, 60_000_000)
	if _, err := state.EnsureGenesis(db, cfg); err != nil {
		_ = db.Close()
		t.Fatalf("EnsureGenesis: %v", err)
	}

	return New(db, state.ChainConfig(cfg.ChainID), cfg.BlockGasLimit), db, cfg
}

func assertNear(t *testing.T, what string, got, want int64) {
	t.Helper()
	if diff := got - want; diff < -timestampTolerance || diff > timestampTolerance {
		t.Errorf("%s = %d, want %d (±%d)", what, got, want, timestampTolerance)
	}
}

func TestFreshChainDoesNotSeedTheDevClock(t *testing.T) {
	// Genesis is timestamped 0, so the head is decades *behind* wall clock.
	// Seeding from it would force a large negative offset and freeze the
	// chain in 1970 — the seeding rule must be one-directional.
	seq, _ := newTestSequencer(t)

	if got := seq.DevOffsetSeconds(); got != 0 {
		t.Errorf("dev offset on a fresh chain = %d, want 0", got)
	}
}

// TestRestartSeedsTheDevClockFromAFarFutureHead is M09 deliverable 1's
// clock test. A chain that jumped forward (which is every chain the M08
// contract-test gate touches, and any election whose phase deadlines were
// crossed with evm_increaseTime) has a head well ahead of wall clock, while
// devOffset — being in memory — is back at zero after a restart.
// nextTimestamp's parent+1 floor then wins over wall clock on every block,
// so the chain advances one second per block until real time catches up: a
// week-long jump would take 604,800 blocks to unwind.
func TestRestartSeedsTheDevClockFromAFarFutureHead(t *testing.T) {
	dir := t.TempDir()
	const jump = uint64(7 * 24 * 60 * 60) // one week

	seq, db, _ := openChainAt(t, dir)
	if _, err := seq.IncreaseTime(jump); err != nil {
		t.Fatalf("IncreaseTime: %v", err)
	}
	if _, err := seq.MineEmptyBlock(); err != nil {
		t.Fatalf("MineEmptyBlock: %v", err)
	}
	head, err := seq.currentHeader()
	if err != nil {
		t.Fatalf("currentHeader: %v", err)
	}
	headTime := int64(head.Time)
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	reopened, db2, _ := openChainAt(t, dir)
	defer db2.Close()

	// (a) The offset is seeded to exactly the head's lead over wall clock.
	offset := reopened.DevOffsetSeconds()
	assertNear(t, "dev offset after restart", offset, headTime-time.Now().Unix())
	if offset < int64(jump)-timestampTolerance {
		t.Errorf("dev offset after restart = %d, want about %d — the clock was not seeded from the head", offset, jump)
	}

	// (b) The consequence that actually matters: with the offset seeded,
	// block timestamps track *elapsed wall-clock time* from the head. The
	// pure function the sealing path uses is driven directly here with a
	// simulated 30 seconds of elapsed time, because the alternative — making
	// the test sleep — would buy the same assertion at the cost of 30
	// seconds per run.
	const elapsed = 30 * time.Second
	seeded := nextTimestamp(head.Time, time.Duration(offset)*time.Second+elapsed)
	assertNear(t, "next block timestamp with the clock seeded", int64(seeded), headTime+int64(elapsed.Seconds()))

	// And the failure mode it replaces: without seeding, the same 30 seconds
	// move the chain forward by one second.
	if unseeded := nextTimestamp(head.Time, elapsed); unseeded != head.Time+1 {
		t.Errorf("unseeded next timestamp = %d, want %d — this test's premise no longer holds", unseeded, head.Time+1)
	}
}

// TestIncreaseTimeAfterARestartIsRelativeToTheHead is the same property
// end-to-end, through the RPC-facing method the hardhat contract suite
// calls. `make diff-dev` caught the un-seeded version of this bug as
// "our delta=1s hardhat delta=86400s" (RUNNING-GATES §4), so it is worth
// asserting from Go as well as from the differential harness.
func TestIncreaseTimeAfterARestartIsRelativeToTheHead(t *testing.T) {
	dir := t.TempDir()

	seq, db, _ := openChainAt(t, dir)
	if _, err := seq.IncreaseTime(2 * 24 * 60 * 60); err != nil {
		t.Fatalf("IncreaseTime: %v", err)
	}
	if _, err := seq.MineEmptyBlock(); err != nil {
		t.Fatalf("MineEmptyBlock: %v", err)
	}
	head, err := seq.currentHeader()
	if err != nil {
		t.Fatalf("currentHeader: %v", err)
	}
	headTime := int64(head.Time)
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	reopened, db2, _ := openChainAt(t, dir)
	defer db2.Close()

	const hour = uint64(3600)
	if _, err := reopened.IncreaseTime(hour); err != nil {
		t.Fatalf("IncreaseTime after restart: %v", err)
	}
	block, err := reopened.MineEmptyBlock()
	if err != nil {
		t.Fatalf("MineEmptyBlock after restart: %v", err)
	}

	assertNear(t, "block timestamp after a post-restart hour jump", int64(block.Time()), headTime+int64(hour))
}

// TestChainRecoversFromAPartialWrite simulates the crash window M09
// deliverable 1 asks about: a block's data reached disk but the head
// pointers never moved.
//
// seal.go's persist writes block, receipts and head pointers in one atomic
// rawdb batch, so this state cannot arise from persist itself — the batch
// either lands or it doesn't. It can still arise from the layer above:
// trie nodes are committed *before* persist runs, and a crash in between
// leaves state on disk that no head references. The recovery rule is that
// the previous head remains valid and the orphaned data is simply
// unreachable, which is what this reproduces by rolling the head pointers
// back over a sealed block.
func TestChainRecoversFromAPartialWrite(t *testing.T) {
	dir := t.TempDir()

	seq, db, cfg := openChainAt(t, dir)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)

	// Real work first, so recovery has something to preserve.
	_, counter := deploy(t, seq, key, chainID, 0, counterRuntime())
	if _, err := seq.SubmitTx(mustSignTx(t, key, chainID, 1, &counter, big.NewInt(0), 100_000, []byte{0x01})); err != nil {
		t.Fatalf("counter increment: %v", err)
	}

	survivor, err := seq.currentHeader()
	if err != nil {
		t.Fatalf("currentHeader: %v", err)
	}
	survivorHash := survivor.Hash()
	survivorNumber := survivor.Number.Uint64()

	// An empty block is used as the lost one deliberately: it writes no
	// transaction-lookup entries, so rolling the head back leaves the
	// database in exactly the state a crash would — orphaned block data and
	// nothing else.
	orphan, err := seq.MineEmptyBlock()
	if err != nil {
		t.Fatalf("MineEmptyBlock: %v", err)
	}
	rawdb.DeleteCanonicalHash(db, orphan.NumberU64())
	rawdb.WriteHeadBlockHash(db, survivorHash)
	rawdb.WriteHeadHeaderHash(db, survivorHash)

	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Reopen exactly as cmd/node does: genesis check, then the head
	// integrity check that must pass on the *previous* head.
	db2, err := storage.Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer db2.Close()
	if _, err := state.EnsureGenesis(db2, cfg); err != nil {
		t.Fatalf("EnsureGenesis after restart: %v", err)
	}

	recovered, err := state.VerifyHead(db2)
	if err != nil {
		t.Fatalf("VerifyHead after a partial write: %v", err)
	}
	if got := recovered.Number.Uint64(); got != survivorNumber {
		t.Fatalf("recovered head is block %d, want %d (the block before the lost one)", got, survivorNumber)
	}
	if recovered.Hash() != survivorHash {
		t.Errorf("recovered head hash = %s, want %s", recovered.Hash(), survivorHash)
	}

	// The chain must be usable again, not merely readable: the next
	// transaction takes the number the orphan had, and becomes the canonical
	// block at that height.
	reopened := New(db2, state.ChainConfig(cfg.ChainID), cfg.BlockGasLimit)
	receipt, err := reopened.SubmitTx(mustSignTx(t, key, chainID, 2, &counter, big.NewInt(0), 100_000, []byte{0x01}))
	if err != nil {
		t.Fatalf("SubmitTx after recovery: %v", err)
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		t.Fatalf("post-recovery tx status = %d, want success", receipt.Status)
	}

	replacement := receipt.BlockNumber.Uint64()
	if replacement != orphan.NumberU64() {
		t.Errorf("post-recovery block number = %d, want %d (reusing the lost block's height)", replacement, orphan.NumberU64())
	}
	canonical := rawdb.ReadCanonicalHash(db2, replacement)
	if canonical == orphan.Hash() {
		t.Error("the orphaned block is canonical again; a partially written block must never be re-adopted")
	}
	if canonical != receipt.BlockHash {
		t.Errorf("canonical block %d = %s, want the newly sealed %s", replacement, canonical, receipt.BlockHash)
	}
}
