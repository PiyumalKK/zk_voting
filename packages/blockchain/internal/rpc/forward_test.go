package rpc

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"zk-blockchain/internal/chain"
)

// recordingPrimary stands in for the sequencer: it records what it was sent
// and answers with a body the test chooses, so a forwarded response can be
// compared byte for byte against what the primary produced.
type recordingPrimary struct {
	server   *httptest.Server
	received atomic.Value // string: the last request body
	calls    atomic.Int32
	status   int
	response string
}

func newRecordingPrimary(t *testing.T, status int, response string) *recordingPrimary {
	t.Helper()

	p := &recordingPrimary{status: status, response: response}
	p.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		p.received.Store(string(body))
		p.calls.Add(1)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(p.status)
		_, _ = io.WriteString(w, p.response)
	}))
	t.Cleanup(p.server.Close)
	return p
}

func (p *recordingPrimary) lastBody() string {
	v, _ := p.received.Load().(string)
	return v
}

// newForwardingMux builds the full replica HTTP surface: the real local
// JSON-RPC server over a real chain, with forwarding to the stub primary in
// front of it.
func newForwardingMux(t *testing.T, seq *chain.Sequencer, primaryURL string) http.Handler {
	t.Helper()

	rpcServer, err := NewJSONRPCServer(seq, ServerConfig{ChainID: testChainID, DevRPC: true})
	if err != nil {
		t.Fatalf("NewJSONRPCServer: %v", err)
	}
	t.Cleanup(rpcServer.Stop)

	forwarder, err := NewForwarder(primaryURL, 5*time.Second)
	if err != nil {
		t.Fatalf("NewForwarder: %v", err)
	}

	health := NewHealthHandler(testChainID, "replica", nil)
	return NewMux(health, rpcServer, MuxConfig{
		CORSOrigins:    []string{"*"},
		RateLimitRPS:   1000,
		RateLimitBurst: 1000,
		Forwarder:      forwarder,
	})
}

func TestShouldForwardSelectsStateChangingMethods(t *testing.T) {
	forwarded := []string{
		"eth_sendRawTransaction",
		"eth_sendTransaction",
		"evm_mine",
		"evm_increaseTime",
		"evm_setNextBlockTimestamp",
		"hardhat_setBalance",
		"anvil_setBalance",
	}
	local := []string{
		"eth_call",
		"eth_getLogs",
		"eth_blockNumber",
		"eth_getTransactionReceipt",
		"eth_estimateGas",
		"eth_chainId",
		"net_version",
		"web3_clientVersion",
	}

	for _, method := range forwarded {
		if !ShouldForward(method) {
			t.Errorf("%s is answered locally; it changes state and belongs to the sequencer", method)
		}
	}
	for _, method := range local {
		if ShouldForward(method) {
			t.Errorf("%s is forwarded; a replica can answer it from its own verified state", method)
		}
	}
}

// TestReadsAreAnsweredLocally is the point of having replicas at all: read
// load must not land back on the sequencer.
func TestReadsAreAnsweredLocally(t *testing.T) {
	seq := newTestSequencer(t)
	primary := newRecordingPrimary(t, http.StatusOK, `{"jsonrpc":"2.0","id":1,"result":"0xdeadbeef"}`)
	handler := newForwardingMux(t, seq, primary.server.URL)

	_, resp := callRPC(t, handler, "", "eth_blockNumber")
	if resp.Error != nil {
		t.Fatalf("eth_blockNumber returned an error: %+v", resp.Error)
	}
	if string(resp.Result) == `"0xdeadbeef"` {
		t.Error("the read was answered by the primary; replicas must serve reads themselves")
	}
	if primary.calls.Load() != 0 {
		t.Errorf("the primary was contacted %d time(s) for a read", primary.calls.Load())
	}
}

// TestWritesAreForwardedVerbatim covers the reason forwarding lives at the
// HTTP layer: the revert error object — code 3 plus the raw revert bytes in
// `data` — is part of this chain's contract with viem (MASTER §10 pitfall 1),
// and it must arrive unchanged.
func TestWritesAreForwardedVerbatim(t *testing.T) {
	seq := newTestSequencer(t)
	revert := `{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted","data":"0x7f6c6d0a"}}`
	primary := newRecordingPrimary(t, http.StatusOK, revert)
	handler := newForwardingMux(t, seq, primary.server.URL)

	rec, _ := callRPC(t, handler, "", "eth_sendRawTransaction", "0x02f8")

	if primary.calls.Load() != 1 {
		t.Fatalf("the primary was contacted %d time(s), want 1", primary.calls.Load())
	}
	if got := strings.TrimSpace(rec.Body.String()); got != revert {
		t.Errorf("forwarded response body:\n got %s\nwant %s", got, revert)
	}
	if got := rec.Result().StatusCode; got != http.StatusOK {
		t.Errorf("status = %d, want 200", got)
	}
}

// TestTheForwardedBodyIsTheOriginalBody: the replica is a pipe, not a
// re-encoder. If it rebuilt the request, a raw transaction could in principle
// be normalised on the way through — and the transaction hash the caller is
// about to poll for is a hash of exactly those bytes.
func TestTheForwardedBodyIsTheOriginalBody(t *testing.T) {
	seq := newTestSequencer(t)
	primary := newRecordingPrimary(t, http.StatusOK, `{"jsonrpc":"2.0","id":1,"result":"0x01"}`)
	handler := newForwardingMux(t, seq, primary.server.URL)

	body := `{"jsonrpc":"2.0","id":7,"method":"eth_sendRawTransaction","params":["0xf86b8085"]}`
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(httptest.NewRecorder(), req)

	if got := primary.lastBody(); got != body {
		t.Errorf("the primary received\n %s\nwant %s", got, body)
	}
}

// TestDevMethodsAreForwarded: a replica that served evm_mine locally would
// seal a block the primary never produced and fork the cluster on the spot.
func TestDevMethodsAreForwarded(t *testing.T) {
	seq := newTestSequencer(t)
	primary := newRecordingPrimary(t, http.StatusOK, `{"jsonrpc":"2.0","id":1,"result":"0"}`)
	handler := newForwardingMux(t, seq, primary.server.URL)

	before, err := seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}

	if _, resp := callRPC(t, handler, "", "evm_mine"); resp.Error != nil {
		t.Fatalf("evm_mine returned an error: %+v", resp.Error)
	}
	if primary.calls.Load() != 1 {
		t.Errorf("evm_mine reached the primary %d time(s), want 1", primary.calls.Load())
	}

	after, err := seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}
	if after != before {
		t.Errorf("the replica sealed a block of its own: height went %d -> %d", before, after)
	}
}

func TestABatchContainingAWriteIsForwardedWhole(t *testing.T) {
	seq := newTestSequencer(t)
	primary := newRecordingPrimary(t, http.StatusOK, `[{"jsonrpc":"2.0","id":1,"result":"0x1"},{"jsonrpc":"2.0","id":2,"result":"0x2"}]`)
	handler := newForwardingMux(t, seq, primary.server.URL)

	body := `[{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]},` +
		`{"jsonrpc":"2.0","id":2,"method":"eth_sendRawTransaction","params":["0xf8"]}]`
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(httptest.NewRecorder(), req)

	if primary.calls.Load() != 1 {
		t.Fatalf("the batch reached the primary %d time(s), want 1", primary.calls.Load())
	}
	if got := primary.lastBody(); got != body {
		t.Errorf("the batch was altered on the way through:\n got %s\nwant %s", got, body)
	}
}

func TestABatchOfReadsStaysLocal(t *testing.T) {
	seq := newTestSequencer(t)
	primary := newRecordingPrimary(t, http.StatusOK, `[]`)
	handler := newForwardingMux(t, seq, primary.server.URL)

	body := `[{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]},` +
		`{"jsonrpc":"2.0","id":2,"method":"eth_chainId","params":[]}]`
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if primary.calls.Load() != 0 {
		t.Errorf("a read-only batch was forwarded %d time(s)", primary.calls.Load())
	}
	var responses []rpcResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &responses); err != nil {
		t.Fatalf("decode batch response: %v (body %s)", err, rec.Body.String())
	}
	if len(responses) != 2 {
		t.Errorf("got %d responses, want 2", len(responses))
	}
}

// TestMalformedBodiesAreLeftToTheLocalServer: go-ethereum already produces
// the spec's parse/invalid-request errors. A second parser here would answer
// some of them differently, and forwarding an unparseable body would make a
// broken request the primary's problem.
func TestMalformedBodiesAreLeftToTheLocalServer(t *testing.T) {
	seq := newTestSequencer(t)
	primary := newRecordingPrimary(t, http.StatusOK, `{}`)
	handler := newForwardingMux(t, seq, primary.server.URL)

	for _, body := range []string{"{", "", "not json at all", `{"jsonrpc":"2.0"}`} {
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		handler.ServeHTTP(httptest.NewRecorder(), req)
	}
	if primary.calls.Load() != 0 {
		t.Errorf("malformed bodies were forwarded %d time(s)", primary.calls.Load())
	}
}

// TestAnUnreachablePrimaryIsReportedAsAJSONRPCError: viem and ethers parse
// the response body. A bare HTTP 502 with an HTML body surfaces to a voter
// as an unintelligible client-side exception instead of a message anyone can
// act on.
func TestAnUnreachablePrimaryIsReportedAsAJSONRPCError(t *testing.T) {
	seq := newTestSequencer(t)

	// A URL that resolves to nothing: the server is created and immediately
	// closed, so the port is (almost certainly) not listening.
	dead := httptest.NewServer(http.NotFoundHandler())
	deadURL := dead.URL
	dead.Close()

	handler := newForwardingMux(t, seq, deadURL)
	rec, resp := callRPC(t, handler, "", "eth_sendRawTransaction", "0x02f8")

	if resp.Error == nil {
		t.Fatalf("want a JSON-RPC error, got body %s", rec.Body.String())
	}
	if resp.Error.Code != -32603 {
		t.Errorf("error code = %d, want -32603", resp.Error.Code)
	}
	if !strings.Contains(resp.Error.Message, "cannot reach the sequencer") {
		t.Errorf("error message = %q, want it to name the unreachable sequencer", resp.Error.Message)
	}
}

func TestNewForwarderValidatesItsURL(t *testing.T) {
	for _, raw := range []string{"", "127.0.0.1:9545", "not a url at all"} {
		if _, err := NewForwarder(raw, 0); err == nil {
			t.Errorf("NewForwarder(%q) accepted an unusable URL", raw)
		}
	}
	if _, err := NewForwarder("http://127.0.0.1:9545", 0); err != nil {
		t.Errorf("NewForwarder(valid) = %v, want nil", err)
	}
}

// TestNoForwarderLeavesTheSurfaceUnchanged: a primary and a standalone node
// must behave exactly as they did through M09.
func TestNoForwarderLeavesTheSurfaceUnchanged(t *testing.T) {
	seq := newTestSequencer(t)
	handler := newTestMux(t, seq)

	if _, resp := callRPC(t, handler, "", "eth_blockNumber"); resp.Error != nil {
		t.Fatalf("eth_blockNumber on a node with no forwarder: %+v", resp.Error)
	}
}
