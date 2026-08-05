package chain

import (
	"bytes"
	"crypto/ecdsa"
	"encoding/hex"
	"errors"
	"math/big"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethdb"
	gethrpc "github.com/ethereum/go-ethereum/rpc"

	"zk-blockchain/internal/config"
	"zk-blockchain/internal/state"
	"zk-blockchain/internal/storage"
)

// hardhatAccount0PrivateKeyHex is the well-known private key for Hardhat's
// default test account #0 (0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266),
// derived from the public "test test test test test test test test test
// test test junk" mnemonic every Hardhat project uses — the same account
// internal/state.EnsureGenesis prefunds with 10,000 ETH (M02). It is not a
// secret; it is reused here only to sign test transactions from a
// genesis-funded sender.
const hardhatAccount0PrivateKeyHex = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

const testChainID = 9494

func testConfig(chainID, gasLimit uint64) *config.Config {
	return &config.Config{ChainID: chainID, BlockGasLimit: gasLimit}
}

func mustHardhatAccount0(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	b, err := hex.DecodeString(hardhatAccount0PrivateKeyHex)
	if err != nil {
		t.Fatalf("decode test private key: %v", err)
	}
	key, err := crypto.ToECDSA(b)
	if err != nil {
		t.Fatalf("ToECDSA: %v", err)
	}
	return key
}

// newTestSequencer opens a fresh temp-dir chain database, ensures genesis,
// and returns a ready-to-use Sequencer plus the underlying database (tests
// that need to reopen the database explicitly, e.g. persistence tests,
// build their own storage.Open/EnsureGenesis instead of using this helper).
// The database is closed automatically at test cleanup.
func newTestSequencer(t *testing.T) (*Sequencer, ethdb.Database) {
	t.Helper()
	db, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	cfg := testConfig(testChainID, 60_000_000)
	if _, err := state.EnsureGenesis(db, cfg); err != nil {
		t.Fatalf("EnsureGenesis: %v", err)
	}

	chainCfg := state.ChainConfig(cfg.ChainID)
	return New(db, chainCfg, cfg.BlockGasLimit), db
}

// mustSignTx builds and signs a legacy transaction — the tx type MASTER
// §10 pitfall 3 says must keep working, and the type the mobile app
// actually sends.
func mustSignTx(t *testing.T, key *ecdsa.PrivateKey, chainID *big.Int, nonce uint64, to *common.Address, value *big.Int, gas uint64, data []byte) *types.Transaction {
	t.Helper()
	tx := types.NewTx(&types.LegacyTx{
		Nonce:    nonce,
		To:       to,
		Value:    value,
		Gas:      gas,
		GasPrice: big.NewInt(0),
		Data:     data,
	})
	signer := types.LatestSignerForChainID(chainID)
	signed, err := types.SignTx(tx, signer, key)
	if err != nil {
		t.Fatalf("SignTx: %v", err)
	}
	return signed
}

// mustSignDynamicFeeTx builds and signs an EIP-1559 transaction — the type
// ethers v6 (and therefore hardhat-deploy) sends by default, with both fee
// caps at zero under this chain's free-gas policy.
//
// It exists because a test suite that only ever signs legacy transactions
// cannot tell a *stored* receipt field from a *derived* one: every derived
// field happens to equal its zero value for a legacy transaction. That gap
// let M09's audit ship comparing receipt.Type, which is derived, and the
// first audit of a real chain failed at block 1 — a hardhat-deploy 1559
// deployment — reporting a recomputed type 2 against a stored 0.
func mustSignDynamicFeeTx(t *testing.T, key *ecdsa.PrivateKey, chainID *big.Int, nonce uint64, to *common.Address, value *big.Int, gas uint64, data []byte) *types.Transaction {
	t.Helper()
	tx := types.NewTx(&types.DynamicFeeTx{
		ChainID:   chainID,
		Nonce:     nonce,
		To:        to,
		Value:     value,
		Gas:       gas,
		GasTipCap: big.NewInt(0),
		GasFeeCap: big.NewInt(0),
		Data:      data,
	})
	signed, err := types.SignTx(tx, types.LatestSignerForChainID(chainID), key)
	if err != nil {
		t.Fatalf("SignTx(dynamic fee): %v", err)
	}
	return signed
}

// mustSignAccessListTx builds and signs an EIP-2930 transaction — the third
// type this node accepts, included for the same reason as the 1559 helper
// above.
func mustSignAccessListTx(t *testing.T, key *ecdsa.PrivateKey, chainID *big.Int, nonce uint64, to *common.Address, value *big.Int, gas uint64, data []byte) *types.Transaction {
	t.Helper()
	tx := types.NewTx(&types.AccessListTx{
		ChainID:  chainID,
		Nonce:    nonce,
		To:       to,
		Value:    value,
		Gas:      gas,
		GasPrice: big.NewInt(0),
		Data:     data,
	})
	signed, err := types.SignTx(tx, types.LatestSignerForChainID(chainID), key)
	if err != nil {
		t.Fatalf("SignTx(access list): %v", err)
	}
	return signed
}

// deploy submits a contract-creation tx for runtime and fails the test if
// it doesn't succeed, returning the receipt and the deployed address.
func deploy(t *testing.T, seq *Sequencer, key *ecdsa.PrivateKey, chainID *big.Int, nonce uint64, runtime []byte) (*types.Receipt, common.Address) {
	t.Helper()
	tx := mustSignTx(t, key, chainID, nonce, nil, big.NewInt(0), 500_000, buildInitCode(runtime))
	receipt, err := seq.SubmitTx(tx)
	if err != nil {
		t.Fatalf("deploy SubmitTx: %v", err)
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		t.Fatalf("deploy failed, status = %d", receipt.Status)
	}
	return receipt, receipt.ContractAddress
}

func TestDeployStoresCodeAndReceiptContractAddress(t *testing.T) {
	seq, db := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	from := crypto.PubkeyToAddress(key.PublicKey)
	chainID := big.NewInt(testChainID)

	runtime := []byte{0x00} // STOP
	receipt, addr := deploy(t, seq, key, chainID, 0, runtime)

	wantAddr := crypto.CreateAddress(from, 0)
	if addr != wantAddr {
		t.Errorf("ContractAddress = %s, want %s", addr, wantAddr)
	}
	if receipt.GasUsed == 0 {
		t.Error("GasUsed = 0, want > 0")
	}

	header, err := seq.currentHeader()
	if err != nil {
		t.Fatalf("currentHeader: %v", err)
	}
	statedb, err := state.At(db, header.Root)
	if err != nil {
		t.Fatalf("state.At: %v", err)
	}
	gotCode := statedb.GetCode(addr)
	if !bytes.Equal(gotCode, runtime) {
		t.Errorf("deployed code = %x, want %x", gotCode, runtime)
	}
}

func TestCallReadsDeployedContractsFixedReturnValue(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)

	_, addr := deploy(t, seq, key, chainID, 0, returnFortyTwoRuntime())

	got, err := seq.Call(CallMsg{To: &addr}, gethrpc.LatestBlockNumber)
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	want := big.NewInt(42)
	if new(big.Int).SetBytes(got).Cmp(want) != 0 {
		t.Errorf("Call return = %s, want %s", new(big.Int).SetBytes(got), want)
	}
}

// TestCounterWriteReadAndPersistAcrossReopen exercises the full M03 spec
// scenario: a write tx increments on-chain storage, a read-only Call
// observes it, and the value survives a full database close/reopen —
// proving SubmitTx's commit path actually reaches disk, not just the
// in-memory StateDB.
func TestCounterWriteReadAndPersistAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	cfg := testConfig(testChainID, 60_000_000)
	chainID := big.NewInt(testChainID)
	key := mustHardhatAccount0(t)

	db, err := storage.Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := state.EnsureGenesis(db, cfg); err != nil {
		t.Fatalf("EnsureGenesis: %v", err)
	}
	chainCfg := state.ChainConfig(cfg.ChainID)
	seq := New(db, chainCfg, cfg.BlockGasLimit)

	_, addr := deploy(t, seq, key, chainID, 0, counterRuntime())

	// write: non-empty calldata -> increment path.
	writeTx := mustSignTx(t, key, chainID, 1, &addr, big.NewInt(0), 100_000, []byte{0x01})
	if _, err := seq.SubmitTx(writeTx); err != nil {
		t.Fatalf("increment SubmitTx: %v", err)
	}

	// read: empty calldata -> read path, via a throwaway Call.
	got, err := seq.Call(CallMsg{To: &addr}, gethrpc.LatestBlockNumber)
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	if new(big.Int).SetBytes(got).Cmp(big.NewInt(1)) != 0 {
		t.Fatalf("counter after 1 increment = %s, want 1", new(big.Int).SetBytes(got))
	}

	if err := db.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	db2, err := storage.Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer db2.Close()
	seq2 := New(db2, chainCfg, cfg.BlockGasLimit)

	got2, err := seq2.Call(CallMsg{To: &addr}, gethrpc.LatestBlockNumber)
	if err != nil {
		t.Fatalf("Call after reopen: %v", err)
	}
	if new(big.Int).SetBytes(got2).Cmp(big.NewInt(1)) != 0 {
		t.Errorf("counter after reopen = %s, want 1", new(big.Int).SetBytes(got2))
	}
}

func TestRevertWithCustomErrorProducesNoBlock(t *testing.T) {
	seq, db := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)

	_, addr := deploy(t, seq, key, chainID, 0, revertRuntime())

	before := state.Height(db)

	callTx := mustSignTx(t, key, chainID, 1, &addr, big.NewInt(0), 100_000, nil)
	_, err := seq.SubmitTx(callTx)
	if err == nil {
		t.Fatal("SubmitTx of a reverting call succeeded, want an error")
	}

	var revertErr *RevertError
	if !errors.As(err, &revertErr) {
		t.Fatalf("error = %v (%T), want *RevertError", err, err)
	}
	wantSelector := []byte{0xde, 0xad, 0xbe, 0xef}
	if !bytes.Equal(revertErr.Data, wantSelector) {
		t.Errorf("revert data = %x, want %x", revertErr.Data, wantSelector)
	}

	after := state.Height(db)
	if after != before {
		t.Errorf("height changed from %d to %d after a reverted tx, want unchanged", before, after)
	}
}

func TestNonceTooLowAndTooHigh(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)
	to := common.HexToAddress("0x000000000000000000000000000000000000dEaD")

	tooHigh := mustSignTx(t, key, chainID, 5, &to, big.NewInt(0), 21_000, nil)
	if _, err := seq.SubmitTx(tooHigh); !errors.Is(err, ErrNonceTooHigh) {
		t.Errorf("nonce=5 against account nonce 0: err = %v, want ErrNonceTooHigh", err)
	}

	ok := mustSignTx(t, key, chainID, 0, &to, big.NewInt(0), 21_000, nil)
	if _, err := seq.SubmitTx(ok); err != nil {
		t.Fatalf("nonce=0 (correct) SubmitTx: %v", err)
	}

	tooLow := mustSignTx(t, key, chainID, 0, &to, big.NewInt(0), 21_000, nil)
	if _, err := seq.SubmitTx(tooLow); !errors.Is(err, ErrNonceTooLow) {
		t.Errorf("nonce=0 replay against account nonce 1: err = %v, want ErrNonceTooLow", err)
	}
}

func TestWrongChainIDIsRejected(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	to := common.HexToAddress("0x000000000000000000000000000000000000dEaD")

	wrongChainTx := mustSignTx(t, key, big.NewInt(1), 0, &to, big.NewInt(0), 21_000, nil)
	if _, err := seq.SubmitTx(wrongChainTx); !errors.Is(err, ErrWrongChainID) {
		t.Errorf("tx signed for chain 1 submitted to chain %d: err = %v, want ErrWrongChainID", testChainID, err)
	}
}

func TestGasCapExceeded(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)
	to := common.HexToAddress("0x000000000000000000000000000000000000dEaD")

	tx := mustSignTx(t, key, chainID, 0, &to, big.NewInt(0), 60_000_001, nil) // 1 over the 60,000,000 test block gas limit
	if _, err := seq.SubmitTx(tx); !errors.Is(err, ErrGasLimitExceeded) {
		t.Errorf("tx.Gas() over the block gas limit: err = %v, want ErrGasLimitExceeded", err)
	}
}

// TestZeroBalanceSenderZeroGasPrice is the free-gas policy's core proof:
// a 0-value, 0-gasPrice tx from an account with no funds at all must
// succeed (MASTER §3's "burner wallets need no funding"), but a value
// transfer from that same still-empty account must still fail — free gas
// does not mean free value.
func TestZeroBalanceSenderZeroGasPrice(t *testing.T) {
	seq, _ := newTestSequencer(t)
	chainID := big.NewInt(testChainID)
	to := common.HexToAddress("0x000000000000000000000000000000000000dEaD")

	poorKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	freeTx := mustSignTx(t, poorKey, chainID, 0, &to, big.NewInt(0), 21_000, nil)
	if _, err := seq.SubmitTx(freeTx); err != nil {
		t.Errorf("0-value 0-gasPrice tx from a 0-balance sender failed: %v", err)
	}

	valueTx := mustSignTx(t, poorKey, chainID, 1, &to, big.NewInt(1), 21_000, nil)
	if _, err := seq.SubmitTx(valueTx); !errors.Is(err, ErrInsufficientFunds) {
		t.Errorf("value transfer from a 0-balance sender: err = %v, want ErrInsufficientFunds", err)
	}
}

func TestTimestampsStrictlyIncreaseAcrossBlocks(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)
	to := common.HexToAddress("0x000000000000000000000000000000000000dEaD")

	var timestamps []uint64
	for i := uint64(0); i < 3; i++ {
		tx := mustSignTx(t, key, chainID, i, &to, big.NewInt(0), 21_000, nil)
		receipt, err := seq.SubmitTx(tx)
		if err != nil {
			t.Fatalf("SubmitTx %d: %v", i, err)
		}
		header, err := seq.HeaderByNumber(receipt.BlockNumber.Uint64())
		if err != nil {
			t.Fatalf("HeaderByNumber: %v", err)
		}
		timestamps = append(timestamps, header.Time)
	}

	for i := 1; i < len(timestamps); i++ {
		if timestamps[i] <= timestamps[i-1] {
			t.Errorf("timestamp[%d]=%d not strictly greater than timestamp[%d]=%d", i, timestamps[i], i-1, timestamps[i-1])
		}
	}
}

// TestDevOffsetShiftsTimestampForward proves nextTimestamp's devOffset
// input actually moves the sealed block's timestamp by comparing two
// consecutive blocks' timestamps — one sealed before SetDevOffset, one
// after — rather than comparing against parent.Time directly: real
// wall-clock unix time (billions of seconds since 1970) would swamp a
// same-magnitude comparison against a threshold derived from genesis'
// Time=0, making that comparison pass trivially regardless of whether
// devOffset did anything. SetDevOffset is the hook M07's evm_increaseTime
// will drive later.
func TestDevOffsetShiftsTimestampForward(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)
	to := common.HexToAddress("0x000000000000000000000000000000000000dEaD")

	baselineTx := mustSignTx(t, key, chainID, 0, &to, big.NewInt(0), 21_000, nil)
	baselineReceipt, err := seq.SubmitTx(baselineTx)
	if err != nil {
		t.Fatalf("baseline SubmitTx: %v", err)
	}
	baselineHeader, err := seq.HeaderByNumber(baselineReceipt.BlockNumber.Uint64())
	if err != nil {
		t.Fatalf("HeaderByNumber: %v", err)
	}

	seq.SetDevOffset(24 * time.Hour)

	shiftedTx := mustSignTx(t, key, chainID, 1, &to, big.NewInt(0), 21_000, nil)
	shiftedReceipt, err := seq.SubmitTx(shiftedTx)
	if err != nil {
		t.Fatalf("shifted SubmitTx: %v", err)
	}
	shiftedHeader, err := seq.HeaderByNumber(shiftedReceipt.BlockNumber.Uint64())
	if err != nil {
		t.Fatalf("HeaderByNumber: %v", err)
	}

	delta := shiftedHeader.Time - baselineHeader.Time
	const wantDelta = 24 * 60 * 60
	const tolerance = 5 // seconds of test-execution slack
	if delta < wantDelta-tolerance || delta > wantDelta+tolerance {
		t.Errorf("timestamp delta after a 24h SetDevOffset = %ds, want ~%ds", delta, wantDelta)
	}
}

func TestThreeLogsHaveSequentialIndexAndBloomContainsAddress(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)

	_, addr := deploy(t, seq, key, chainID, 0, logRuntime())

	tx := mustSignTx(t, key, chainID, 1, &addr, big.NewInt(0), 100_000, nil)
	receipt, err := seq.SubmitTx(tx)
	if err != nil {
		t.Fatalf("SubmitTx: %v", err)
	}

	if len(receipt.Logs) != 3 {
		t.Fatalf("len(Logs) = %d, want 3", len(receipt.Logs))
	}
	for i, l := range receipt.Logs {
		if l.Index != uint(i) {
			t.Errorf("log[%d].Index = %d, want %d", i, l.Index, i)
		}
		if l.Address != addr {
			t.Errorf("log[%d].Address = %s, want %s", i, l.Address, addr)
		}
	}

	header, err := seq.HeaderByNumber(receipt.BlockNumber.Uint64())
	if err != nil {
		t.Fatalf("HeaderByNumber: %v", err)
	}
	if !header.Bloom.Test(addr.Bytes()) {
		t.Error("block bloom does not contain the emitting contract's address")
	}
}

func TestMineEmptyBlockAdvancesHeightWithSameRoot(t *testing.T) {
	seq, db := newTestSequencer(t)

	parent, err := seq.currentHeader()
	if err != nil {
		t.Fatalf("currentHeader: %v", err)
	}
	before := state.Height(db)

	block, err := seq.MineEmptyBlock()
	if err != nil {
		t.Fatalf("MineEmptyBlock: %v", err)
	}

	if got, want := state.Height(db), before+1; got != want {
		t.Errorf("height = %d, want %d", got, want)
	}
	if block.Root() != parent.Root {
		t.Errorf("empty block's Root = %s, want unchanged parent root %s", block.Root(), parent.Root)
	}
	if len(block.Transactions()) != 0 {
		t.Errorf("empty block has %d transactions, want 0", len(block.Transactions()))
	}
}

func TestEstimateGasFindsTheExactMinimumForASimpleTransfer(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	from := crypto.PubkeyToAddress(key.PublicKey)
	to := common.HexToAddress("0x000000000000000000000000000000000000dEaD")

	estimate, err := seq.EstimateGas(CallMsg{From: from, To: &to})
	if err != nil {
		t.Fatalf("EstimateGas: %v", err)
	}
	// A bare value-less call to a plain (non-contract) address costs exactly
	// the 21,000 intrinsic minimum, and the binary search finds it exactly —
	// no padding. Through M07 this returned 23,100 (a flat 10% pad), which
	// was both loose here and, more importantly, *insufficient* for any
	// transaction earning gas refunds; see EstimateGas's doc comment and
	// TestEstimateGasCoversStorageRefunds.
	if want := uint64(21_000); estimate != want {
		t.Errorf("EstimateGas = %d, want exactly %d", estimate, want)
	}
}

func TestSubmitTxPublishesNewBlockEvent(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)
	to := common.HexToAddress("0x000000000000000000000000000000000000dEaD")

	events := seq.Subscribe(1)

	tx := mustSignTx(t, key, chainID, 0, &to, big.NewInt(0), 21_000, nil)
	receipt, err := seq.SubmitTx(tx)
	if err != nil {
		t.Fatalf("SubmitTx: %v", err)
	}

	select {
	case ev := <-events:
		if ev.Block.NumberU64() != receipt.BlockNumber.Uint64() {
			t.Errorf("event block number = %d, want %d", ev.Block.NumberU64(), receipt.BlockNumber.Uint64())
		}
	default:
		t.Error("no NewBlockEvent published after SubmitTx")
	}
}
