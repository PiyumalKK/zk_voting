package state

import (
	"errors"
	"math/big"
	"testing"

	"zk-blockchain/internal/config"
	"zk-blockchain/internal/storage"
)

func testConfig(chainID, gasLimit uint64) *config.Config {
	return &config.Config{ChainID: chainID, BlockGasLimit: gasLimit}
}

func TestGenesisIsDeterministic(t *testing.T) {
	cfg := testConfig(9494, 60_000_000)

	db1, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open db1: %v", err)
	}
	defer db1.Close()
	block1, err := EnsureGenesis(db1, cfg)
	if err != nil {
		t.Fatalf("EnsureGenesis(db1): %v", err)
	}

	db2, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open db2: %v", err)
	}
	defer db2.Close()
	block2, err := EnsureGenesis(db2, cfg)
	if err != nil {
		t.Fatalf("EnsureGenesis(db2): %v", err)
	}

	if block1.Hash() != block2.Hash() {
		t.Errorf("genesis hashes differ across fresh data dirs: %s vs %s", block1.Hash(), block2.Hash())
	}
	if block1.NumberU64() != 0 {
		t.Errorf("genesis block number = %d, want 0", block1.NumberU64())
	}
}

func TestEnsureGenesisReopenPreservesHeadAndBalances(t *testing.T) {
	dir := t.TempDir()
	cfg := testConfig(9494, 60_000_000)

	db, err := storage.Open(dir)
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	// Closing is safe to call twice (see storage.Open's underlying Close
	// implementations), so this defer is a safety net in case a
	// t.Fatalf below skips the explicit Close a few lines down — on
	// Windows a leaked handle keeps t.TempDir's cleanup from removing the
	// directory.
	defer db.Close()
	first, err := EnsureGenesis(db, cfg)
	if err != nil {
		t.Fatalf("first EnsureGenesis: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	db2, err := storage.Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer db2.Close()

	second, err := EnsureGenesis(db2, cfg)
	if err != nil {
		t.Fatalf("second EnsureGenesis: %v", err)
	}
	if first.Hash() != second.Hash() {
		t.Errorf("genesis hash changed across reopen: %s vs %s", first.Hash(), second.Hash())
	}

	statedb, err := At(db2, second.Root())
	if err != nil {
		t.Fatalf("At(): %v", err)
	}
	got := statedb.GetBalance(hardhatMnemonicAddresses[0])
	want := prefundPerAccount()
	if got.ToBig().Cmp(want) != 0 {
		t.Errorf("balance of hardhat[0] after reopen = %s, want %s", got, want)
	}
}

func TestEnsureGenesisDetectsConfigDrift(t *testing.T) {
	dir := t.TempDir()

	db, err := storage.Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	// See the comment on the equivalent defer in
	// TestEnsureGenesisReopenPreservesHeadAndBalances: safety net for
	// Windows cleanup if EnsureGenesis fails before the explicit Close.
	defer db.Close()
	if _, err := EnsureGenesis(db, testConfig(9494, 60_000_000)); err != nil {
		t.Fatalf("initial EnsureGenesis: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	db2, err := storage.Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer db2.Close()

	_, err = EnsureGenesis(db2, testConfig(1337, 60_000_000))
	if err == nil {
		t.Fatal("EnsureGenesis with a different CHAIN_ID against existing data succeeded, want a mismatch error")
	}
	var mismatch *GenesisMismatchError
	if !errors.As(err, &mismatch) {
		t.Fatalf("error = %v (%T), want *GenesisMismatchError", err, err)
	}
}

func TestPrefundPerAccountIsTenThousandEther(t *testing.T) {
	want := new(big.Int).Mul(big.NewInt(10_000), big.NewInt(1_000_000_000_000_000_000))
	if prefundPerAccount().Cmp(want) != 0 {
		t.Errorf("prefundPerAccount() = %s, want %s", prefundPerAccount(), want)
	}
}

func TestHardhatMnemonicAddressCount(t *testing.T) {
	if len(hardhatMnemonicAddresses) != 20 {
		t.Errorf("len(hardhatMnemonicAddresses) = %d, want 20", len(hardhatMnemonicAddresses))
	}
	seen := make(map[[20]byte]bool, len(hardhatMnemonicAddresses))
	for i, addr := range hardhatMnemonicAddresses {
		if seen[addr] {
			t.Errorf("duplicate address at index %d: %s", i, addr)
		}
		seen[addr] = true
	}
}
