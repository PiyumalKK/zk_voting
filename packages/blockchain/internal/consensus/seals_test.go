package consensus

import (
	"crypto/ecdsa"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethdb"

	"zk-blockchain/internal/chain"
	chainconfig "zk-blockchain/internal/config"
	"zk-blockchain/internal/state"
	"zk-blockchain/internal/storage"
)

// commitSeal produces one validator's COMMIT signature over a block, the way
// the engine will.
func commitSeal(t *testing.T, key *ecdsa.PrivateKey, height uint64, hash common.Hash) []byte {
	t.Helper()
	signed, err := Sign(testChainID, key, Message{Type: MsgCommit, Height: height, BlockHash: hash})
	if err != nil {
		t.Fatalf("Sign commit: %v", err)
	}
	return signed.Signature
}

func TestSealStoreRoundTrip(t *testing.T) {
	db, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	vs, keys := testSet(t)
	store := NewStore(db)

	const height = 42
	hash := testBlockHash

	seals := &CommitSeals{
		Round: 1,
		Seals: [][]byte{
			commitSeal(t, keys["unp"], height, hash),
			commitSeal(t, keys["authority"], height, hash),
			commitSeal(t, keys["jvp"], height, hash),
		},
	}
	if err := store.Put(height, hash, seals); err != nil {
		t.Fatalf("Put: %v", err)
	}

	got, err := store.Get(height, hash)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got == nil {
		t.Fatal("Get returned nothing for a certificate that was just written")
	}
	if got.Round != 1 {
		t.Errorf("Round = %d, want 1", got.Round)
	}
	if len(got.Seals) != 3 {
		t.Fatalf("stored %d seals, want 3", len(got.Seals))
	}

	signers, err := SealedBy(testChainID, vs, height, hash, got)
	if err != nil {
		t.Fatalf("SealedBy: %v", err)
	}
	if len(signers) != 3 {
		t.Fatalf("recovered %d signers, want 3", len(signers))
	}
	names := map[string]bool{}
	for _, v := range signers {
		names[v.Name] = true
	}
	for _, want := range []string{"authority", "jvp", "unp"} {
		if !names[want] {
			t.Errorf("certificate does not include %q; got %v", want, names)
		}
	}
}

// TestStoredSealsAreOrderIndependent: seals are sorted on write, so the same
// set of signatures produces byte-identical storage regardless of the order
// votes happened to arrive in. That is what lets the cluster test assert a
// validator which rejoined after a restart holds certificates byte-identical
// to its peers'.
func TestStoredSealsAreOrderIndependent(t *testing.T) {
	_, keys := testSet(t)
	const height = 7
	hash := testBlockHash

	a := commitSeal(t, keys["authority"], height, hash)
	b := commitSeal(t, keys["jvp"], height, hash)
	c := commitSeal(t, keys["sjb"], height, hash)

	// Two nodes see the same three commits in different orders.
	firstStore := NewStore(newMemoryKV(t))
	if err := firstStore.Put(height, hash, &CommitSeals{Round: 2, Seals: [][]byte{a, b, c}}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	secondStore := NewStore(newMemoryKV(t))
	if err := secondStore.Put(height, hash, &CommitSeals{Round: 2, Seals: [][]byte{c, a, b}}); err != nil {
		t.Fatalf("Put: %v", err)
	}

	first, err := firstStore.Get(height, hash)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	second, err := secondStore.Get(height, hash)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	if len(first.Seals) != len(second.Seals) {
		t.Fatalf("stored %d and %d seals from the same set", len(first.Seals), len(second.Seals))
	}
	for i := range first.Seals {
		if string(first.Seals[i]) != string(second.Seals[i]) {
			t.Errorf("seal %d differs between two nodes that saw the same commits in different orders", i)
		}
		if i > 0 && string(first.Seals[i-1]) > string(first.Seals[i]) {
			t.Errorf("stored seals are not sorted at index %d", i)
		}
	}
}

// TestPutDoesNotReorderTheCallersSlice: the slice handed to Put is the
// engine's live tally, and reordering it underneath would be a surprising
// side effect on a data structure the engine is still using.
func TestPutDoesNotReorderTheCallersSlice(t *testing.T) {
	_, keys := testSet(t)
	const height = 3
	hash := testBlockHash

	live := [][]byte{
		commitSeal(t, keys["sjb"], height, hash),
		commitSeal(t, keys["authority"], height, hash),
		commitSeal(t, keys["jvp"], height, hash),
	}
	before := make([][]byte, len(live))
	copy(before, live)

	if err := NewMemorySealStore().Put(height, hash, &CommitSeals{Seals: live}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	for i := range live {
		if string(live[i]) != string(before[i]) {
			t.Fatalf("Put reordered the caller's slice at index %d", i)
		}
	}
}

// TestGetReportsAbsenceRatherThanFailing: blocks sealed before consensus was
// enabled have no certificate, and neither do blocks synced from a peer with
// a truncated store. Neither is an error — the block's validity never
// depended on the record.
func TestGetReportsAbsenceRatherThanFailing(t *testing.T) {
	db, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	got, err := NewStore(db).Get(999, testBlockHash)
	if err != nil {
		t.Fatalf("Get on an absent record returned an error: %v", err)
	}
	if got != nil {
		t.Errorf("Get returned %v for a block with no certificate, want nil", got)
	}
}

// TestGetIsKeyedByBlockHashNotJustHeight: a record from an abandoned proposal
// must not shadow the canonical block's certificate. Keying by height alone
// would let a reader get the wrong answer with no way to detect it.
func TestGetIsKeyedByBlockHashNotJustHeight(t *testing.T) {
	_, keys := testSet(t)
	store := NewMemorySealStore()

	const height = 12
	canonical := common.HexToHash("0xaaaa")
	abandoned := common.HexToHash("0xbbbb")

	if err := store.Put(height, abandoned, &CommitSeals{Seals: [][]byte{commitSeal(t, keys["jvp"], height, abandoned)}}); err != nil {
		t.Fatalf("Put: %v", err)
	}

	got, err := store.Get(height, canonical)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got != nil {
		t.Error("a certificate for an abandoned block was returned for the canonical one")
	}
}

// TestSealedByRejectsADuplicateSigner: three seals from two validators is not
// a quorum of three, and reporting it as one would defeat the entire purpose
// of publishing the certificate.
func TestSealedByRejectsADuplicateSigner(t *testing.T) {
	vs, keys := testSet(t)
	const height = 4
	hash := testBlockHash

	seal := commitSeal(t, keys["authority"], height, hash)
	cs := &CommitSeals{Seals: [][]byte{seal, seal, commitSeal(t, keys["jvp"], height, hash)}}

	_, err := SealedBy(testChainID, vs, height, hash, cs)
	if err == nil {
		t.Fatal("SealedBy accepted a certificate with a duplicated signer")
	}
	if !strings.Contains(err.Error(), "not a quorum") {
		t.Errorf("error does not explain the consequence: %v", err)
	}
}

// TestSealedByRejectsASealForAnotherBlock: seals are bare signatures with no
// message around them, so the only thing binding one to its block is that
// RecoverSeal rebuilds the pre-image from the block's own height and hash. A
// seal lifted from a different block must not verify here.
func TestSealedByRejectsASealForAnotherBlock(t *testing.T) {
	vs, keys := testSet(t)

	elsewhere := commitSeal(t, keys["authority"], 100, common.HexToHash("0xfeed"))
	cs := &CommitSeals{Seals: [][]byte{elsewhere}}

	if _, err := SealedBy(testChainID, vs, 42, testBlockHash, cs); err == nil {
		t.Fatal("a seal for block 100 verified as a seal for block 42")
	}
}

// TestPutRefusesAnEmptyCertificate: an empty record would be indistinguishable
// from a block that reached quorum with zero signatures, which is the one
// thing the seal store exists to make impossible to claim.
func TestPutRefusesAnEmptyCertificate(t *testing.T) {
	store := NewStore(newMemoryKV(t))

	if err := store.Put(1, testBlockHash, &CommitSeals{}); err == nil {
		t.Error("Put accepted a certificate with no seals")
	}
	if err := store.Put(1, testBlockHash, nil); err == nil {
		t.Error("Put accepted a nil certificate")
	}
}

// TestSealStorageDoesNotDisturbTheChain is the isolation guarantee the whole
// sidecar design rests on, and it is checked against the real thing rather
// than by reading go-ethereum's key schema.
//
// Seals share a database with blocks, receipts, canonical hashes and the head
// pointers. If the prefix collided with anything rawdb uses, the damage would
// be silent and total: a corrupted head pointer, or a block that verifies on
// one node and not another. So: build a real chain, write certificates over
// every block, and then require that the boot-time head check and a full
// audit replay both still pass.
func TestSealStorageDoesNotDisturbTheChain(t *testing.T) {
	db, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	cfg := &chainconfig.Config{ChainID: testChainID, BlockGasLimit: 60_000_000}
	if _, err := state.EnsureGenesis(db, cfg); err != nil {
		t.Fatalf("EnsureGenesis: %v", err)
	}
	seq := chain.New(db, state.ChainConfig(cfg.ChainID), cfg.BlockGasLimit)

	// A short chain of real blocks.
	var blocks []*types.Block
	for range 5 {
		block, err := seq.MineEmptyBlock()
		if err != nil {
			t.Fatalf("MineEmptyBlock: %v", err)
		}
		blocks = append(blocks, block)
	}

	_, keys := testSet(t)
	store := NewStore(db)
	for _, block := range blocks {
		h, hash := block.NumberU64(), block.Hash()
		if err := store.Put(h, hash, &CommitSeals{Round: 0, Seals: [][]byte{
			commitSeal(t, keys["authority"], h, hash),
			commitSeal(t, keys["jvp"], h, hash),
			commitSeal(t, keys["unp"], h, hash),
		}}); err != nil {
			t.Fatalf("Put seals for block %d: %v", h, err)
		}
	}

	// The boot-time integrity check must still pass: the head pointer and the
	// state behind it are untouched.
	head, err := state.VerifyHead(db)
	if err != nil {
		t.Fatalf("VerifyHead after writing commit seals: %v", err)
	}
	if head.Number.Uint64() != 5 {
		t.Errorf("head is at %d, want 5", head.Number.Uint64())
	}

	// And a full audit replay — the same code cmd/audit runs — must still
	// re-execute every block and reproduce every root. This is acceptance
	// criterion 6 in miniature.
	replayer := chain.NewReplayer(db, storage.NewReplayOverlay(db), state.ChainConfig(cfg.ChainID))
	result, err := replayer.Replay(1, 5)
	if err != nil {
		t.Fatalf("audit replay after writing commit seals: %v", err)
	}
	if result.Blocks != 5 {
		t.Errorf("replayed %d blocks, want 5", result.Blocks)
	}
	if result.StateRoot != head.Root {
		t.Errorf("replayed state root %s, want the head's %s", result.StateRoot, head.Root)
	}

	// Every certificate must still read back, proving the chain writes did
	// not clobber the sidecar either.
	for _, block := range blocks {
		got, err := store.Get(block.NumberU64(), block.Hash())
		if err != nil {
			t.Fatalf("Get seals for block %d: %v", block.NumberU64(), err)
		}
		if got == nil || len(got.Seals) != 3 {
			t.Errorf("block %d lost its certificate after chain activity: %v", block.NumberU64(), got)
		}
	}
}

func newMemoryKV(t *testing.T) ethdb.KeyValueStore {
	t.Helper()
	db, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}
