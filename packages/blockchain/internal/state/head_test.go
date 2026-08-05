package state

import (
	"errors"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/rawdb"
	"github.com/ethereum/go-ethereum/core/types"

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

func TestHeadHeaderReportsAnEmptyDatabase(t *testing.T) {
	db, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	if _, err := HeadHeader(db); !errors.Is(err, ErrNoHead) {
		t.Errorf("HeadHeader() on an empty db error = %v, want ErrNoHead", err)
	}
	if _, err := VerifyHead(db); !errors.Is(err, ErrNoHead) {
		t.Errorf("VerifyHead() on an empty db error = %v, want ErrNoHead", err)
	}
}

func TestVerifyHeadAcceptsAFreshGenesis(t *testing.T) {
	db, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	genesis, err := EnsureGenesis(db, testConfig(9494, 60_000_000))
	if err != nil {
		t.Fatalf("EnsureGenesis: %v", err)
	}

	head, err := VerifyHead(db)
	if err != nil {
		t.Fatalf("VerifyHead() on a fresh genesis: %v", err)
	}
	if head.Hash() != genesis.Hash() {
		t.Errorf("VerifyHead() = %s, want the genesis block %s", head.Hash(), genesis.Hash())
	}
}

// TestVerifyHeadRejectsAHeadWhoseStateIsMissing is the fail-fast rule M09
// deliberates over: a data directory whose head references state that isn't
// there must be refused at boot. Without this the node starts, looks
// healthy, accepts transactions, and only fails on the first eth_call — by
// which point the operator is debugging an RPC error several layers from the
// cause, and the sequencer may have sealed blocks on top of an unreadable
// root.
func TestVerifyHeadRejectsAHeadWhoseStateIsMissing(t *testing.T) {
	db, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	genesis, err := EnsureGenesis(db, testConfig(9494, 60_000_000))
	if err != nil {
		t.Fatalf("EnsureGenesis: %v", err)
	}

	// A header that is structurally valid and correctly indexed, but whose
	// state root was never committed — what a crash during the trie write,
	// a half-restored backup, or a data directory copied from under a
	// running node leaves behind.
	orphan := &types.Header{
		ParentHash: genesis.Hash(),
		Number:     new(big.Int).SetUint64(1),
		Root:       common.HexToHash("0xdead000000000000000000000000000000000000000000000000000000000000"),
		Difficulty: new(big.Int),
	}
	rawdb.WriteHeader(db, orphan)
	rawdb.WriteHeadHeaderHash(db, orphan.Hash())

	_, err = VerifyHead(db)
	if err == nil {
		t.Fatal("VerifyHead() accepted a head whose state root cannot be opened")
	}
	if !strings.Contains(err.Error(), "audit") {
		t.Errorf("VerifyHead() error = %q; it must point the operator at cmd/audit", err)
	}
}
