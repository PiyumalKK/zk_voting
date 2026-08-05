package state

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/holiman/uint256"

	"zk-blockchain/internal/storage"
)

func TestAtOpensGenesisRoot(t *testing.T) {
	db, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	cfg := testConfig(9494, 60_000_000)
	block, err := EnsureGenesis(db, cfg)
	if err != nil {
		t.Fatalf("EnsureGenesis: %v", err)
	}

	statedb, err := At(db, block.Root())
	if err != nil {
		t.Fatalf("At(genesis root): %v", err)
	}

	for i, addr := range hardhatMnemonicAddresses {
		got := statedb.GetBalance(addr).ToBig()
		if got.Cmp(prefundPerAccount()) != 0 {
			t.Errorf("hardhat[%d] balance = %s, want %s", i, got, prefundPerAccount())
		}
	}
}

func TestAtRejectsUnknownRoot(t *testing.T) {
	db, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	if _, err := EnsureGenesis(db, testConfig(9494, 60_000_000)); err != nil {
		t.Fatalf("EnsureGenesis: %v", err)
	}

	bogusRoot := common.HexToHash("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
	if _, err := At(db, bogusRoot); err == nil {
		t.Fatal("At() with a root that was never committed succeeded, want an error")
	}
}

// TestWritableRoundTripsAMutation proves Writable's documented commit
// lifecycle (StateDB.Commit, then TrieDB.Commit, then TrieDB.Close) actually
// persists a state change to disk: a balance bump written through a
// WritableState opened at the genesis root must be visible to a fresh,
// independent At() call afterward, including after the database is closed
// and reopened.
func TestWritableRoundTripsAMutation(t *testing.T) {
	dir := t.TempDir()
	cfg := testConfig(9494, 60_000_000)

	db, err := storage.Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	genesisBlock, err := EnsureGenesis(db, cfg)
	if err != nil {
		t.Fatalf("EnsureGenesis: %v", err)
	}

	ws, err := Writable(db, genesisBlock.Root())
	if err != nil {
		t.Fatalf("Writable: %v", err)
	}

	target := hardhatMnemonicAddresses[1]
	bump := big.NewInt(42)
	before := ws.GetBalance(target).ToBig()

	ws.AddBalance(target, uint256.MustFromBig(bump), 0)

	newRoot, err := ws.Commit(genesisBlock.NumberU64()+1, true, false)
	if err != nil {
		t.Fatalf("StateDB.Commit: %v", err)
	}
	if err := ws.TrieDB.Commit(newRoot, false); err != nil {
		t.Fatalf("TrieDB.Commit: %v", err)
	}
	if err := ws.TrieDB.Close(); err != nil {
		t.Fatalf("TrieDB.Close: %v", err)
	}

	statedb, err := At(db, newRoot)
	if err != nil {
		t.Fatalf("At(newRoot): %v", err)
	}
	got := statedb.GetBalance(target).ToBig()
	want := new(big.Int).Add(before, bump)
	if got.Cmp(want) != 0 {
		t.Errorf("balance after commit = %s, want %s", got, want)
	}

	if err := db.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	db2, err := storage.Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer db2.Close()
	statedb2, err := At(db2, newRoot)
	if err != nil {
		t.Fatalf("At(newRoot) after reopen: %v", err)
	}
	got2 := statedb2.GetBalance(target).ToBig()
	if got2.Cmp(want) != 0 {
		t.Errorf("balance after reopen = %s, want %s", got2, want)
	}
}
