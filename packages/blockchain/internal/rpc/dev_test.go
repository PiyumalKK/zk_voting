package rpc

import (
	"math/big"
	"net/http"
	"strconv"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"

	"zk-blockchain/internal/chain"
)

// devMux builds the full HTTP handler with M07's namespaces registered
// (DEV_RPC=true), over seq.
func devMux(t *testing.T, seq *chain.Sequencer) http.Handler {
	t.Helper()
	return newTestMuxWithConfig(t, seq, ServerConfig{ChainID: testChainID, DevRPC: true})
}

// methodNotFoundCode is JSON-RPC 2.0's "method does not exist" code —
// go-ethereum's server emits it for any method whose namespace was never
// registered, which is exactly how DEV_RPC=false gates this file's methods.
const methodNotFoundCode = -32601

// blockTimestamp reads block n's header timestamp straight from the
// sequencer. Assertions go through the sealed header rather than the
// sequencer's in-memory offset because the header is the only thing
// replicas (M10) and the audit tool (M09) ever see.
func blockTimestamp(t *testing.T, seq *chain.Sequencer, n uint64) uint64 {
	t.Helper()
	header, err := seq.HeaderByNumber(n)
	if err != nil {
		t.Fatalf("HeaderByNumber(%d): %v", n, err)
	}
	return header.Time
}

// TestDevMethodsAreUnavailableWithoutDevRPC is M07's security gate: with
// DEV_RPC off (newTestMux's ServerConfig leaves it false) every
// state-mutating dev method must be indistinguishable from a method that
// was never implemented.
func TestDevMethodsAreUnavailableWithoutDevRPC(t *testing.T) {
	handler := newTestMux(t, newTestSequencer(t))

	methods := []struct {
		name   string
		params []any
	}{
		{"evm_increaseTime", []any{3600}},
		{"evm_mine", []any{}},
		{"evm_setNextBlockTimestamp", []any{9999999999}},
		{"hardhat_setBalance", []any{deadAddress, "0x1"}},
		{"anvil_setBalance", []any{deadAddress, "0x1"}},
	}

	for _, m := range methods {
		t.Run(m.name, func(t *testing.T) {
			_, resp := callRPC(t, handler, nonLoopback, m.name, m.params...)
			if resp.Error == nil {
				t.Fatalf("%s succeeded with DEV_RPC=false; result: %s", m.name, resp.Result)
			}
			if resp.Error.Code != methodNotFoundCode {
				t.Errorf("%s error code = %d, want %d (method not found)", m.name, resp.Error.Code, methodNotFoundCode)
			}
		})
	}

	// The read surface must be entirely unaffected by the gate.
	if _, resp := callRPC(t, handler, nonLoopback, "eth_blockNumber"); resp.Error != nil {
		t.Errorf("eth_blockNumber broke when the dev namespaces were absent: %+v", resp.Error)
	}
}

// deadAddress is the burn address M07's own acceptance gate uses, in its
// EIP-55-checksummed spelling.
const deadAddress = "0x000000000000000000000000000000000000dEaD"

// TestIncreaseTimeAcceptsBothParameterEncodings is the M08 gate in
// miniature: `packages/hardhat/test/Voting.ts` sends a bare JSON number,
// while curl and viem send a hex quantity string. Rejecting either would
// break a real caller (see devUint64's doc comment).
func TestIncreaseTimeAcceptsBothParameterEncodings(t *testing.T) {
	tests := []struct {
		name  string
		param any
		want  string
	}{
		{"bare JSON number (ethers.provider.send)", 3600, "3600"},
		{"hex quantity string (curl/viem)", "0xe10", "3600"},
		{"uppercase hex digits", "0xE10", "3600"},
		{"decimal string", "3600", "3600"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			handler := devMux(t, newTestSequencer(t))

			_, resp := callRPC(t, handler, nonLoopback, "evm_increaseTime", tt.param)
			if got := decodeResult[string](t, resp); got != tt.want {
				t.Errorf("evm_increaseTime(%v) = %q, want %q (decimal — Hardhat's documented exception to the hex convention)", tt.param, got, tt.want)
			}
		})
	}
}

func TestIncreaseTimeAccumulates(t *testing.T) {
	handler := devMux(t, newTestSequencer(t))

	if got := decodeResult[string](t, respOf(t, handler, "evm_increaseTime", 100)); got != "100" {
		t.Fatalf("first evm_increaseTime = %q, want \"100\"", got)
	}
	if got := decodeResult[string](t, respOf(t, handler, "evm_increaseTime", 50)); got != "150" {
		t.Errorf("second evm_increaseTime = %q, want the accumulated \"150\"", got)
	}
}

// TestIncreaseTimeReportsANegativeTotalAsNegative is the RPC-level
// regression test for the signedness bug described on
// Sequencer.IncreaseTime: after pinning a block below wall clock the
// accumulated offset is negative, and evm_increaseTime must say so rather
// than wrapping to a 20-digit unsigned number that no client can interpret.
func TestIncreaseTimeReportsANegativeTotalAsNegative(t *testing.T) {
	handler := devMux(t, newTestSequencer(t))

	// Legal on a fresh chain: genesis is timestamped 0.
	mustCall(t, handler, "evm_mine", 1000)

	got := decodeResult[string](t, respOf(t, handler, "evm_increaseTime", 3600))
	total, err := strconv.ParseInt(got, 10, 64)
	if err != nil {
		t.Fatalf("evm_increaseTime returned %q, which is not a decimal integer: %v", got, err)
	}
	if total >= 0 {
		t.Errorf("evm_increaseTime = %q; after pinning a block at unix time 1000 the offset is far negative, so a non-negative total means the value wrapped", got)
	}
}

func TestIncreaseTimeRejectsMalformedParameters(t *testing.T) {
	handler := devMux(t, newTestSequencer(t))

	for _, param := range []any{nil, "not a number", 3.5, -1, "0xzz", ""} {
		_, resp := callRPC(t, handler, nonLoopback, "evm_increaseTime", param)
		if resp.Error == nil {
			t.Errorf("evm_increaseTime(%v) unexpectedly succeeded: %s", param, resp.Result)
		}
	}
}

func TestIncreaseTimeShiftsTheNextBlocksTimestamp(t *testing.T) {
	seq := newTestSequencer(t)
	handler := devMux(t, seq)

	mustCall(t, handler, "evm_mine")
	before := blockTimestamp(t, seq, 1)

	mustCall(t, handler, "evm_increaseTime", 86400)
	mustCall(t, handler, "evm_mine")
	after := blockTimestamp(t, seq, 2)

	// Wall clock advances during the test too, so this is a range check;
	// the slack absorbs a slow machine without admitting a no-op
	// implementation.
	const slack = 60
	if delta := int64(after) - int64(before); delta < 86400 || delta > 86400+slack {
		t.Errorf("timestamp delta across evm_increaseTime(86400) = %d, want between 86400 and %d", delta, 86400+slack)
	}
}

func TestMineSealsAnEmptyBlockAndReturnsDecimalZero(t *testing.T) {
	seq := newTestSequencer(t)
	handler := devMux(t, seq)

	// "0", not "0x0": observed against a live Hardhat node by `make
	// diff-dev`. All three evm_ methods return decimal strings.
	if got := decodeResult[string](t, respOf(t, handler, "evm_mine")); got != "0" {
		t.Errorf("evm_mine = %q, want \"0\"", got)
	}

	n, err := seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}
	if n != 1 {
		t.Fatalf("height after evm_mine = %d, want 1", n)
	}

	_, resp := callRPC(t, handler, nonLoopback, "eth_getBlockByNumber", "0x1", false)
	block := decodeResult[struct {
		Transactions []string `json:"transactions"`
		ExtraData    string   `json:"extraData"`
	}](t, resp)
	if len(block.Transactions) != 0 {
		t.Errorf("evm_mine produced a block with %d transactions, want 0", len(block.Transactions))
	}
	if block.ExtraData != "0x" {
		t.Errorf("evm_mine block extraData = %q, want empty — only system-op blocks carry extra data", block.ExtraData)
	}
}

func TestMineAcceptsAnOptionalTimestamp(t *testing.T) {
	seq := newTestSequencer(t)
	handler := devMux(t, seq)

	const want = uint64(4_000_000_000)
	mustCall(t, handler, "evm_mine", want)
	if got := blockTimestamp(t, seq, 1); got != want {
		t.Errorf("evm_mine(%d) sealed a block at %d, want %d", want, got, want)
	}

	// A timestamp at or before the new head is rejected, by the same
	// strictly-increasing rule evm_setNextBlockTimestamp enforces — the
	// check lives inside MineEmptyBlockAt's lock rather than in a separate
	// pin call, so it must still be applied here.
	_, resp := callRPC(t, handler, nonLoopback, "evm_mine", want)
	if resp.Error == nil {
		t.Error("evm_mine accepted a timestamp equal to the current head")
	}
}

func TestSetNextBlockTimestampPinsAndRejectsGoingBackwards(t *testing.T) {
	seq := newTestSequencer(t)
	handler := devMux(t, seq)

	const want = uint64(4_100_000_000)
	if got := decodeResult[string](t, respOf(t, handler, "evm_setNextBlockTimestamp", want)); got != "4100000000" {
		t.Errorf("evm_setNextBlockTimestamp = %q, want the decimal \"4100000000\"", got)
	}

	mustCall(t, handler, "evm_mine")
	if ts := blockTimestamp(t, seq, 1); ts != want {
		t.Errorf("pinned block timestamp = %d, want %d", ts, want)
	}

	// Going backwards is rejected rather than clamped — MASTER §10 pitfall 7
	// makes strictly increasing timestamps a chain invariant.
	_, resp := callRPC(t, handler, nonLoopback, "evm_setNextBlockTimestamp", want-1)
	if resp.Error == nil {
		t.Fatal("evm_setNextBlockTimestamp accepted a timestamp at or before the current head")
	}
	if resp.Error.Code != invalidInputCode {
		t.Errorf("error code = %d, want %d", resp.Error.Code, invalidInputCode)
	}
}

func TestSetBalanceIsVisibleViaGetBalanceAndRecordedInExtraData(t *testing.T) {
	// The gate's own value, uppercase hex digits included — the parameter
	// decoder must not be case-sensitive.
	const oneEtherHex = "0xDE0B6B3A7640000"
	oneEther := big.NewInt(1_000_000_000_000_000_000)

	for _, method := range []string{"hardhat_setBalance", "anvil_setBalance"} {
		t.Run(method, func(t *testing.T) {
			seq := newTestSequencer(t)
			handler := devMux(t, seq)

			if ok := decodeResult[bool](t, respOf(t, handler, method, deadAddress, oneEtherHex)); !ok {
				t.Errorf("%s = false, want true", method)
			}

			balance := decodeResult[string](t, respOf(t, handler, "eth_getBalance", deadAddress, "latest"))
			if balance != "0xde0b6b3a7640000" {
				t.Errorf("eth_getBalance = %q, want %q", balance, "0xde0b6b3a7640000")
			}

			// The mutation must live *in a block* — MASTER §10 pitfall 10.
			// Reading extraData back through the public RPC surface (rather
			// than off the Sequencer) also proves it survives block encoding
			// and JSON marshaling intact.
			block := decodeResult[struct {
				ExtraData string `json:"extraData"`
			}](t, respOf(t, handler, "eth_getBlockByNumber", "0x1", false))

			raw, err := hexutil.Decode(block.ExtraData)
			if err != nil {
				t.Fatalf("block extraData %q is not hex: %v", block.ExtraData, err)
			}
			op, err := chain.ParseSysOp(raw)
			if err != nil {
				t.Fatalf("block extraData %q is not a system op: %v", raw, err)
			}
			if op.Address != common.HexToAddress(deadAddress) {
				t.Errorf("system op address = %s, want %s", op.Address, deadAddress)
			}
			if op.Value.Cmp(oneEther) != 0 {
				t.Errorf("system op value = %s, want %s", op.Value, oneEther)
			}
		})
	}
}

// TestSetBalanceAcceptsAValueWiderThanUint64 guards the choice of devBig
// over devUint64 for the balance parameter: the dev faucet hands out whole
// ether, and 10,000 ETH already needs 74 bits.
func TestSetBalanceAcceptsAValueWiderThanUint64(t *testing.T) {
	seq := newTestSequencer(t)
	handler := devMux(t, seq)

	tenThousandEther := new(big.Int).Mul(big.NewInt(10_000), big.NewInt(1_000_000_000_000_000_000))
	mustCall(t, handler, "hardhat_setBalance", deadAddress, hexutil.EncodeBig(tenThousandEther))

	got := decodeResult[string](t, respOf(t, handler, "eth_getBalance", deadAddress, "latest"))
	if got != hexutil.EncodeBig(tenThousandEther) {
		t.Errorf("eth_getBalance = %q, want %q", got, hexutil.EncodeBig(tenThousandEther))
	}
}

func TestSetBalanceRejectsMalformedParameters(t *testing.T) {
	handler := devMux(t, newTestSequencer(t))

	tests := []struct {
		name   string
		params []any
	}{
		{"missing balance", []any{deadAddress}},
		{"negative balance", []any{deadAddress, -1}},
		{"non-numeric balance", []any{deadAddress, "beef"}},
		{"null balance", []any{deadAddress, nil}},
		{"malformed address", []any{"0xnothex", "0x1"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, resp := callRPC(t, handler, nonLoopback, "hardhat_setBalance", tt.params...)
			if resp.Error == nil {
				t.Errorf("hardhat_setBalance(%v) unexpectedly succeeded: %s", tt.params, resp.Result)
			}
		})
	}
}

func TestClientVersionModeSwitchesTheReportedString(t *testing.T) {
	tests := []struct {
		mode string
		want string
	}{
		{"", DefaultClientVersion},
		{"zkchain", DefaultClientVersion},
		{"anvil", AnvilClientVersion},
	}

	for _, tt := range tests {
		t.Run("mode="+tt.mode, func(t *testing.T) {
			handler := newTestMuxWithConfig(t, newTestSequencer(t), ServerConfig{
				ChainID:           testChainID,
				ClientVersionMode: tt.mode,
			})

			if got := decodeResult[string](t, respOf(t, handler, "web3_clientVersion")); got != tt.want {
				t.Errorf("web3_clientVersion = %q, want %q", got, tt.want)
			}
		})
	}
}

// respOf is callRPC with the recorder discarded and the standard
// non-loopback remote address — the shape almost every assertion in this
// file wants.
func respOf(t *testing.T, handler http.Handler, method string, params ...any) rpcResponse {
	t.Helper()
	_, resp := callRPC(t, handler, nonLoopback, method, params...)
	return resp
}

// mustCall issues a call and fails the test if it returned a JSON-RPC
// error, for the steps that set a test up rather than the ones it asserts
// on.
func mustCall(t *testing.T, handler http.Handler, method string, params ...any) {
	t.Helper()
	if resp := respOf(t, handler, method, params...); resp.Error != nil {
		t.Fatalf("%s: code=%d message=%q", method, resp.Error.Code, resp.Error.Message)
	}
}
