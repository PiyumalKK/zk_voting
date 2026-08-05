package chain

import (
	"errors"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	gethrpc "github.com/ethereum/go-ethereum/rpc"
)

// Tests for the mined-transaction lookups (txlookup.go) M05's write-path RPC
// methods sit on top of. The central property under test is that a receipt
// read back from disk is indistinguishable from the one SubmitTx returned in
// memory: rawdb stores only the EIP-658 subset, so every other field has to
// be re-derived correctly or eth_getTransactionReceipt silently returns
// half-populated receipts (MASTER §10 pitfall 5 — "missing/malformed fields
// fail silently in odd places").

func TestTransactionByHashFindsMinedTx(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)

	to := common.HexToAddress("0x00000000000000000000000000000000000000aa")
	tx := mustSignTx(t, key, chainID, 0, &to, big.NewInt(1), 21_000, nil)
	if _, err := seq.SubmitTx(tx); err != nil {
		t.Fatalf("SubmitTx: %v", err)
	}

	loc, err := seq.TransactionByHash(tx.Hash())
	if err != nil {
		t.Fatalf("TransactionByHash: %v", err)
	}
	if loc.Tx.Hash() != tx.Hash() {
		t.Errorf("tx hash = %s, want %s", loc.Tx.Hash(), tx.Hash())
	}
	if loc.BlockNumber != 1 {
		t.Errorf("block number = %d, want 1 (first block after genesis)", loc.BlockNumber)
	}
	if loc.Index != 0 {
		t.Errorf("tx index = %d, want 0 (one tx per block)", loc.Index)
	}

	header, err := seq.HeaderByNumber(1)
	if err != nil {
		t.Fatalf("HeaderByNumber(1): %v", err)
	}
	if loc.BlockHash != header.Hash() {
		t.Errorf("block hash = %s, want %s", loc.BlockHash, header.Hash())
	}
}

func TestTransactionByHashUnknownIsErrTxNotFound(t *testing.T) {
	seq, _ := newTestSequencer(t)

	_, err := seq.TransactionByHash(common.Hash{0x01})
	if !errors.Is(err, ErrTxNotFound) {
		t.Fatalf("err = %v, want ErrTxNotFound", err)
	}
}

func TestReceiptByTxHashUnknownIsErrTxNotFound(t *testing.T) {
	seq, _ := newTestSequencer(t)

	_, _, err := seq.ReceiptByTxHash(common.Hash{0xab})
	if !errors.Is(err, ErrTxNotFound) {
		t.Fatalf("err = %v, want ErrTxNotFound", err)
	}
}

// TestReceiptRoundTripMatchesSubmitTx is the core regression guard: a
// receipt loaded from disk must equal the one SubmitTx handed back, field by
// field. It runs against three transaction shapes — a plain value transfer,
// a contract creation (exercises ContractAddress derivation), and a
// log-emitting call (exercises per-log annotation and the bloom) — because
// each populates a different subset of the derived fields.
func TestReceiptRoundTripMatchesSubmitTx(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)

	to := common.HexToAddress("0x00000000000000000000000000000000000000aa")

	// Deploy the log-emitting contract first so the third case below has
	// something to call; nonces run 0,1,2 across the three submissions.
	transfer := mustSignTx(t, key, chainID, 0, &to, big.NewInt(1), 21_000, nil)
	creation := mustSignTx(t, key, chainID, 1, nil, big.NewInt(0), 500_000, buildInitCode(logRuntime()))

	memReceipts := map[string]*types.Receipt{}

	r, err := seq.SubmitTx(transfer)
	if err != nil {
		t.Fatalf("SubmitTx(transfer): %v", err)
	}
	memReceipts["transfer"] = r

	r, err = seq.SubmitTx(creation)
	if err != nil {
		t.Fatalf("SubmitTx(creation): %v", err)
	}
	memReceipts["creation"] = r
	logContract := r.ContractAddress
	if logContract == (common.Address{}) {
		t.Fatal("creation receipt has no ContractAddress")
	}

	emitting := mustSignTx(t, key, chainID, 2, &logContract, big.NewInt(0), 200_000, []byte{0x01})
	r, err = seq.SubmitTx(emitting)
	if err != nil {
		t.Fatalf("SubmitTx(emitting): %v", err)
	}
	memReceipts["emitting"] = r
	if len(r.Logs) != 3 {
		t.Fatalf("in-memory receipt has %d logs, want 3", len(r.Logs))
	}

	for name, tx := range map[string]*types.Transaction{
		"transfer": transfer,
		"creation": creation,
		"emitting": emitting,
	} {
		t.Run(name, func(t *testing.T) {
			want := memReceipts[name]
			got, loc, err := seq.ReceiptByTxHash(tx.Hash())
			if err != nil {
				t.Fatalf("ReceiptByTxHash: %v", err)
			}
			if loc.Tx.Hash() != tx.Hash() {
				t.Errorf("location tx hash = %s, want %s", loc.Tx.Hash(), tx.Hash())
			}

			if got.Status != want.Status {
				t.Errorf("Status = %d, want %d", got.Status, want.Status)
			}
			if got.TxHash != tx.Hash() {
				t.Errorf("TxHash = %s, want %s", got.TxHash, tx.Hash())
			}
			if got.Type != want.Type {
				t.Errorf("Type = %d, want %d", got.Type, want.Type)
			}
			if got.GasUsed != want.GasUsed {
				t.Errorf("GasUsed = %d, want %d", got.GasUsed, want.GasUsed)
			}
			if got.CumulativeGasUsed != want.CumulativeGasUsed {
				t.Errorf("CumulativeGasUsed = %d, want %d", got.CumulativeGasUsed, want.CumulativeGasUsed)
			}
			if got.ContractAddress != want.ContractAddress {
				t.Errorf("ContractAddress = %s, want %s", got.ContractAddress, want.ContractAddress)
			}
			if got.BlockHash != want.BlockHash {
				t.Errorf("BlockHash = %s, want %s", got.BlockHash, want.BlockHash)
			}
			if got.BlockNumber.Cmp(want.BlockNumber) != 0 {
				t.Errorf("BlockNumber = %s, want %s", got.BlockNumber, want.BlockNumber)
			}
			if got.TransactionIndex != want.TransactionIndex {
				t.Errorf("TransactionIndex = %d, want %d", got.TransactionIndex, want.TransactionIndex)
			}
			if got.Bloom != want.Bloom {
				t.Errorf("Bloom differs from the in-memory receipt's")
			}
			if got.EffectiveGasPrice == nil || got.EffectiveGasPrice.Sign() != 0 {
				t.Errorf("EffectiveGasPrice = %v, want 0 (free-gas policy)", got.EffectiveGasPrice)
			}

			if len(got.Logs) != len(want.Logs) {
				t.Fatalf("len(Logs) = %d, want %d", len(got.Logs), len(want.Logs))
			}
			for i, gl := range got.Logs {
				wl := want.Logs[i]
				if gl.Address != wl.Address {
					t.Errorf("log[%d].Address = %s, want %s", i, gl.Address, wl.Address)
				}
				if len(gl.Topics) != len(wl.Topics) {
					t.Errorf("log[%d] has %d topics, want %d", i, len(gl.Topics), len(wl.Topics))
				}
				if gl.BlockHash != want.BlockHash {
					t.Errorf("log[%d].BlockHash = %s, want %s", i, gl.BlockHash, want.BlockHash)
				}
				if gl.BlockNumber != want.BlockNumber.Uint64() {
					t.Errorf("log[%d].BlockNumber = %d, want %d", i, gl.BlockNumber, want.BlockNumber.Uint64())
				}
				if gl.TxHash != tx.Hash() {
					t.Errorf("log[%d].TxHash = %s, want %s", i, gl.TxHash, tx.Hash())
				}
				if gl.TxIndex != 0 {
					t.Errorf("log[%d].TxIndex = %d, want 0", i, gl.TxIndex)
				}
				if gl.Index != uint(i) {
					t.Errorf("log[%d].Index = %d, want %d (sequential within the block)", i, gl.Index, i)
				}
			}
		})
	}
}

// TestReceiptOfRevertedTxIsNeverFound pins MASTER §10 pitfall 2 from the
// lookup side: a reverting tx is not mined at all, so neither the tx nor a
// failed receipt for it is ever retrievable.
func TestReceiptOfRevertedTxIsNeverFound(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)

	deploy := mustSignTx(t, key, chainID, 0, nil, big.NewInt(0), 500_000, buildInitCode(revertRuntime()))
	receipt, err := seq.SubmitTx(deploy)
	if err != nil {
		t.Fatalf("SubmitTx(deploy): %v", err)
	}
	target := receipt.ContractAddress

	reverting := mustSignTx(t, key, chainID, 1, &target, big.NewInt(0), 200_000, nil)
	if _, err := seq.SubmitTx(reverting); err == nil {
		t.Fatal("SubmitTx of a reverting tx returned no error")
	}

	if _, err := seq.TransactionByHash(reverting.Hash()); !errors.Is(err, ErrTxNotFound) {
		t.Errorf("TransactionByHash err = %v, want ErrTxNotFound", err)
	}
	if _, _, err := seq.ReceiptByTxHash(reverting.Hash()); !errors.Is(err, ErrTxNotFound) {
		t.Errorf("ReceiptByTxHash err = %v, want ErrTxNotFound", err)
	}
}

func TestBlockTransactionCounts(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)

	to := common.HexToAddress("0x00000000000000000000000000000000000000aa")
	tx := mustSignTx(t, key, chainID, 0, &to, big.NewInt(1), 21_000, nil)
	if _, err := seq.SubmitTx(tx); err != nil {
		t.Fatalf("SubmitTx: %v", err)
	}
	if _, err := seq.MineEmptyBlock(); err != nil {
		t.Fatalf("MineEmptyBlock: %v", err)
	}

	tests := []struct {
		name string
		bn   gethrpc.BlockNumber
		want int
	}{
		{"genesis", gethrpc.BlockNumber(0), 0},
		{"block with one tx", gethrpc.BlockNumber(1), 1},
		{"empty block", gethrpc.BlockNumber(2), 0},
		{"latest resolves to the empty block", gethrpc.LatestBlockNumber, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := seq.BlockTransactionCountByTag(tc.bn)
			if err != nil {
				t.Fatalf("BlockTransactionCountByTag(%v): %v", tc.bn, err)
			}
			if got != tc.want {
				t.Errorf("count = %d, want %d", got, tc.want)
			}
		})
	}

	header, err := seq.HeaderByNumber(1)
	if err != nil {
		t.Fatalf("HeaderByNumber(1): %v", err)
	}
	got, err := seq.BlockTransactionCountByHash(header.Hash())
	if err != nil {
		t.Fatalf("BlockTransactionCountByHash: %v", err)
	}
	if got != 1 {
		t.Errorf("count by hash = %d, want 1", got)
	}

	if _, err := seq.BlockTransactionCountByHash(common.Hash{0xff}); !errors.Is(err, ErrBlockNotFound) {
		t.Errorf("unknown block hash err = %v, want ErrBlockNotFound", err)
	}
}
