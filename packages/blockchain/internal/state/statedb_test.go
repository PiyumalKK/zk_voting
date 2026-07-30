package state

import (
	"testing"

	"github.com/ethereum/go-ethereum/common"

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
