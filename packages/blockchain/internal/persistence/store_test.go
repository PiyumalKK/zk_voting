package persistence

import (
	"errors"
	"testing"

	"zk-blockchain/internal/core"
)

// TestLoadBlockchain_EmptyVsCorrupt verifies the distinction main.go relies on to
// avoid silently discarding a chain: an empty database must report ErrNoBlockchain
// (main.go then creates genesis), while a database whose blocks fail validation must
// report a DIFFERENT error (main.go then refuses to start rather than overwrite it).
func TestLoadBlockchain_EmptyVsCorrupt(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	defer store.Close()

	// Empty database → ErrNoBlockchain.
	if _, err := store.LoadBlockchain(); !errors.Is(err, ErrNoBlockchain) {
		t.Fatalf("empty DB: expected ErrNoBlockchain, got %v", err)
	}

	// Persist a block that cannot form a valid chain (no genesis: index 5, a
	// non-zero prev hash). LoadBlockchain must surface a validation error that is
	// explicitly NOT ErrNoBlockchain, so the caller treats it as fatal.
	tx, err := core.NewTransaction(core.TxAddVoter, core.AddVoterPayload{VoterID: "x", Allowed: true})
	if err != nil {
		t.Fatalf("NewTransaction: %v", err)
	}
	bogus := core.NewBlock(5, []core.Transaction{*tx}, "deadbeef")
	if err := store.SaveBlock(bogus); err != nil {
		t.Fatalf("SaveBlock: %v", err)
	}

	_, err = store.LoadBlockchain()
	if err == nil {
		t.Fatal("expected a validation error loading a chain with no genesis block")
	}
	if errors.Is(err, ErrNoBlockchain) {
		t.Fatalf("a corrupt/invalid chain must not be reported as ErrNoBlockchain, got %v", err)
	}
}
