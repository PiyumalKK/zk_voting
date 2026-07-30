package state

import (
	"testing"

	"zk-blockchain/internal/storage"
)

func TestHeightIsZeroAtGenesis(t *testing.T) {
	db, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	if got := Height(db); got != 0 {
		t.Errorf("Height() on empty db = %d, want 0", got)
	}

	if _, err := EnsureGenesis(db, testConfig(9494, 60_000_000)); err != nil {
		t.Fatalf("EnsureGenesis: %v", err)
	}

	if got := Height(db); got != 0 {
		t.Errorf("Height() after genesis = %d, want 0", got)
	}
}
