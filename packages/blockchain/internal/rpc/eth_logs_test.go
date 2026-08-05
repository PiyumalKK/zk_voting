package rpc

import (
	"crypto/ecdsa"
	"encoding/json"
	"math/big"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
	gethrpc "github.com/ethereum/go-ethereum/rpc"

	"zk-blockchain/internal/chain"
)

// These tests drive eth_getLogs over the full HTTP + JSON-RPC stack rather
// than by calling EthLogsService's methods directly, for the same reason
// eth_write_test.go does: for this method the *encoding* is the deliverable.
// The filter object's polymorphic JSON (address as string-or-array, topics
// as null/string/array) can only be exercised as real JSON, and a result
// that marshals as `null` instead of `[]` is invisible to a Go-level call.
//
// The filter *semantics* (which logs match which constraints) are covered
// exhaustively at the chain level in internal/chain/logs_test.go; what is
// tested here is decoding, response shape and error mapping.

// logTopic mirrors logThreeRuntime's encoding: a single PUSH1 byte becomes
// that byte right-aligned in an otherwise-zero 32-byte word.
func logTopic(b byte) common.Hash {
	var h common.Hash
	h[len(h)-1] = b
	return h
}

const (
	rpcEmitterTopic0 byte = 0x11
	rpcEmitterTopic1 byte = 0x21
	rpcEmitterTopic2 byte = 0x31
	rpcEmitterData   byte = 0xa1

	rpcOtherTopic0 byte = 0x12
	rpcOtherTopic1 byte = 0x22
	rpcOtherTopic2 byte = 0x32
	rpcOtherData   byte = 0xa2
)

// logTestChain builds a chain with two LOG3-emitting contracts, each called
// once, and returns the mux plus both addresses.
func logTestChain(t *testing.T) (http.Handler, *chain.Sequencer, common.Address, common.Address) {
	t.Helper()
	seq := newTestSequencer(t)
	key := mustTestKey(t)
	chainID := big.NewInt(testChainID)

	emitter := deployContract(t, seq, key, chainID, 0, logThreeRuntime(rpcEmitterTopic0, rpcEmitterTopic1, rpcEmitterTopic2, rpcEmitterData))
	other := deployContract(t, seq, key, chainID, 1, logThreeRuntime(rpcOtherTopic0, rpcOtherTopic1, rpcOtherTopic2, rpcOtherData))

	callContract(t, seq, key, chainID, 2, emitter)
	callContract(t, seq, key, chainID, 3, other)

	return newTestMux(t, seq), seq, emitter, other
}

func callContract(t *testing.T, seq *chain.Sequencer, key *ecdsa.PrivateKey, chainID *big.Int, nonce uint64, to common.Address) *types.Receipt {
	t.Helper()
	tx := mustSignLegacyTx(t, key, chainID, nonce, &to, big.NewInt(0), 200_000, nil)
	receipt, err := seq.SubmitTx(tx)
	if err != nil {
		t.Fatalf("SubmitTx to %s: %v", to, err)
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		t.Fatalf("call to %s failed, status = %d", to, receipt.Status)
	}
	return receipt
}

// getLogs issues eth_getLogs with a filter object supplied as raw JSON, so
// each test controls the exact wire shape.
func getLogs(t *testing.T, handler http.Handler, filterJSON string) rpcResponse {
	t.Helper()
	var filter any
	if err := json.Unmarshal([]byte(filterJSON), &filter); err != nil {
		t.Fatalf("test filter is not valid JSON: %v (%s)", err, filterJSON)
	}
	_, resp := callRPC(t, handler, "", "eth_getLogs", filter)
	return resp
}

func decodeLogs(t *testing.T, resp rpcResponse) []RPCLog {
	t.Helper()
	if resp.Error != nil {
		t.Fatalf("eth_getLogs returned error %d: %s", resp.Error.Code, resp.Error.Message)
	}
	var logs []RPCLog
	if err := json.Unmarshal(resp.Result, &logs); err != nil {
		t.Fatalf("decode result %s: %v", resp.Result, err)
	}
	return logs
}

// ---------------------------------------------------------------------------
// Result shape

func TestGetLogsEmptyResultIsJSONArrayNotNull(t *testing.T) {
	handler, _, _, _ := logTestChain(t)

	resp := getLogs(t, handler, `{"fromBlock":"0x0","toBlock":"latest","address":"0x00000000000000000000000000000000deadbeef"}`)
	if resp.Error != nil {
		t.Fatalf("unexpected error: %+v", resp.Error)
	}

	// The exact bytes matter: viem maps over this result unconditionally, so
	// `null` fails somewhere far from here. Compared as a raw string rather
	// than after decoding, since decoding erases the distinction.
	if got := strings.TrimSpace(string(resp.Result)); got != "[]" {
		t.Fatalf("result = %s, want []", got)
	}
}

func TestGetLogsResponseCarriesEveryDerivedField(t *testing.T) {
	handler, _, emitter, _ := logTestChain(t)

	resp := getLogs(t, handler, `{"fromBlock":"0x0","toBlock":"latest","address":"`+emitter.Hex()+`"}`)

	var raw []map[string]json.RawMessage
	if err := json.Unmarshal(resp.Result, &raw); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if len(raw) != 1 {
		t.Fatalf("got %d logs, want 1", len(raw))
	}

	// MASTER M06 deliverable 3's exact list. A missing field here does not
	// raise an error anywhere downstream — it silently mis-decodes — which
	// is why the key set is asserted rather than just a few values.
	want := []string{
		"address", "topics", "data", "blockNumber", "transactionHash",
		"transactionIndex", "blockHash", "logIndex", "removed",
	}
	for _, key := range want {
		if _, ok := raw[0][key]; !ok {
			t.Errorf("log object is missing %q; got keys %v", key, keysOf(raw[0]))
		}
	}
	if len(raw[0]) != len(want) {
		t.Errorf("log object has %d keys %v, want exactly %d", len(raw[0]), keysOf(raw[0]), len(want))
	}

	logs := decodeLogs(t, resp)
	if logs[0].Address != emitter {
		t.Errorf("address = %s, want %s", logs[0].Address, emitter)
	}
	if logs[0].Removed {
		t.Error("removed = true; this chain never reorgs")
	}
	if len(logs[0].Topics) != 3 {
		t.Errorf("%d topics, want 3", len(logs[0].Topics))
	}
	if logs[0].BlockHash == (common.Hash{}) {
		t.Error("blockHash is zero")
	}
	if logs[0].TransactionHash == (common.Hash{}) {
		t.Error("transactionHash is zero")
	}
}

func keysOf(m map[string]json.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// ---------------------------------------------------------------------------
// Filter decoding, end to end over JSON

func TestGetLogsFilterShapesOverJSON(t *testing.T) {
	handler, _, emitter, other := logTestChain(t)

	tests := []struct {
		name   string
		filter string
		want   int
	}{
		{
			name:   "address as a single string",
			filter: `{"fromBlock":"0x0","toBlock":"latest","address":"` + emitter.Hex() + `"}`,
			want:   1,
		},
		{
			name:   "address as a one-element array",
			filter: `{"fromBlock":"0x0","toBlock":"latest","address":["` + emitter.Hex() + `"]}`,
			want:   1,
		},
		{
			name:   "address as a two-element array",
			filter: `{"fromBlock":"0x0","toBlock":"latest","address":["` + emitter.Hex() + `","` + other.Hex() + `"]}`,
			want:   2,
		},
		{
			name:   "address explicitly null matches any address",
			filter: `{"fromBlock":"0x0","toBlock":"latest","address":null}`,
			want:   2,
		},
		{
			name:   "topic0 as a string",
			filter: `{"fromBlock":"0x0","toBlock":"latest","topics":["` + logTopic(rpcEmitterTopic0).Hex() + `"]}`,
			want:   1,
		},
		{
			name:   "topic0 as an OR array",
			filter: `{"fromBlock":"0x0","toBlock":"latest","topics":[["` + logTopic(rpcEmitterTopic0).Hex() + `","` + logTopic(rpcOtherTopic0).Hex() + `"]]}`,
			want:   2,
		},
		{
			name:   "null topic0 is a wildcard, topic1 constrained",
			filter: `{"fromBlock":"0x0","toBlock":"latest","topics":[null,"` + logTopic(rpcOtherTopic1).Hex() + `"]}`,
			want:   1,
		},
		{
			name:   "null inside an OR array widens that position to a wildcard",
			filter: `{"fromBlock":"0x0","toBlock":"latest","topics":[["` + logTopic(rpcEmitterTopic0).Hex() + `",null]]}`,
			want:   2,
		},
		{
			name:   "empty OR array is a wildcard",
			filter: `{"fromBlock":"0x0","toBlock":"latest","topics":[[]]}`,
			want:   2,
		},
		{
			name:   "topics explicitly null constrains nothing",
			filter: `{"fromBlock":"0x0","toBlock":"latest","topics":null}`,
			want:   2,
		},
		{
			// The block explorer's address-only query sends topics:[] —
			// captured from viem's real wire output, not assumed.
			name:   "empty topics array constrains nothing",
			filter: `{"fromBlock":"0x0","toBlock":"latest","address":"` + emitter.Hex() + `","topics":[]}`,
			want:   1,
		},
		{
			// The /api/verify-vote shape: topic0 plus trailing null padding
			// out to the event's full indexed-argument count.
			name:   "trailing null padding still matches",
			filter: `{"fromBlock":"0x0","toBlock":"latest","topics":["` + logTopic(rpcEmitterTopic0).Hex() + `",null,null]}`,
			want:   1,
		},
		{
			// Every other case here uses common.Address.Hex(), which is the
			// EIP-55 mixed-case form — the same form viem puts on the wire.
			// This one proves the all-lowercase form decodes identically, so
			// the address decoder is case-insensitive rather than accidentally
			// checksum-sensitive.
			name:   "all-lowercase address decodes the same",
			filter: `{"fromBlock":"0x0","toBlock":"latest","address":"` + strings.ToLower(emitter.Hex()) + `"}`,
			want:   1,
		},
		{
			name:   "earliest and latest tags",
			filter: `{"fromBlock":"earliest","toBlock":"latest"}`,
			want:   2,
		},
		{
			name:   "pending toBlock resolves to latest",
			filter: `{"fromBlock":"earliest","toBlock":"pending"}`,
			want:   2,
		},
		{
			name:   "an empty filter object defaults both bounds to latest",
			filter: `{}`,
			want:   1,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			logs := decodeLogs(t, getLogs(t, handler, tc.filter))
			if len(logs) != tc.want {
				t.Fatalf("got %d logs, want %d", len(logs), tc.want)
			}
		})
	}
}

// TestLogFilterArgsUnmarshalJSON tests the decoder in isolation, including
// the shapes that are hard to reach through a live query (malformed input,
// and the distinction between an absent field and an explicitly null one).
func TestLogFilterArgsUnmarshalJSON(t *testing.T) {
	addr := common.HexToAddress("0x00000000000000000000000000000000000000aa")
	topicA := common.HexToHash("0x000000000000000000000000000000000000000000000000000000000000000a")
	topicB := common.HexToHash("0x000000000000000000000000000000000000000000000000000000000000000b")
	blockHash := common.HexToHash("0x00000000000000000000000000000000000000000000000000000000000000cc")

	latest := gethrpc.LatestBlockNumber
	earliest := gethrpc.EarliestBlockNumber
	five := gethrpc.BlockNumber(5)

	tests := []struct {
		name    string
		input   string
		want    LogFilterArgs
		wantErr string
	}{
		{
			name:  "empty object",
			input: `{}`,
			want:  LogFilterArgs{},
		},
		{
			name:  "null filter",
			input: `null`,
			want:  LogFilterArgs{},
		},
		{
			name:  "block tags",
			input: `{"fromBlock":"earliest","toBlock":"latest"}`,
			want:  LogFilterArgs{FromBlock: &earliest, ToBlock: &latest},
		},
		{
			name:  "hex block number",
			input: `{"fromBlock":"0x5"}`,
			want:  LogFilterArgs{FromBlock: &five},
		},
		{
			name:  "block hash",
			input: `{"blockHash":"` + blockHash.Hex() + `"}`,
			want:  LogFilterArgs{BlockHash: &blockHash},
		},
		{
			name:  "single address",
			input: `{"address":"` + addr.Hex() + `"}`,
			want:  LogFilterArgs{Addresses: []common.Address{addr}},
		},
		{
			name:  "address array",
			input: `{"address":["` + addr.Hex() + `"]}`,
			want:  LogFilterArgs{Addresses: []common.Address{addr}},
		},
		{
			// Normalized to nil: an empty list and an absent one both mean
			// "unconstrained", so LogFilterArgs has one representation for it
			// rather than depending on whether encoding/json produced a nil or
			// an empty-but-non-nil slice.
			name:  "empty address array normalizes to unconstrained",
			input: `{"address":[]}`,
			want:  LogFilterArgs{},
		},
		{
			// This exact shape is what the block explorer's address-only
			// query puts on the wire — confirmed by capturing viem's actual
			// JSON-RPC request, not assumed.
			name:  "empty topics array normalizes to unconstrained",
			input: `{"address":"` + addr.Hex() + `","topics":[]}`,
			want:  LogFilterArgs{Addresses: []common.Address{addr}},
		},
		{
			// The app's verify-vote route sends trailing nulls to pad the
			// topics array out to the event's full indexed-argument count.
			name:  "trailing null topic positions are wildcards",
			input: `{"topics":["` + topicA.Hex() + `","` + topicB.Hex() + `",null,null]}`,
			want:  LogFilterArgs{Topics: [][]common.Hash{{topicA}, {topicB}, nil, nil}},
		},
		{
			name:  "topics: string, OR array, null",
			input: `{"topics":["` + topicA.Hex() + `",["` + topicA.Hex() + `","` + topicB.Hex() + `"],null]}`,
			want: LogFilterArgs{Topics: [][]common.Hash{
				{topicA},
				{topicA, topicB},
				nil,
			}},
		},
		{
			name:  "null inside an OR array collapses the position to a wildcard",
			input: `{"topics":[["` + topicA.Hex() + `",null]]}`,
			want:  LogFilterArgs{Topics: [][]common.Hash{nil}},
		},
		{
			name:  "empty OR array is a wildcard",
			input: `{"topics":[[]]}`,
			want:  LogFilterArgs{Topics: [][]common.Hash{nil}},
		},
		{
			name:  "explicit nulls are the same as absent",
			input: `{"address":null,"topics":null}`,
			want:  LogFilterArgs{},
		},
		{
			name:    "malformed address",
			input:   `{"address":"0xnothex"}`,
			wantErr: "address must be a 20-byte address",
		},
		{
			name:    "malformed address inside an array",
			input:   `{"address":["0xnothex"]}`,
			wantErr: "address array must hold 20-byte addresses",
		},
		{
			name:    "topic of the wrong width",
			input:   `{"topics":["0x1234"]}`,
			wantErr: "topics[0]",
		},
		{
			name:    "malformed topic inside an OR array",
			input:   `{"topics":[["0x1234"]]}`,
			wantErr: "array element must be a 32-byte topic",
		},
		{
			name:    "numeric topic",
			input:   `{"topics":[42]}`,
			wantErr: "topics[0]",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var got LogFilterArgs
			err := json.Unmarshal([]byte(tc.input), &got)

			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil (decoded %+v)", tc.wantErr, got)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("error = %q, want it to contain %q", err.Error(), tc.wantErr)
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("decoded %+v, want %+v", got, tc.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Error mapping

func TestGetLogsBlockHashWithRangeIsInvalidParams(t *testing.T) {
	handler, seq, _, _ := logTestChain(t)

	header, err := seq.HeaderByNumber(1)
	if err != nil {
		t.Fatalf("HeaderByNumber: %v", err)
	}

	resp := getLogs(t, handler, `{"blockHash":"`+header.Hash().Hex()+`","fromBlock":"0x0"}`)
	if resp.Error == nil {
		t.Fatal("expected an error, got a result")
	}
	if resp.Error.Code != invalidParamsCode {
		t.Errorf("code = %d, want %d", resp.Error.Code, invalidParamsCode)
	}
	if !strings.Contains(resp.Error.Message, "choose one or the other") {
		t.Errorf("message = %q, want it to mention choosing one or the other", resp.Error.Message)
	}
}

func TestGetLogsUnknownBlockHashIsAnError(t *testing.T) {
	handler, _, _, _ := logTestChain(t)

	// Deliberately not a null result: unlike eth_getBlockByHash, a filter
	// pinned to a block that doesn't exist is a caller mistake.
	resp := getLogs(t, handler, `{"blockHash":"0x00000000000000000000000000000000000000000000000000000000000000ff"}`)
	if resp.Error == nil {
		t.Fatalf("expected an error, got result %s", resp.Result)
	}
	if resp.Error.Code != invalidInputCode {
		t.Errorf("code = %d, want %d", resp.Error.Code, invalidInputCode)
	}
}

func TestGetLogsRangeCapIsEnforcedAndNamesTheLimit(t *testing.T) {
	seq := newTestSequencer(t)
	key := mustTestKey(t)
	chainID := big.NewInt(testChainID)

	emitter := deployContract(t, seq, key, chainID, 0, logThreeRuntime(rpcEmitterTopic0, rpcEmitterTopic1, rpcEmitterTopic2, rpcEmitterData))
	// Mine past testLogRangeLimit so a genesis-to-head query exceeds it.
	for nonce := uint64(1); nonce <= testLogRangeLimit; nonce++ {
		callContract(t, seq, key, chainID, nonce, emitter)
	}

	handler := newTestMuxWithConfig(t, seq, ServerConfig{
		ChainID:       testChainID,
		LogRangeLimit: testLogRangeLimit,
	})

	resp := getLogs(t, handler, `{"fromBlock":"0x0","toBlock":"latest"}`)
	if resp.Error == nil {
		t.Fatalf("expected a range-cap error, got result %s", resp.Result)
	}
	if resp.Error.Code != invalidInputCode {
		t.Errorf("code = %d, want %d", resp.Error.Code, invalidInputCode)
	}
	// The message must name the limit; a bare "range too large" leaves the
	// operator with no idea which knob to turn.
	if !strings.Contains(resp.Error.Message, "LOG_RANGE_LIMIT") {
		t.Errorf("message = %q, want it to name LOG_RANGE_LIMIT", resp.Error.Message)
	}

	// A query inside the cap still works on the same server.
	head, err := seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}
	narrow := getLogs(t, handler, `{"fromBlock":"`+hexUint(head)+`","toBlock":"latest"}`)
	if narrow.Error != nil {
		t.Fatalf("narrow query failed: %+v", narrow.Error)
	}
}

// hexUint renders a block number the way a JSON-RPC caller sends one.
func hexUint(v uint64) string { return hexutil.Uint64(v).String() }

// ---------------------------------------------------------------------------
// Namespace registration

// TestEthNamespaceMergesAllThreeReceivers is the regression guard
// server.go's comment promises: read (M04), write (M05) and logs (M06)
// methods are registered as three separate receivers under one "eth" name,
// and all three must resolve on the same server. If go-ethereum's registry
// ever stops merging them, this fails loudly instead of half the namespace
// silently disappearing.
func TestEthNamespaceMergesAllThreeReceivers(t *testing.T) {
	handler, _, _, _ := logTestChain(t)

	for _, method := range []string{"eth_blockNumber", "eth_getTransactionReceipt", "eth_getLogs"} {
		t.Run(method, func(t *testing.T) {
			var params []any
			switch method {
			case "eth_getTransactionReceipt":
				params = []any{common.Hash{}.Hex()}
			case "eth_getLogs":
				params = []any{map[string]any{}}
			}
			_, resp := callRPC(t, handler, "", method, params...)
			if resp.Error != nil && resp.Error.Code == -32601 {
				t.Fatalf("%s is not registered: %s", method, resp.Error.Message)
			}
		})
	}
}
