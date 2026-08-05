package rpc

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	gethrpc "github.com/ethereum/go-ethereum/rpc"
)

// jsonAddr renders addr the way encoding/json marshals a common.Address
// (via MarshalText -> hexutil.Bytes): plain lowercase hex, NOT the
// EIP-55-checksummed mixed case addr.Hex()/String() produce. Response
// bodies must be compared against this, not against addr.Hex() directly.
func jsonAddr(addr common.Address) string {
	return strings.ToLower(addr.Hex())
}

// nonLoopback is a stand-in RemoteAddr for requests that should look like
// they came from a real external client — most eth_* tests don't care
// about rate limiting, but using a fixed loopback-looking address for all
// of them would silently mask a rate-limiter bug that only bites real
// clients. newTestMux configures a rate limit generous enough (1000 rps)
// that this doesn't make ordinary tests flaky.
const nonLoopback = "203.0.113.7:54321"

func decodeResult[T any](t *testing.T, resp rpcResponse) T {
	t.Helper()
	var v T
	if resp.Error != nil {
		t.Fatalf("unexpected RPC error: code=%d msg=%q data=%s", resp.Error.Code, resp.Error.Message, resp.Error.Data)
	}
	if err := json.Unmarshal(resp.Result, &v); err != nil {
		t.Fatalf("decode result into %T: %v (raw: %s)", v, err, resp.Result)
	}
	return v
}

func TestChainMetadataMethods(t *testing.T) {
	seq := newTestSequencer(t)
	handler := newTestMux(t, seq)

	rec, resp := callRPC(t, handler, nonLoopback, "eth_chainId")
	if rec.Code != http.StatusOK {
		t.Fatalf("eth_chainId status = %d", rec.Code)
	}
	if got := decodeResult[string](t, resp); got != fmt.Sprintf("0x%x", testChainID) {
		t.Errorf("eth_chainId = %s, want 0x%x", got, testChainID)
	}

	_, resp = callRPC(t, handler, nonLoopback, "eth_blockNumber")
	if got := decodeResult[string](t, resp); got != "0x0" {
		t.Errorf("eth_blockNumber (genesis) = %s, want 0x0", got)
	}

	_, resp = callRPC(t, handler, nonLoopback, "eth_syncing")
	if got := decodeResult[bool](t, resp); got != false {
		t.Errorf("eth_syncing = %v, want false", got)
	}

	_, resp = callRPC(t, handler, nonLoopback, "eth_accounts")
	if got := decodeResult[[]string](t, resp); len(got) != 0 {
		t.Errorf("eth_accounts = %v, want empty", got)
	}

	_, resp = callRPC(t, handler, nonLoopback, "net_version")
	if got := decodeResult[string](t, resp); got != fmt.Sprintf("%d", testChainID) {
		t.Errorf("net_version = %s, want %d", got, testChainID)
	}

	_, resp = callRPC(t, handler, nonLoopback, "net_listening")
	if got := decodeResult[bool](t, resp); !got {
		t.Errorf("net_listening = %v, want true", got)
	}

	// The default mode, asserted against the constant so that M07's
	// CLIENT_VERSION_MODE switch (covered separately by
	// TestClientVersionModeSwitchesTheReportedString) can't drift this test
	// into a confusing failure.
	_, resp = callRPC(t, handler, nonLoopback, "web3_clientVersion")
	if got := decodeResult[string](t, resp); got != DefaultClientVersion {
		t.Errorf("web3_clientVersion = %q, want %q", got, DefaultClientVersion)
	}

	_, resp = callRPC(t, handler, nonLoopback, "eth_gasPrice")
	if got := decodeResult[string](t, resp); got != "0x0" {
		t.Errorf("eth_gasPrice = %s, want 0x0", got)
	}

	_, resp = callRPC(t, handler, nonLoopback, "eth_maxPriorityFeePerGas")
	if got := decodeResult[string](t, resp); got != "0x0" {
		t.Errorf("eth_maxPriorityFeePerGas = %s, want 0x0", got)
	}
}

func TestGetBalanceBlockTagHandling(t *testing.T) {
	seq := newTestSequencer(t)
	key := mustTestKey(t)
	from := crypto.PubkeyToAddress(key.PublicKey)
	handler := newTestMux(t, seq)

	wantWei := new(big.Int).Mul(big.NewInt(10_000), big.NewInt(1_000_000_000_000_000_000))
	wantHex := fmt.Sprintf("0x%x", wantWei)

	for _, tag := range []any{"latest", "earliest", "0x0", "pending", "safe", "finalized"} {
		_, resp := callRPC(t, handler, nonLoopback, "eth_getBalance", from.Hex(), tag)
		if got := decodeResult[string](t, resp); got != wantHex {
			t.Errorf("eth_getBalance(tag=%v) = %s, want %s", tag, got, wantHex)
		}
	}

	other := common.HexToAddress("0x000000000000000000000000000000000000dEaD")
	_, resp := callRPC(t, handler, nonLoopback, "eth_getBalance", other.Hex(), "latest")
	if got := decodeResult[string](t, resp); got != "0x0" {
		t.Errorf("eth_getBalance(untouched account) = %s, want 0x0", got)
	}
}

func TestGetTransactionCountTracksNonceAcrossBlockTags(t *testing.T) {
	seq := newTestSequencer(t)
	key := mustTestKey(t)
	from := crypto.PubkeyToAddress(key.PublicKey)
	chainID := big.NewInt(testChainID)
	to := common.HexToAddress("0x000000000000000000000000000000000000dEaD")
	handler := newTestMux(t, seq)

	_, resp := callRPC(t, handler, nonLoopback, "eth_getTransactionCount", from.Hex(), "latest")
	if got := decodeResult[string](t, resp); got != "0x0" {
		t.Errorf("nonce before any tx = %s, want 0x0", got)
	}

	tx := mustSignLegacyTx(t, key, chainID, 0, &to, big.NewInt(0), 21_000, nil)
	if _, err := seq.SubmitTx(tx); err != nil {
		t.Fatalf("SubmitTx: %v", err)
	}

	for _, tag := range []any{"latest", "pending"} {
		_, resp := callRPC(t, handler, nonLoopback, "eth_getTransactionCount", from.Hex(), tag)
		if got := decodeResult[string](t, resp); got != "0x1" {
			t.Errorf("nonce after 1 tx (tag=%v) = %s, want 0x1", tag, got)
		}
	}
	_, resp = callRPC(t, handler, nonLoopback, "eth_getTransactionCount", from.Hex(), "earliest")
	if got := decodeResult[string](t, resp); got != "0x0" {
		t.Errorf("nonce at earliest = %s, want 0x0", got)
	}
}

func TestGetCodeDeployedVsEOA(t *testing.T) {
	seq := newTestSequencer(t)
	key := mustTestKey(t)
	from := crypto.PubkeyToAddress(key.PublicKey)
	chainID := big.NewInt(testChainID)
	handler := newTestMux(t, seq)

	runtime := returnFortyTwoRuntime()
	addr := deployContract(t, seq, key, chainID, 0, runtime)

	_, resp := callRPC(t, handler, nonLoopback, "eth_getCode", addr.Hex(), "latest")
	got := decodeResult[string](t, resp)
	if got != "0x"+fmt.Sprintf("%x", runtime) {
		t.Errorf("eth_getCode(contract) = %s, want 0x%x", got, runtime)
	}

	_, resp = callRPC(t, handler, nonLoopback, "eth_getCode", from.Hex(), "latest")
	if got := decodeResult[string](t, resp); got != "0x" {
		t.Errorf("eth_getCode(EOA) = %s, want 0x", got)
	}
}

// TestGetStorageAtAcceptsShortHexPosition proves position is decoded as a
// variable-length hex quantity ("0x0"), not a fixed 32-byte value — a real
// eth_getStorageAt caller sends the former.
func TestGetStorageAtAcceptsShortHexPosition(t *testing.T) {
	seq := newTestSequencer(t)
	key := mustTestKey(t)
	chainID := big.NewInt(testChainID)
	handler := newTestMux(t, seq)

	// counterRuntime from internal/chain isn't reusable here (unexported,
	// different package); a plain SLOAD-and-return of slot 0 is enough to
	// prove position="0x0" resolves to slot 0.
	readSlotZero := []byte{
		byte(0x60), 0x00, // PUSH1 0x00
		byte(0x54),       // SLOAD
		byte(0x60), 0x00, // PUSH1 0x00
		byte(0x52),       // MSTORE
		byte(0x60), 0x20, // PUSH1 0x20
		byte(0x60), 0x00, // PUSH1 0x00
		byte(0xf3), // RETURN
	}
	addr := deployContract(t, seq, key, chainID, 0, readSlotZero)

	_, resp := callRPC(t, handler, nonLoopback, "eth_getStorageAt", addr.Hex(), "0x0", "latest")
	want := "0x" + fmt.Sprintf("%064x", 0)
	if got := decodeResult[string](t, resp); got != want {
		t.Errorf("eth_getStorageAt(position=0x0) = %s, want %s", got, want)
	}
}

func TestGetBlockByNumberFullTxAndHashOnly(t *testing.T) {
	seq := newTestSequencer(t)
	key := mustTestKey(t)
	from := crypto.PubkeyToAddress(key.PublicKey)
	chainID := big.NewInt(testChainID)
	to := common.HexToAddress("0x000000000000000000000000000000000000dEaD")
	handler := newTestMux(t, seq)

	tx := mustSignLegacyTx(t, key, chainID, 0, &to, big.NewInt(0), 21_000, nil)
	if _, err := seq.SubmitTx(tx); err != nil {
		t.Fatalf("SubmitTx: %v", err)
	}

	_, resp := callRPC(t, handler, nonLoopback, "eth_getBlockByNumber", "0x1", false)
	block := decodeResult[map[string]any](t, resp)
	if block["number"] != "0x1" {
		t.Errorf("block.number = %v, want 0x1", block["number"])
	}
	txs, ok := block["transactions"].([]any)
	if !ok || len(txs) != 1 {
		t.Fatalf("block.transactions = %v, want 1 hash", block["transactions"])
	}
	if hashStr, ok := txs[0].(string); !ok || hashStr != tx.Hash().Hex() {
		t.Errorf("block.transactions[0] = %v, want %s", txs[0], tx.Hash().Hex())
	}

	_, resp = callRPC(t, handler, nonLoopback, "eth_getBlockByNumber", "0x1", true)
	block = decodeResult[map[string]any](t, resp)
	txs, ok = block["transactions"].([]any)
	if !ok || len(txs) != 1 {
		t.Fatalf("block.transactions (fullTx) = %v, want 1 object", block["transactions"])
	}
	fullTx, ok := txs[0].(map[string]any)
	if !ok {
		t.Fatalf("block.transactions[0] (fullTx) = %v, want an object", txs[0])
	}
	if fullTx["from"] != jsonAddr(from) {
		t.Errorf("tx.from = %v, want %s", fullTx["from"], jsonAddr(from))
	}
	if fullTx["hash"] != tx.Hash().Hex() {
		t.Errorf("tx.hash = %v, want %s", fullTx["hash"], tx.Hash().Hex())
	}

	// Unresolvable block number -> JSON-RPC null result, not an error.
	rec, resp := callRPC(t, handler, nonLoopback, "eth_getBlockByNumber", "0x99", false)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if resp.Error != nil {
		t.Fatalf("unexpected error for unknown block: %+v", resp.Error)
	}
	if string(resp.Result) != "null" {
		t.Errorf("eth_getBlockByNumber(unknown) result = %s, want null", resp.Result)
	}
}

func TestGetBlockByHashKnownAndUnknown(t *testing.T) {
	seq := newTestSequencer(t)
	key := mustTestKey(t)
	chainID := big.NewInt(testChainID)
	to := common.HexToAddress("0x000000000000000000000000000000000000dEaD")
	handler := newTestMux(t, seq)

	tx := mustSignLegacyTx(t, key, chainID, 0, &to, big.NewInt(0), 21_000, nil)
	receipt, err := seq.SubmitTx(tx)
	if err != nil {
		t.Fatalf("SubmitTx: %v", err)
	}

	header, err := seq.HeaderForBlockTag(gethrpc.LatestBlockNumber)
	if err != nil {
		t.Fatalf("HeaderForBlockTag(latest): %v", err)
	}
	blockHash := header.Hash()
	if receipt.BlockHash != blockHash {
		t.Fatalf("test setup: receipt.BlockHash %s != resolved head hash %s", receipt.BlockHash, blockHash)
	}

	_, resp := callRPC(t, handler, nonLoopback, "eth_getBlockByHash", blockHash.Hex(), false)
	got := decodeResult[map[string]any](t, resp)
	if got["hash"] != blockHash.Hex() {
		t.Errorf("eth_getBlockByHash result.hash = %v, want %s", got["hash"], blockHash.Hex())
	}

	_, resp = callRPC(t, handler, nonLoopback, "eth_getBlockByHash", common.Hash{0x01}.Hex(), false)
	if string(resp.Result) != "null" {
		t.Errorf("eth_getBlockByHash(unknown) result = %s, want null", resp.Result)
	}
}

func TestCallReturnsValueAndRevertShapes(t *testing.T) {
	seq := newTestSequencer(t)
	key := mustTestKey(t)
	chainID := big.NewInt(testChainID)
	handler := newTestMux(t, seq)

	// --- success path ---
	addr := deployContract(t, seq, key, chainID, 0, returnFortyTwoRuntime())
	callArgs := map[string]any{"to": addr.Hex()}
	_, resp := callRPC(t, handler, nonLoopback, "eth_call", callArgs, "latest")
	got := decodeResult[string](t, resp)
	gotInt, ok := new(big.Int).SetString(got[2:], 16)
	if !ok {
		t.Fatalf("eth_call result %q is not valid hex", got)
	}
	if gotInt.Cmp(big.NewInt(42)) != 0 {
		t.Errorf("eth_call result = %s (%s), want 42", got, gotInt)
	}

	// --- custom error revert (no decodable reason string) ---
	customSelector := []byte{0xde, 0xad, 0xbe, 0xef}
	revertAddr := deployContract(t, seq, key, chainID, 1, revertWithDataRuntime(customSelector))
	_, resp = callRPC(t, handler, nonLoopback, "eth_call", map[string]any{"to": revertAddr.Hex()}, "latest")
	if resp.Error == nil {
		t.Fatal("eth_call to a reverting contract succeeded, want a JSON-RPC error")
	}
	if resp.Error.Code != 3 {
		t.Errorf("revert error code = %d, want 3", resp.Error.Code)
	}
	if resp.Error.Message != "execution reverted" {
		t.Errorf("revert error message = %q, want \"execution reverted\" (no decodable reason)", resp.Error.Message)
	}
	var dataHex string
	if err := json.Unmarshal(resp.Error.Data, &dataHex); err != nil {
		t.Fatalf("revert error data is not a JSON string: %v", err)
	}
	if dataHex != "0xdeadbeef" {
		t.Errorf("revert error data = %s, want 0xdeadbeef", dataHex)
	}

	// --- Error(string) revert (decodable reason) ---
	reasonAddr := deployContract(t, seq, key, chainID, 2, revertWithDataRuntime(encodeErrorString("boom")))
	_, resp = callRPC(t, handler, nonLoopback, "eth_call", map[string]any{"to": reasonAddr.Hex()}, "latest")
	if resp.Error == nil {
		t.Fatal("eth_call to a reason-reverting contract succeeded, want a JSON-RPC error")
	}
	if resp.Error.Message != "execution reverted: boom" {
		t.Errorf("revert error message = %q, want \"execution reverted: boom\"", resp.Error.Message)
	}
}

func TestEstimateGas(t *testing.T) {
	seq := newTestSequencer(t)
	key := mustTestKey(t)
	from := crypto.PubkeyToAddress(key.PublicKey)
	to := common.HexToAddress("0x000000000000000000000000000000000000dEaD")
	handler := newTestMux(t, seq)

	_, resp := callRPC(t, handler, nonLoopback, "eth_estimateGas", map[string]any{"from": from.Hex(), "to": to.Hex()})
	got := decodeResult[string](t, resp)
	// The exact intrinsic minimum for a bare transfer. Through M07 this was
	// padded by 10%; the estimator now binary-searches for the true minimum,
	// because a flat pad cannot fund a transaction earning gas refunds — see
	// Sequencer.EstimateGas and TestEstimateGasCoversStorageRefunds.
	want := fmt.Sprintf("0x%x", uint64(21_000))
	if got != want {
		t.Errorf("eth_estimateGas = %s, want %s", got, want)
	}
}

func TestFeeHistoryShape(t *testing.T) {
	seq := newTestSequencer(t)
	handler := newTestMux(t, seq)

	_, resp := callRPC(t, handler, nonLoopback, "eth_feeHistory", "0x4", "latest", []float64{25, 75})
	var result FeeHistoryResult
	if resp.Error != nil {
		t.Fatalf("unexpected error: %+v", resp.Error)
	}
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("decode FeeHistoryResult: %v", err)
	}
	if len(result.BaseFeePerGas) != 5 { // requested blockCount + 1
		t.Errorf("len(BaseFeePerGas) = %d, want 5", len(result.BaseFeePerGas))
	}
	if len(result.GasUsedRatio) != 4 {
		t.Errorf("len(GasUsedRatio) = %d, want 4", len(result.GasUsedRatio))
	}
	if len(result.Reward) != 4 {
		t.Errorf("len(Reward) = %d, want 4", len(result.Reward))
	}
	for _, row := range result.Reward {
		if len(row) != 2 {
			t.Errorf("reward row length = %d, want 2 (matching rewardPercentiles)", len(row))
		}
	}
}

func TestUnknownMethodReturnsMethodNotFound(t *testing.T) {
	seq := newTestSequencer(t)
	handler := newTestMux(t, seq)

	_, resp := callRPC(t, handler, nonLoopback, "eth_thisMethodDoesNotExist")
	if resp.Error == nil {
		t.Fatal("unknown method succeeded, want an error")
	}
	if resp.Error.Code != -32601 {
		t.Errorf("error code = %d, want -32601 (method not found)", resp.Error.Code)
	}
}

func TestMalformedParamsReturnsInvalidParams(t *testing.T) {
	seq := newTestSequencer(t)
	handler := newTestMux(t, seq)

	// "not-a-hex-address" cannot decode into common.Address.
	_, resp := callRPC(t, handler, nonLoopback, "eth_getBalance", "not-a-hex-address", "latest")
	if resp.Error == nil {
		t.Fatal("malformed address param succeeded, want an error")
	}
	if resp.Error.Code != -32602 {
		t.Errorf("error code = %d, want -32602 (invalid params)", resp.Error.Code)
	}
}

func TestBatchRequestsSupported(t *testing.T) {
	seq := newTestSequencer(t)
	handler := newTestMux(t, seq)

	batch := []rpcRequest{
		{JSONRPC: "2.0", ID: 1, Method: "eth_chainId", Params: []any{}},
		{JSONRPC: "2.0", ID: 2, Method: "eth_blockNumber", Params: []any{}},
	}
	body, err := json.Marshal(batch)
	if err != nil {
		t.Fatalf("marshal batch: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = nonLoopback
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("batch status = %d, body = %s", rec.Code, rec.Body.String())
	}

	var responses []rpcResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &responses); err != nil {
		t.Fatalf("batch response is not a JSON array: %v (body: %s)", err, rec.Body.String())
	}
	if len(responses) != 2 {
		t.Fatalf("batch response length = %d, want 2", len(responses))
	}
}
