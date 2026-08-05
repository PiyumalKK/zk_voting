package chain

import (
	"errors"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethdb"

	"zk-blockchain/internal/state"
	"zk-blockchain/internal/storage"
)

// Durability, as distinct from the crash *consistency* M09 covered.
//
// M09 made the six writes that seal a block atomic, so the database can never
// be torn. It did not make them durable: go-ethereum configures Pebble with
// `writeOptions: pebble.NoSync`, so `batch.Write()` returns while the write is
// still only in memory, and its own comment accepts that "recent data may be
// lost in the event of an application-level panic". A general Ethereum client
// re-syncs those blocks from peers. This chain is the sequencer — there is
// nobody to re-sync from — and the RPC hands the caller a receipt the moment
// persist returns.
//
// M14's full-election gate found the consequence: killed abruptly, the node
// reopened two blocks short, one of which contained a vote whose receipt had
// already been returned. persist now calls SyncKeyValue, and these tests exist
// so that a later refactor cannot quietly remove it — the fault it prevents is
// invisible in every other test, because nothing else kills the process.

// errSyncFailed is returned by the fake database's SyncKeyValue when a test
// wants to see how persist reports a disk that will not flush.
var errSyncFailed = errors.New("simulated fsync failure")

// syncRecordingDB wraps a real database and records the ORDER of batch writes
// and syncs. Order is the point: a sync that happens before the write it is
// supposed to flush guarantees nothing at all, and a counter alone could not
// tell the two apart.
type syncRecordingDB struct {
	ethdb.Database

	events   []string // "write" / "sync", in the order they happened
	syncErr  error    // when non-nil, SyncKeyValue fails with this
	recordOn bool     // ignore the writes genesis performs
}

func (d *syncRecordingDB) record(event string) {
	if d.recordOn {
		d.events = append(d.events, event)
	}
}

func (d *syncRecordingDB) SyncKeyValue() error {
	if d.syncErr != nil {
		// Deliberately recorded before returning the error: a failed sync is
		// still an attempted sync, and the test asserts persist noticed.
		d.record("sync")
		return d.syncErr
	}
	if err := d.Database.SyncKeyValue(); err != nil {
		return err
	}
	d.record("sync")
	return nil
}

func (d *syncRecordingDB) NewBatch() ethdb.Batch {
	return &recordingBatch{Batch: d.Database.NewBatch(), owner: d}
}

type recordingBatch struct {
	ethdb.Batch
	owner *syncRecordingDB
}

func (b *recordingBatch) Write() error {
	if err := b.Batch.Write(); err != nil {
		return err
	}
	b.owner.record("write")
	return nil
}

// newRecordingSequencer is newTestSequencer with the recording wrapper in
// place. Recording only starts once genesis is in, so the events a test sees
// are exactly the ones its own blocks produced.
func newRecordingSequencer(t *testing.T) (*Sequencer, *syncRecordingDB) {
	t.Helper()

	inner, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	t.Cleanup(func() { _ = inner.Close() })

	db := &syncRecordingDB{Database: inner}

	cfg := testConfig(testChainID, 60_000_000)
	if _, err := state.EnsureGenesis(db, cfg); err != nil {
		t.Fatalf("EnsureGenesis: %v", err)
	}
	db.recordOn = true

	return New(db, state.ChainConfig(cfg.ChainID), cfg.BlockGasLimit), db
}

// lastTwo returns the final two recorded events, or fewer if that is all
// there is — enough to assert "the block was written, then flushed".
func lastTwo(events []string) string {
	if len(events) > 2 {
		events = events[len(events)-2:]
	}
	return strings.Join(events, ",")
}

func countSyncs(events []string) int {
	n := 0
	for _, e := range events {
		if e == "sync" {
			n++
		}
	}
	return n
}

func TestSealedBlocksAreFlushedToDisk(t *testing.T) {
	seq, db := newRecordingSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)
	to := common.HexToAddress("0x000000000000000000000000000000000000dEaD")

	tx := mustSignTx(t, key, chainID, 0, &to, big.NewInt(1), 21_000, nil)
	if _, err := seq.SubmitTx(tx); err != nil {
		t.Fatalf("SubmitTx: %v", err)
	}

	if got := lastTwo(db.events); got != "write,sync" {
		t.Errorf("a sealed transaction block ended with %q, want \"write,sync\" — "+
			"the block reached the database but was never flushed, so an abrupt "+
			"stop would lose it after its receipt had already been returned", got)
	}
}

// The three sealing paths all funnel through persist, and all three must
// therefore be durable. A regression that synced only transaction blocks would
// still lose an evm_mine or a hardhat_setBalance, and M07 made system-op blocks
// part of the audited history — so a lost one is a hole in the replay, not just
// a missing side effect.
func TestEverySealingPathFlushesToDisk(t *testing.T) {
	seq, db := newRecordingSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)
	to := common.HexToAddress("0x000000000000000000000000000000000000dEaD")

	steps := []struct {
		name string
		seal func() error
	}{
		{"transaction block", func() error {
			tx := mustSignTx(t, key, chainID, 0, &to, big.NewInt(1), 21_000, nil)
			_, err := seq.SubmitTx(tx)
			return err
		}},
		{"empty block", func() error {
			_, err := seq.MineEmptyBlock()
			return err
		}},
		{"system-op block", func() error {
			_, err := seq.SetBalance(to, big.NewInt(1_000))
			return err
		}},
	}

	for _, step := range steps {
		before := countSyncs(db.events)
		if err := step.seal(); err != nil {
			t.Fatalf("%s: %v", step.name, err)
		}
		if after := countSyncs(db.events); after != before+1 {
			t.Errorf("%s produced %d syncs, want exactly 1", step.name, after-before)
		}
		if got := lastTwo(db.events); got != "write,sync" {
			t.Errorf("%s ended with %q, want \"write,sync\"", step.name, got)
		}
	}
}

// A disk that will not flush must fail the seal loudly. Swallowing the error
// would be the worst of both worlds: the caller gets a receipt, the block is
// not durable, and nothing anywhere says so.
func TestASyncFailureFailsTheSeal(t *testing.T) {
	seq, db := newRecordingSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)
	to := common.HexToAddress("0x000000000000000000000000000000000000dEaD")

	db.syncErr = errSyncFailed

	tx := mustSignTx(t, key, chainID, 0, &to, big.NewInt(1), 21_000, nil)
	_, err := seq.SubmitTx(tx)
	if err == nil {
		t.Fatal("SubmitTx returned a receipt for a block that could not be flushed to disk")
	}
	if !errors.Is(err, errSyncFailed) {
		t.Errorf("SubmitTx error = %v, want it to wrap the sync failure", err)
	}
	if !strings.Contains(err.Error(), "sync block") {
		t.Errorf("SubmitTx error = %q, want it to name the failed step so the log is diagnosable", err)
	}
}

// persist is called directly here rather than through the sequencer, so the
// ordering assertion is about persist itself and cannot be satisfied by some
// other write happening to land in between.
func TestPersistFlushesAfterWritingNotBefore(t *testing.T) {
	inner, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	defer func() { _ = inner.Close() }()

	db := &syncRecordingDB{Database: inner, recordOn: true}

	header := &types.Header{
		Number:     big.NewInt(1),
		ParentHash: common.HexToHash("0x01"),
		GasLimit:   60_000_000,
		Time:       1,
	}
	block := types.NewBlockWithHeader(header)

	if err := persist(db, block, types.Receipts{}); err != nil {
		t.Fatalf("persist: %v", err)
	}

	want := []string{"write", "sync"}
	if len(db.events) != len(want) || db.events[0] != want[0] || db.events[1] != want[1] {
		t.Errorf("persist recorded %v, want %v — the flush must come after the write it flushes", db.events, want)
	}
}
