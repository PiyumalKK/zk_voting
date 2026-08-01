package rpc

import (
	"encoding/json"
	"math/big"
	"strconv"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

// Tests for the write half of the eth_* namespace (M05). They exercise the
// methods through the full HTTP + JSON-RPC stack (newTestMux), not by
// calling the Go methods directly, because most of what M05 has to get right
// is the *encoding*: which fields appear in a receipt, whether an unknown
// hash is a null result or an error, and what a revert's JSON error object
// looks like. Calling the Go methods directly would skip exactly that layer.

var testRecipient = common.HexToAddress("0x00000000000000000000000000000000000000aa")

// unquote decodes a JSON string value (every hex quantity, hash and address
// in a JSON-RPC response is one) into its bare Go string, failing the test if
// it isn't a string at all.
func unquote(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatalf("expected a JSON string, got %s: %v", raw, err)
	}
	return s
}

// hexQuantity renders v the way the JSON-RPC spec requires quantities to be
// encoded: "0x"-prefixed, lowercase, no leading zeros.
func hexQuantity(v uint64) string { return "0x" + strconv.FormatUint(v, 16) }

func TestSendRawTransactionMinesEachTxType(t *testing.T) {
	chainID := big.NewInt(testChainID)
	key := mustTestKey(t)

	// One sub-test per transaction type, each against its own fresh chain so
	// nonces stay at 0 and the assertions don't depend on ordering. MASTER
	// §10 pitfall 3: legacy must never break (mobile sends it), and 1559
	// must work (hardhat-deploy's ethers v6 sends it).
	tests := []struct {
		name     string
		build    func() *types.Transaction
		wantType uint64
	}{
		{
			name: "legacy",
			build: func() *types.Transaction {
				return mustSignLegacyTx(t, key, chainID, 0, &testRecipient, big.NewInt(7), 21_000, nil)
			},
			wantType: uint64(types.LegacyTxType),
		},
		{
			name: "eip-2930 access list",
			build: func() *types.Transaction {
				return mustSignAccessListTx(t, key, chainID, 0, &testRecipient, big.NewInt(7), 21_000, nil)
			},
			wantType: uint64(types.AccessListTxType),
		},
		{
			name: "eip-1559 dynamic fee",
			build: func() *types.Transaction {
				return mustSignDynamicFeeTx(t, key, chainID, 0, &testRecipient, big.NewInt(7), 21_000, nil)
			},
			wantType: uint64(types.DynamicFeeTxType),
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			seq := newTestSequencer(t)
			handler := newTestMux(t, seq)
			tx := tc.build()

			_, resp := callRPC(t, handler, nonLoopback, "eth_sendRawTransaction", rawTxHex(t, tx))
			gotHash := decodeResult[string](t, resp)
			if gotHash != tx.Hash().Hex() {
				t.Errorf("returned hash = %s, want %s", gotHash, tx.Hash().Hex())
			}

			_, resp = callRPC(t, handler, nonLoopback, "eth_blockNumber")
			if got := decodeResult[string](t, resp); got != "0x1" {
				t.Errorf("eth_blockNumber after one tx = %s, want 0x1", got)
			}

			_, resp = callRPC(t, handler, nonLoopback, "eth_getBalance", jsonAddr(testRecipient), "latest")
			if got := decodeResult[string](t, resp); got != "0x7" {
				t.Errorf("recipient balance = %s, want 0x7", got)
			}

			_, resp = callRPC(t, handler, nonLoopback, "eth_getTransactionReceipt", tx.Hash().Hex())
			receipt := decodeResult[map[string]json.RawMessage](t, resp)
			if got := unquote(t, receipt["type"]); got != hexQuantity(tc.wantType) {
				t.Errorf("receipt.type = %s, want %s", got, hexQuantity(tc.wantType))
			}
			if got := unquote(t, receipt["status"]); got != "0x1" {
				t.Errorf("receipt.status = %s, want 0x1", got)
			}
		})
	}
}

// TestGetTransactionReceiptHasEveryFieldViemAwaits pins MASTER §10 pitfall 5.
// A missing receipt field does not surface as an error — it makes viem hang
// or mis-decode somewhere unrelated — so the guard has to be an explicit
// key-presence check, not a "does it decode" check.
func TestGetTransactionReceiptHasEveryFieldViemAwaits(t *testing.T) {
	seq := newTestSequencer(t)
	handler := newTestMux(t, seq)
	key := mustTestKey(t)
	chainID := big.NewInt(testChainID)

	tx := mustSignLegacyTx(t, key, chainID, 0, &testRecipient, big.NewInt(1), 21_000, nil)
	_, resp := callRPC(t, handler, nonLoopback, "eth_sendRawTransaction", rawTxHex(t, tx))
	decodeResult[string](t, resp)

	_, resp = callRPC(t, handler, nonLoopback, "eth_getTransactionReceipt", tx.Hash().Hex())
	receipt := decodeResult[map[string]json.RawMessage](t, resp)

	required := []string{
		"transactionHash", "transactionIndex", "blockHash", "blockNumber",
		"from", "to", "cumulativeGasUsed", "gasUsed", "contractAddress",
		"logs", "logsBloom", "status", "type", "effectiveGasPrice",
	}
	for _, field := range required {
		if _, ok := receipt[field]; !ok {
			t.Errorf("receipt is missing field %q", field)
		}
	}

	if got := unquote(t, receipt["to"]); got != jsonAddr(testRecipient) {
		t.Errorf("receipt.to = %s, want %s", got, jsonAddr(testRecipient))
	}
	// A non-creation transaction must report contractAddress as JSON null,
	// not the zero address — consumers branch on its nullness.
	if got := strings.TrimSpace(string(receipt["contractAddress"])); got != "null" {
		t.Errorf("receipt.contractAddress = %s, want null for a non-creation tx", got)
	}
	if got := unquote(t, receipt["effectiveGasPrice"]); got != "0x0" {
		t.Errorf("receipt.effectiveGasPrice = %s, want 0x0 (free-gas policy)", got)
	}
	if got := unquote(t, receipt["gasUsed"]); got != "0x5208" {
		t.Errorf("receipt.gasUsed = %s, want 0x5208 (21000, a bare transfer)", got)
	}
	if got := unquote(t, receipt["cumulativeGasUsed"]); got != "0x5208" {
		t.Errorf("receipt.cumulativeGasUsed = %s, want 0x5208 (single-tx block)", got)
	}
	if got := unquote(t, receipt["blockNumber"]); got != "0x1" {
		t.Errorf("receipt.blockNumber = %s, want 0x1", got)
	}
	// logs must be [] and never null.
	if got := strings.TrimSpace(string(receipt["logs"])); got != "[]" {
		t.Errorf("receipt.logs = %s, want [] for a tx that emitted none", got)
	}
}

func TestGetTransactionReceiptOfCreationCarriesContractAddress(t *testing.T) {
	seq := newTestSequencer(t)
	handler := newTestMux(t, seq)
	key := mustTestKey(t)
	chainID := big.NewInt(testChainID)

	tx := mustSignLegacyTx(t, key, chainID, 0, nil, big.NewInt(0), 500_000, buildInitCode(returnFortyTwoRuntime()))
	_, resp := callRPC(t, handler, nonLoopback, "eth_sendRawTransaction", rawTxHex(t, tx))
	decodeResult[string](t, resp)

	_, resp = callRPC(t, handler, nonLoopback, "eth_getTransactionReceipt", tx.Hash().Hex())
	receipt := decodeResult[map[string]json.RawMessage](t, resp)

	if got := strings.TrimSpace(string(receipt["to"])); got != "null" {
		t.Errorf("receipt.to = %s, want null for a creation", got)
	}
	addr := unquote(t, receipt["contractAddress"])
	if addr == "" || addr == jsonAddr(common.Address{}) {
		t.Fatalf("receipt.contractAddress = %q, want a real deployed address", addr)
	}

	// The reported address must actually hold the deployed code.
	_, resp = callRPC(t, handler, nonLoopback, "eth_getCode", addr, "latest")
	if code := decodeResult[string](t, resp); code == "0x" {
		t.Errorf("eth_getCode(%s) is empty — contractAddress points at nothing", addr)
	}
}

func TestReceiptLogsAreFullyAnnotated(t *testing.T) {
	seq := newTestSequencer(t)
	handler := newTestMux(t, seq)
	key := mustTestKey(t)
	chainID := big.NewInt(testChainID)

	emitter := deployContract(t, seq, key, chainID, 0, logRuntime())

	tx := mustSignLegacyTx(t, key, chainID, 1, &emitter, big.NewInt(0), 200_000, []byte{0x01})
	_, resp := callRPC(t, handler, nonLoopback, "eth_sendRawTransaction", rawTxHex(t, tx))
	decodeResult[string](t, resp)

	_, resp = callRPC(t, handler, nonLoopback, "eth_getTransactionReceipt", tx.Hash().Hex())
	receipt := decodeResult[map[string]json.RawMessage](t, resp)

	var logs []map[string]json.RawMessage
	if err := json.Unmarshal(receipt["logs"], &logs); err != nil {
		t.Fatalf("decode receipt.logs: %v (raw: %s)", err, receipt["logs"])
	}
	if len(logs) != 2 {
		t.Fatalf("receipt has %d logs, want 2", len(logs))
	}

	for i, l := range logs {
		for _, field := range []string{"address", "topics", "data", "blockNumber", "blockHash", "transactionHash", "transactionIndex", "logIndex", "removed"} {
			if _, ok := l[field]; !ok {
				t.Errorf("log[%d] is missing field %q", i, field)
			}
		}
		if got := unquote(t, l["logIndex"]); got != hexQuantity(uint64(i)) {
			t.Errorf("log[%d].logIndex = %s, want %s", i, got, hexQuantity(uint64(i)))
		}
		if got := unquote(t, l["address"]); got != jsonAddr(emitter) {
			t.Errorf("log[%d].address = %s, want %s", i, got, jsonAddr(emitter))
		}
		if got := unquote(t, l["transactionHash"]); got != tx.Hash().Hex() {
			t.Errorf("log[%d].transactionHash = %s, want %s", i, got, tx.Hash().Hex())
		}
		if got := unquote(t, l["transactionIndex"]); got != "0x0" {
			t.Errorf("log[%d].transactionIndex = %s, want 0x0", i, got)
		}
	}
}

func TestGetTransactionByHashShape(t *testing.T) {
	seq := newTestSequencer(t)
	handler := newTestMux(t, seq)
	key := mustTestKey(t)
	chainID := big.NewInt(testChainID)

	// 30,000 gas, not the bare 21,000 floor: this transaction carries two
	// bytes of calldata (the `input` field asserted below), and intrinsic gas
	// charges 16 per non-zero calldata byte on top of the 21,000 base — so
	// 21,000 is 32 gas short and the transaction can never be included.
	// Caught by this test failing with "have 21000, want 21032".
	tx := mustSignLegacyTx(t, key, chainID, 0, &testRecipient, big.NewInt(3), 30_000, []byte{0xca, 0xfe})
	_, resp := callRPC(t, handler, nonLoopback, "eth_sendRawTransaction", rawTxHex(t, tx))
	decodeResult[string](t, resp)

	_, resp = callRPC(t, handler, nonLoopback, "eth_getTransactionByHash", tx.Hash().Hex())
	got := decodeResult[map[string]json.RawMessage](t, resp)

	for _, field := range []string{"blockHash", "blockNumber", "from", "gas", "gasPrice", "hash", "input", "nonce", "to", "transactionIndex", "value", "type", "v", "r", "s"} {
		if _, ok := got[field]; !ok {
			t.Errorf("transaction is missing field %q", field)
		}
	}
	if v := unquote(t, got["hash"]); v != tx.Hash().Hex() {
		t.Errorf("hash = %s, want %s", v, tx.Hash().Hex())
	}
	if v := unquote(t, got["input"]); v != "0xcafe" {
		t.Errorf("input = %s, want 0xcafe", v)
	}
	if v := unquote(t, got["blockNumber"]); v != "0x1" {
		t.Errorf("blockNumber = %s, want 0x1", v)
	}
	// Never pending: every tx this chain knows about is already mined.
	if v := strings.TrimSpace(string(got["blockHash"])); v == "null" {
		t.Error("blockHash is null — no transaction is ever pending on this chain")
	}
}

// TestUnknownHashIsNullNotError guards the single most load-bearing detail
// of M05: viem's waitForTransactionReceipt polls eth_getTransactionReceipt
// and treats a JSON-RPC *error* as a hard failure, so an unknown hash must
// come back as a null result.
func TestUnknownHashIsNullNotError(t *testing.T) {
	seq := newTestSequencer(t)
	handler := newTestMux(t, seq)

	unknown := common.Hash{0xde, 0xad}.Hex()
	for _, method := range []string{"eth_getTransactionByHash", "eth_getTransactionReceipt"} {
		t.Run(method, func(t *testing.T) {
			_, resp := callRPC(t, handler, nonLoopback, method, unknown)
			if resp.Error != nil {
				t.Fatalf("unknown hash produced an RPC error: code=%d msg=%q", resp.Error.Code, resp.Error.Message)
			}
			if got := strings.TrimSpace(string(resp.Result)); got != "null" {
				t.Errorf("result = %s, want null", got)
			}
		})
	}
}

// TestRevertingTxIsRejectedAndNotMined is MASTER §10 pitfalls 1 and 2
// together: the revert surfaces from eth_sendRawTransaction itself, carrying
// the raw revert bytes in `data` so viem can decode a custom Solidity error,
// and the chain head does not move.
func TestRevertingTxIsRejectedAndNotMined(t *testing.T) {
	seq := newTestSequencer(t)
	handler := newTestMux(t, seq)
	key := mustTestKey(t)
	chainID := big.NewInt(testChainID)

	customError := []byte{0xde, 0xad, 0xbe, 0xef}
	target := deployContract(t, seq, key, chainID, 0, revertWithDataRuntime(customError))

	_, resp := callRPC(t, handler, nonLoopback, "eth_blockNumber")
	before := decodeResult[string](t, resp)

	tx := mustSignLegacyTx(t, key, chainID, 1, &target, big.NewInt(0), 200_000, nil)
	_, resp = callRPC(t, handler, nonLoopback, "eth_sendRawTransaction", rawTxHex(t, tx))

	if resp.Error == nil {
		t.Fatal("reverting tx was accepted; want an execution-revert error")
	}
	if resp.Error.Code != revertErrorCode {
		t.Errorf("error code = %d, want %d", resp.Error.Code, revertErrorCode)
	}
	if got := unquote(t, resp.Error.Data); got != "0xdeadbeef" {
		t.Errorf("error data = %s, want 0xdeadbeef", got)
	}
	if !strings.Contains(resp.Error.Message, "execution reverted") {
		t.Errorf("error message = %q, want it to contain %q", resp.Error.Message, "execution reverted")
	}

	_, resp = callRPC(t, handler, nonLoopback, "eth_blockNumber")
	if after := decodeResult[string](t, resp); after != before {
		t.Errorf("head moved from %s to %s — a reverting tx must not be mined", before, after)
	}
	_, resp = callRPC(t, handler, nonLoopback, "eth_getTransactionReceipt", tx.Hash().Hex())
	if got := strings.TrimSpace(string(resp.Result)); got != "null" {
		t.Errorf("reverted tx has a receipt (%s); it should never have been mined", got)
	}
}

// TestRevertWithReasonStringDecodesIntoMessage covers the other revert
// shape: a plain `require(false, "boom")`, whose Error(string) payload is
// decoded into the message while `data` still carries the raw bytes.
func TestRevertWithReasonStringDecodesIntoMessage(t *testing.T) {
	seq := newTestSequencer(t)
	handler := newTestMux(t, seq)
	key := mustTestKey(t)
	chainID := big.NewInt(testChainID)

	payload := encodeErrorString("boom")
	target := deployContract(t, seq, key, chainID, 0, revertWithDataRuntime(payload))

	tx := mustSignLegacyTx(t, key, chainID, 1, &target, big.NewInt(0), 200_000, nil)
	_, resp := callRPC(t, handler, nonLoopback, "eth_sendRawTransaction", rawTxHex(t, tx))

	if resp.Error == nil {
		t.Fatal("reverting tx was accepted; want an execution-revert error")
	}
	if want := "execution reverted: boom"; resp.Error.Message != want {
		t.Errorf("error message = %q, want %q", resp.Error.Message, want)
	}
}

// TestValidationErrorsMatchHardhatWording pins the strings the mobile and
// web clients substring-match. See mapSubmitError's doc comment for how
// these were derived and how e2e/diff/write.mjs re-verifies them against a
// real hardhat node.
func TestValidationErrorsMatchHardhatWording(t *testing.T) {
	chainID := big.NewInt(testChainID)
	key := mustTestKey(t)

	tests := []struct {
		name     string
		build    func(t *testing.T) *types.Transaction
		wantSubs []string
	}{
		{
			name: "nonce too high",
			build: func(t *testing.T) *types.Transaction {
				return mustSignLegacyTx(t, key, chainID, 5, &testRecipient, big.NewInt(1), 21_000, nil)
			},
			wantSubs: []string{"Nonce too high", "Expected nonce to be 0 but got 5"},
		},
		{
			name: "wrong chain id",
			build: func(t *testing.T) *types.Transaction {
				return mustSignLegacyTx(t, key, big.NewInt(1), 0, &testRecipient, big.NewInt(1), 21_000, nil)
			},
			wantSubs: []string{"invalid chainId", "9494"},
		},
		{
			name: "gas limit over the block gas limit",
			build: func(t *testing.T) *types.Transaction {
				return mustSignLegacyTx(t, key, chainID, 0, &testRecipient, big.NewInt(1), 60_000_001, nil)
			},
			wantSubs: []string{"Transaction gas limit is 60000001", "exceeds block gas limit of 60000000"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			seq := newTestSequencer(t)
			handler := newTestMux(t, seq)

			_, resp := callRPC(t, handler, nonLoopback, "eth_sendRawTransaction", rawTxHex(t, tc.build(t)))
			if resp.Error == nil {
				t.Fatal("submission succeeded; want a validation error")
			}
			if resp.Error.Code != invalidInputCode {
				t.Errorf("error code = %d, want %d", resp.Error.Code, invalidInputCode)
			}
			for _, sub := range tc.wantSubs {
				if !strings.Contains(resp.Error.Message, sub) {
					t.Errorf("error message = %q, want it to contain %q", resp.Error.Message, sub)
				}
			}
		})
	}
}

func TestNonceTooLowOnReplay(t *testing.T) {
	seq := newTestSequencer(t)
	handler := newTestMux(t, seq)
	key := mustTestKey(t)
	chainID := big.NewInt(testChainID)

	tx := mustSignLegacyTx(t, key, chainID, 0, &testRecipient, big.NewInt(1), 21_000, nil)
	raw := rawTxHex(t, tx)

	_, resp := callRPC(t, handler, nonLoopback, "eth_sendRawTransaction", raw)
	decodeResult[string](t, resp)

	_, resp = callRPC(t, handler, nonLoopback, "eth_sendRawTransaction", raw)
	if resp.Error == nil {
		t.Fatal("replaying a mined tx succeeded; want nonce-too-low")
	}
	if resp.Error.Code != invalidInputCode {
		t.Errorf("error code = %d, want %d", resp.Error.Code, invalidInputCode)
	}
	for _, sub := range []string{"Nonce too low", "Expected nonce to be 1 but got 0"} {
		if !strings.Contains(resp.Error.Message, sub) {
			t.Errorf("error message = %q, want it to contain %q", resp.Error.Message, sub)
		}
	}
}

func TestMalformedRawTransactionIsRejected(t *testing.T) {
	seq := newTestSequencer(t)
	handler := newTestMux(t, seq)

	for _, raw := range []string{"0x", "0xdeadbeef"} {
		t.Run(raw, func(t *testing.T) {
			_, resp := callRPC(t, handler, nonLoopback, "eth_sendRawTransaction", raw)
			if resp.Error == nil {
				t.Fatalf("undecodable payload %s was accepted", raw)
			}
		})
	}
}

func TestBlockTransactionCountMethods(t *testing.T) {
	seq := newTestSequencer(t)
	handler := newTestMux(t, seq)
	key := mustTestKey(t)
	chainID := big.NewInt(testChainID)

	tx := mustSignLegacyTx(t, key, chainID, 0, &testRecipient, big.NewInt(1), 21_000, nil)
	_, resp := callRPC(t, handler, nonLoopback, "eth_sendRawTransaction", rawTxHex(t, tx))
	decodeResult[string](t, resp)

	_, resp = callRPC(t, handler, nonLoopback, "eth_getBlockTransactionCountByNumber", "0x1")
	if got := decodeResult[string](t, resp); got != "0x1" {
		t.Errorf("count for block 1 = %s, want 0x1", got)
	}
	_, resp = callRPC(t, handler, nonLoopback, "eth_getBlockTransactionCountByNumber", "0x0")
	if got := decodeResult[string](t, resp); got != "0x0" {
		t.Errorf("count for genesis = %s, want 0x0", got)
	}

	_, resp = callRPC(t, handler, nonLoopback, "eth_getBlockByNumber", "0x1", false)
	block := decodeResult[map[string]json.RawMessage](t, resp)
	blockHash := unquote(t, block["hash"])

	_, resp = callRPC(t, handler, nonLoopback, "eth_getBlockTransactionCountByHash", blockHash)
	if got := decodeResult[string](t, resp); got != "0x1" {
		t.Errorf("count by hash = %s, want 0x1", got)
	}

	_, resp = callRPC(t, handler, nonLoopback, "eth_getBlockTransactionCountByNumber", "0x63")
	if got := strings.TrimSpace(string(resp.Result)); got != "null" {
		t.Errorf("count for an unmined block = %s, want null", got)
	}
}
