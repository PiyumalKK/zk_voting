package chain

import (
	"bytes"
	"errors"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	gethrpc "github.com/ethereum/go-ethereum/rpc"
)

func TestBalanceReflectsGenesisPrefund(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	addr := crypto.PubkeyToAddress(key.PublicKey)

	got, err := seq.Balance(addr, gethrpc.LatestBlockNumber)
	if err != nil {
		t.Fatalf("Balance: %v", err)
	}
	wantEther := new(big.Int).Mul(big.NewInt(10_000), big.NewInt(1_000_000_000_000_000_000))
	if got.Cmp(wantEther) != 0 {
		t.Errorf("Balance = %s, want %s", got, wantEther)
	}
}

func TestBalanceOfUnknownAccountIsZero(t *testing.T) {
	seq, _ := newTestSequencer(t)
	addr := common.HexToAddress("0x000000000000000000000000000000000000dEaD")

	got, err := seq.Balance(addr, gethrpc.LatestBlockNumber)
	if err != nil {
		t.Fatalf("Balance: %v", err)
	}
	if got.Sign() != 0 {
		t.Errorf("Balance of untouched account = %s, want 0", got)
	}
}

func TestNonceIncreasesAfterEachSubmittedTx(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	from := crypto.PubkeyToAddress(key.PublicKey)
	chainID := big.NewInt(testChainID)
	to := common.HexToAddress("0x000000000000000000000000000000000000dEaD")

	n0, err := seq.Nonce(from, gethrpc.LatestBlockNumber)
	if err != nil {
		t.Fatalf("Nonce: %v", err)
	}
	if n0 != 0 {
		t.Fatalf("initial Nonce = %d, want 0", n0)
	}

	tx := mustSignTx(t, key, chainID, 0, &to, big.NewInt(0), 21_000, nil)
	if _, err := seq.SubmitTx(tx); err != nil {
		t.Fatalf("SubmitTx: %v", err)
	}

	n1, err := seq.Nonce(from, gethrpc.LatestBlockNumber)
	if err != nil {
		t.Fatalf("Nonce: %v", err)
	}
	if n1 != 1 {
		t.Errorf("Nonce after 1 tx = %d, want 1", n1)
	}
}

func TestCodeReturnsDeployedRuntimeAndEmptyForEOA(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	from := crypto.PubkeyToAddress(key.PublicKey)
	chainID := big.NewInt(testChainID)
	runtime := returnFortyTwoRuntime()

	_, addr := deploy(t, seq, key, chainID, 0, runtime)

	got, err := seq.Code(addr, gethrpc.LatestBlockNumber)
	if err != nil {
		t.Fatalf("Code: %v", err)
	}
	if !bytes.Equal(got, runtime) {
		t.Errorf("Code(contract) = %x, want %x", got, runtime)
	}

	gotEOA, err := seq.Code(from, gethrpc.LatestBlockNumber)
	if err != nil {
		t.Fatalf("Code(EOA): %v", err)
	}
	if len(gotEOA) != 0 {
		t.Errorf("Code(EOA) = %x, want empty", gotEOA)
	}
}

func TestStorageAtReflectsCounterSlotZero(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)

	_, addr := deploy(t, seq, key, chainID, 0, counterRuntime())

	writeTx := mustSignTx(t, key, chainID, 1, &addr, big.NewInt(0), 100_000, []byte{0x01})
	if _, err := seq.SubmitTx(writeTx); err != nil {
		t.Fatalf("increment SubmitTx: %v", err)
	}

	got, err := seq.StorageAt(addr, common.Hash{}, gethrpc.LatestBlockNumber)
	if err != nil {
		t.Fatalf("StorageAt: %v", err)
	}
	want := common.BigToHash(big.NewInt(1))
	if got != want {
		t.Errorf("StorageAt(slot 0) = %s, want %s", got, want)
	}
}

// TestEarliestTagResolvesToGenesisState proves the "earliest" tag reads
// pre-deployment state even after later blocks exist — the block-tag rule
// MASTER §10 pitfall 4 specifies (earliest -> genesis, not "the first block
// with activity").
func TestEarliestTagResolvesToGenesisState(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)

	_, addr := deploy(t, seq, key, chainID, 0, returnFortyTwoRuntime())

	// At genesis, addr had no code yet (it's deployed in block 1).
	gotEarliest, err := seq.Code(addr, gethrpc.EarliestBlockNumber)
	if err != nil {
		t.Fatalf("Code(earliest): %v", err)
	}
	if len(gotEarliest) != 0 {
		t.Errorf("Code(addr, earliest) = %x, want empty (not yet deployed at genesis)", gotEarliest)
	}

	gotLatest, err := seq.Code(addr, gethrpc.LatestBlockNumber)
	if err != nil {
		t.Fatalf("Code(latest): %v", err)
	}
	if len(gotLatest) == 0 {
		t.Error("Code(addr, latest) = empty, want deployed runtime")
	}
}

func TestBlockNumberTracksHeadAfterSubmit(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)
	to := common.HexToAddress("0x000000000000000000000000000000000000dEaD")

	n0, err := seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}
	if n0 != 0 {
		t.Fatalf("initial BlockNumber = %d, want 0", n0)
	}

	tx := mustSignTx(t, key, chainID, 0, &to, big.NewInt(0), 21_000, nil)
	if _, err := seq.SubmitTx(tx); err != nil {
		t.Fatalf("SubmitTx: %v", err)
	}

	n1, err := seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}
	if n1 != 1 {
		t.Errorf("BlockNumber after 1 tx = %d, want 1", n1)
	}
}

func TestBlockByTagAndByHashAgree(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)
	to := common.HexToAddress("0x000000000000000000000000000000000000dEaD")

	tx := mustSignTx(t, key, chainID, 0, &to, big.NewInt(0), 21_000, nil)
	receipt, err := seq.SubmitTx(tx)
	if err != nil {
		t.Fatalf("SubmitTx: %v", err)
	}

	byTag, err := seq.BlockByTag(gethrpc.LatestBlockNumber)
	if err != nil {
		t.Fatalf("BlockByTag(latest): %v", err)
	}
	if byTag.NumberU64() != receipt.BlockNumber.Uint64() {
		t.Errorf("BlockByTag number = %d, want %d", byTag.NumberU64(), receipt.BlockNumber.Uint64())
	}
	if len(byTag.Transactions()) != 1 {
		t.Fatalf("BlockByTag transactions = %d, want 1", len(byTag.Transactions()))
	}
	if byTag.Transactions()[0].Hash() != tx.Hash() {
		t.Errorf("BlockByTag tx hash = %s, want %s", byTag.Transactions()[0].Hash(), tx.Hash())
	}

	byHash, err := seq.BlockByHash(byTag.Hash())
	if err != nil {
		t.Fatalf("BlockByHash: %v", err)
	}
	if byHash.Hash() != byTag.Hash() {
		t.Errorf("BlockByHash hash = %s, want %s", byHash.Hash(), byTag.Hash())
	}

	byNumberTag, err := seq.BlockByTag(gethrpc.BlockNumber(receipt.BlockNumber.Int64()))
	if err != nil {
		t.Fatalf("BlockByTag(explicit number): %v", err)
	}
	if byNumberTag.Hash() != byTag.Hash() {
		t.Errorf("BlockByTag(explicit number) hash = %s, want %s", byNumberTag.Hash(), byTag.Hash())
	}
}

func TestBlockByHashUnknownReturnsError(t *testing.T) {
	seq, _ := newTestSequencer(t)

	_, err := seq.BlockByHash(common.Hash{0x01})
	if !errors.Is(err, ErrBlockNotFound) {
		t.Fatalf("BlockByHash(unknown hash) err = %v, want ErrBlockNotFound", err)
	}
}

func TestHeaderForBlockTagOutOfRangeReturnsError(t *testing.T) {
	seq, _ := newTestSequencer(t)

	_, err := seq.HeaderForBlockTag(gethrpc.BlockNumber(999))
	if !errors.Is(err, ErrBlockNotFound) {
		t.Fatalf("HeaderForBlockTag(999) on a genesis-only chain err = %v, want ErrBlockNotFound", err)
	}
}
