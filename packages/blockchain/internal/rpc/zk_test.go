package rpc

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	"zk-blockchain/internal/chain"
	"zk-blockchain/internal/config"
	"zk-blockchain/internal/consensus"
)

// Hardhat accounts #0–#2, the same non-secret keys the rest of the repo signs
// test transactions with.
var zkTestKeys = []string{
	"ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
	"59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
	"5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
	"7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
}

var zkTestNames = []string{"authority", "jvp", "unp", "sjb"}

func zkValidatorSet(t *testing.T) *consensus.ValidatorSet {
	t.Helper()
	entries := make([]config.ValidatorEntry, 0, len(zkTestNames))
	for i, name := range zkTestNames {
		key, err := crypto.HexToECDSA(zkTestKeys[i])
		if err != nil {
			t.Fatalf("HexToECDSA: %v", err)
		}
		entries = append(entries, config.ValidatorEntry{Name: name, Address: crypto.PubkeyToAddress(key.PublicKey)})
	}
	vs, err := consensus.NewValidatorSet(entries, 0)
	if err != nil {
		t.Fatalf("NewValidatorSet: %v", err)
	}
	return vs
}

// sealBlock signs a quorum of commits over a block, as the engine would.
func sealBlock(t *testing.T, height uint64, hash common.Hash, signers ...int) *consensus.CommitSeals {
	t.Helper()
	seals := make([][]byte, 0, len(signers))
	for _, i := range signers {
		key, err := crypto.HexToECDSA(zkTestKeys[i])
		if err != nil {
			t.Fatalf("HexToECDSA: %v", err)
		}
		signed, err := consensus.Sign(testChainID, key, consensus.Message{
			Type: consensus.MsgCommit, Height: height, BlockHash: hash,
		})
		if err != nil {
			t.Fatalf("Sign: %v", err)
		}
		seals = append(seals, signed.Signature)
	}
	return &consensus.CommitSeals{Round: 0, Seals: seals}
}

// newZkMux builds a full JSON-RPC mux with the zk namespace registered, so
// these tests go through the real NewJSONRPCServer rather than calling the
// service directly.
func newZkMux(t *testing.T, seq *chain.Sequencer, seals consensus.SealStore, vs *consensus.ValidatorSet) http.Handler {
	t.Helper()
	zk := NewZkService(seq, seals, vs, nil, testChainID)
	server, err := NewJSONRPCServer(seq, ServerConfig{ChainID: testChainID, Zk: zk})
	if err != nil {
		t.Fatalf("NewJSONRPCServer: %v", err)
	}
	t.Cleanup(server.Stop)
	return NewMux(NewHealthHandler(testChainID, "primary", func() uint64 { return 0 }), server, MuxConfig{
		CORSOrigins: []string{"*"}, RateLimitRPS: 1000, RateLimitBurst: 1000,
	})
}

// TestGetCommitSealsPublishesTheQuorum is the method that makes the whole
// design auditable from outside: a scrutineer asks any node for any block and
// gets back the signatures, the addresses they recover to, and how many were
// required — and can check the arithmetic without trusting the node that
// served it.
func TestGetCommitSealsPublishesTheQuorum(t *testing.T) {
	seq := newTestSequencer(t)
	block, err := seq.MineEmptyBlock()
	if err != nil {
		t.Fatalf("MineEmptyBlock: %v", err)
	}

	vs := zkValidatorSet(t)
	store := consensus.NewMemorySealStore()
	if err := store.Put(1, block.Hash(), sealBlock(t, 1, block.Hash(), 0, 1, 2)); err != nil {
		t.Fatalf("Put: %v", err)
	}

	handler := newZkMux(t, seq, store, vs)
	_, resp := callRPC(t, handler, "1.2.3.4:1", "zk_getCommitSeals", "0x1")
	if resp.Error != nil {
		t.Fatalf("zk_getCommitSeals: %v", resp.Error)
	}

	var out RPCCommitSeals
	if err := json.Unmarshal(resp.Result, &out); err != nil {
		t.Fatalf("decoding the result: %v (%s)", err, resp.Result)
	}

	if out.BlockHash != block.Hash() {
		t.Errorf("blockHash = %s, want %s", out.BlockHash, block.Hash())
	}
	if uint64(out.Quorum) != 3 {
		t.Errorf("quorum = %d, want 3", out.Quorum)
	}
	if uint64(out.ValidatorSetSize) != 4 {
		t.Errorf("validatorSetSize = %d, want 4", out.ValidatorSetSize)
	}
	if len(out.Seals) != 3 {
		t.Fatalf("got %d seals, want 3", len(out.Seals))
	}

	// Every seal must name a validator and an address recovered server-side,
	// and they must be distinct — three signatures from two validators is not
	// a quorum of three.
	seen := map[common.Address]bool{}
	for _, seal := range out.Seals {
		if seal.Validator == "" {
			t.Errorf("seal from %s names no validator, so it recovered outside the set", seal.Address)
		}
		if seen[seal.Address] {
			t.Errorf("address %s appears twice", seal.Address)
		}
		seen[seal.Address] = true
		if len(seal.Signature) != consensus.SignatureLength {
			t.Errorf("signature is %d bytes, want %d", len(seal.Signature), consensus.SignatureLength)
		}
	}
}

// TestGetCommitSealsReturnsNullRatherThanErroring: blocks sealed before
// consensus was enabled have no certificate, and neither do blocks synced
// from a peer with a truncated seal store. Null is the convention the rest of
// this package follows for "no such thing" (eth_getBlockByNumber,
// eth_getTransactionReceipt) and it is what makes the method safe to call
// across a rollout — a client can tell "not applicable" from "went wrong".
func TestGetCommitSealsReturnsNullRatherThanErroring(t *testing.T) {
	seq := newTestSequencer(t)
	if _, err := seq.MineEmptyBlock(); err != nil {
		t.Fatalf("MineEmptyBlock: %v", err)
	}

	handler := newZkMux(t, seq, consensus.NewMemorySealStore(), zkValidatorSet(t))

	tests := []struct {
		name  string
		block any
	}{
		{name: "a block with no certificate", block: "0x1"},
		{name: "a block that does not exist", block: "0x270f"},
		{name: "genesis", block: "0x0"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, resp := callRPC(t, handler, "1.2.3.4:1", "zk_getCommitSeals", tc.block)
			if resp.Error != nil {
				t.Fatalf("returned an error instead of null: %v", resp.Error)
			}
			if strings.TrimSpace(string(resp.Result)) != "null" {
				t.Errorf("result = %s, want null", resp.Result)
			}
		})
	}
}

// TestGetCommitSealsRefusesACertificateThatDoesNotVerify is the other half of
// the contract, and the reason a corrupt record is *not* treated like a
// missing one. Serving a partial list would let a caller read two verified
// seals as a quorum of two when the third recovered to a stranger — which is
// exactly the misreading this method exists to prevent.
func TestGetCommitSealsRefusesACertificateThatDoesNotVerify(t *testing.T) {
	seq := newTestSequencer(t)
	block, err := seq.MineEmptyBlock()
	if err != nil {
		t.Fatalf("MineEmptyBlock: %v", err)
	}

	store := consensus.NewMemorySealStore()
	valid := sealBlock(t, 1, block.Hash(), 0, 1)
	// A third "seal" that is not a signature by anyone in the set.
	corrupt := append(valid.Seals, make([]byte, consensus.SignatureLength))
	if err := store.Put(1, block.Hash(), &consensus.CommitSeals{Seals: corrupt}); err != nil {
		t.Fatalf("Put: %v", err)
	}

	handler := newZkMux(t, seq, store, zkValidatorSet(t))
	_, resp := callRPC(t, handler, "1.2.3.4:1", "zk_getCommitSeals", "0x1")

	if resp.Error == nil {
		t.Fatalf("a certificate that does not verify was served as a result: %s", resp.Result)
	}
	if !strings.Contains(resp.Error.Message, "does not verify") {
		t.Errorf("error message does not say what is wrong: %q", resp.Error.Message)
	}
}

// TestSoloModeDoesNotRegisterTheZkNamespace is acceptance criterion 7 for the
// RPC surface: with CONSENSUS_MODE unset the methods do not exist, so they
// answer -32601 exactly as a method that was never written would. Nothing in
// eth_ is affected either way.
func TestSoloModeDoesNotRegisterTheZkNamespace(t *testing.T) {
	seq := newTestSequencer(t)
	handler := newTestMux(t, seq) // the ordinary solo mux, no Zk service

	for _, method := range []string{"zk_getCommitSeals", "zk_consensusStatus"} {
		_, resp := callRPC(t, handler, "1.2.3.4:1", method, "0x1")
		if resp.Error == nil {
			t.Fatalf("%s answered on a solo node", method)
		}
		if resp.Error.Code != -32601 {
			t.Errorf("%s error code = %d, want -32601 (method not found)", method, resp.Error.Code)
		}
	}

	// And the eth_ surface is untouched by the namespace's presence or
	// absence — the property the whole additive-namespace choice protects.
	_, resp := callRPC(t, handler, "1.2.3.4:1", "eth_chainId")
	if resp.Error != nil {
		t.Fatalf("eth_chainId broke: %v", resp.Error)
	}
}

// TestConsensusStatusReportsTheEnginesView: criteria 2, 3 and 4 are all
// "whose turn is it, and did the height move", and the cluster gate needs to
// read that without parsing logs.
func TestConsensusStatusReportsTheEnginesView(t *testing.T) {
	seq := newTestSequencer(t)
	vs := zkValidatorSet(t)

	status := consensus.Status{
		Mode: "bft", Self: "authority", Height: 12, Round: 2,
		Proposer: "unp", Quorum: 3, Synced: true,
		Validators: zkTestNames, Faulty: []string{"sjb"},
	}
	zk := NewZkService(seq, consensus.NewMemorySealStore(), vs, stubStatus{status}, testChainID)
	server, err := NewJSONRPCServer(seq, ServerConfig{ChainID: testChainID, Zk: zk})
	if err != nil {
		t.Fatalf("NewJSONRPCServer: %v", err)
	}
	t.Cleanup(server.Stop)
	handler := NewMux(NewHealthHandler(testChainID, "primary", func() uint64 { return 0 }), server,
		MuxConfig{CORSOrigins: []string{"*"}, RateLimitRPS: 1000, RateLimitBurst: 1000})

	_, resp := callRPC(t, handler, "1.2.3.4:1", "zk_consensusStatus")
	if resp.Error != nil {
		t.Fatalf("zk_consensusStatus: %v", resp.Error)
	}

	var out consensus.Status
	if err := json.Unmarshal(resp.Result, &out); err != nil {
		t.Fatalf("decoding: %v (%s)", err, resp.Result)
	}
	if out.Height != 12 || out.Round != 2 || out.Proposer != "unp" || out.Quorum != 3 {
		t.Errorf("status = %+v, want the engine's view", out)
	}
	if len(out.Faulty) != 1 || out.Faulty[0] != "sjb" {
		t.Errorf("faulty = %v, want [sjb] — equivocation must be visible over RPC", out.Faulty)
	}
}

type stubStatus struct{ s consensus.Status }

func (s stubStatus) Status() consensus.Status { return s.s }

// TestDynamicForwarderFallsBackToLocalWhenTheProposerIsDown is the behaviour
// that makes criterion 2 hold at the RPC layer.
//
// Under consensus every validator is a legitimate entry point for a write: an
// unreachable proposer means the local engine queues the request and a round
// change carries it. Reporting -32603 instead — which is exactly right for a
// solo replica, where answering locally would fork the chain — would let a
// single dead validator stop the election.
func TestDynamicForwarderFallsBackToLocalWhenTheProposerIsDown(t *testing.T) {
	// A "local" handler that records having been asked.
	served := false
	local := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		served = true
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":"0xlocal"}`))
	})

	dead := httptest.NewServer(http.NotFoundHandler())
	deadURL := dead.URL
	dead.Close()

	forwarder := NewDynamicForwarder(func() (string, bool) { return deadURL, true }, time.Second)
	handler := NewForwardingHandler(local, forwarder)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(
		`{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x00"]}`))
	handler.ServeHTTP(rec, req)

	if !served {
		t.Fatal("an unreachable proposer produced an error instead of local handling; one dead validator would stop writes")
	}
	if !strings.Contains(rec.Body.String(), "0xlocal") {
		t.Errorf("body = %s, want the local handler's answer", rec.Body.String())
	}
}

// TestDynamicForwarderHandlesLocallyWhenThisNodeIsTheProposer: resolve
// returning false is not an error, it is "handle this here".
func TestDynamicForwarderHandlesLocallyWhenThisNodeIsTheProposer(t *testing.T) {
	served := false
	local := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		served = true
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":"0xlocal"}`))
	})

	forwarder := NewDynamicForwarder(func() (string, bool) { return "", false }, time.Second)
	handler := NewForwardingHandler(local, forwarder)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(
		`{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x00"]}`))
	handler.ServeHTTP(rec, req)

	if !served {
		t.Error("the proposer did not handle its own write locally")
	}
	if got := forwarder.Target(); got != "(this node)" {
		t.Errorf("Target() = %q, want %q", got, "(this node)")
	}
}

// TestDynamicForwarderCopiesARevertBackVerbatim: a *response* from the
// proposer — including a revert — must reach the client unchanged, because
// mobile and web both decode custom Solidity errors from its `data` field.
// Only a transport failure triggers the local fallback.
func TestDynamicForwarderCopiesARevertBackVerbatim(t *testing.T) {
	const revertBody = `{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted","data":"0xdeadbeef"}}`

	proposer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(revertBody))
	}))
	t.Cleanup(proposer.Close)

	local := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("a proposer that answered was bypassed in favour of local handling")
	})

	forwarder := NewDynamicForwarder(func() (string, bool) { return proposer.URL, true }, time.Second)
	handler := NewForwardingHandler(local, forwarder)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(
		`{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x00"]}`))
	handler.ServeHTTP(rec, req)

	if got := strings.TrimSpace(rec.Body.String()); got != revertBody {
		t.Errorf("body = %s\nwant the proposer's answer verbatim: %s", got, revertBody)
	}
}

// TestAStaticForwarderNeverServesAWriteLocally: solo-mode behaviour must be
// untouched. A replica that answered a write itself would be a second writer
// on a single-sequencer chain, which is precisely the fork the whole M10
// design prevents.
func TestAStaticForwarderNeverServesAWriteLocally(t *testing.T) {
	local := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("a solo replica served a write locally instead of reporting the primary unreachable")
	})

	dead := httptest.NewServer(http.NotFoundHandler())
	deadURL := dead.URL
	dead.Close()

	forwarder, err := NewForwarder(deadURL, time.Second)
	if err != nil {
		t.Fatalf("NewForwarder: %v", err)
	}
	handler := NewForwardingHandler(local, forwarder)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(
		`{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x00"]}`))
	handler.ServeHTTP(rec, req)

	if !strings.Contains(rec.Body.String(), "-32603") {
		t.Errorf("body = %s, want a -32603 transport error", rec.Body.String())
	}
}
