package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"testing"

	"zk-blockchain/internal/core"
	"zk-blockchain/internal/evm"
	"zk-blockchain/internal/persistence"
)

// assetsDir returns the path to the compiled contract artifacts, mirroring
// internal/evm's test helper of the same name (unexported there, so duplicated
// here rather than exported purely for tests).
func assetsDir(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not determine test file path")
	}
	// internal/api/server_test.go → ../../assets
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "assets"))
}

// newTestServer wires a real Blockchain + ContractBridge into the api package's
// shared handler state (via InitServer) and returns the route table via newMux,
// so tests exercise real route matching (method + {voter_id} path params)
// instead of calling handlers directly.
func newTestServer(t *testing.T) http.Handler {
	t.Helper()

	bc := core.NewBlockchain("Stage 4 API test question", []string{"Yes", "No"})

	sm, err := evm.NewStateManager()
	if err != nil {
		t.Fatalf("NewStateManager: %v", err)
	}
	caller := evm.NewContractCaller(evm.CreateStatelessEVM(sm.GetStateDB()))
	bridge, err := evm.NewContractBridge(caller, assetsDir(t), "Stage 4 API test question", []string{"Yes", "No"})
	if err != nil {
		t.Skipf("skipping API tests — contract artifacts unavailable (%v)", err)
	}

	InitServer(bc, &persistence.FileStore{}, bridge)
	t.Cleanup(func() { InitServer(nil, nil, nil) })

	return newPublicMux()
}

func TestHandleGetVotingData(t *testing.T) {
	mux := newTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/voting-data", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	// Decode as a generic map: the wire format is what browser clients see,
	// so assert on the JSON keys/types directly (root and election_id are
	// strings by design — see VotingData.MarshalJSON).
	var got map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v (body: %s)", err, rec.Body.String())
	}
	if got["question"] != "Stage 4 API test question" {
		t.Errorf("unexpected question: %v", got["question"])
	}
	if size, ok := got["tree_size"].(float64); !ok || size != 0 {
		t.Errorf("expected numeric tree_size 0, got %v", got["tree_size"])
	}
	if root, ok := got["root"].(string); !ok || len(root) < 2 || root[:2] != "0x" {
		t.Errorf("expected root as 0x-hex string, got %v", got["root"])
	}
	if _, ok := got["election_id"].(string); !ok {
		t.Errorf("expected election_id as string, got %v", got["election_id"])
	}
}

func TestHandleGetVoterData(t *testing.T) {
	mux := newTestServer(t)

	// Before AddVoter: should still return 200 with allowed=false, registered=false
	// (getVoterData never reverts — it just returns the zero-value mapping entries).
	req := httptest.NewRequest(http.MethodGet, "/voter/alice@example.com", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var got evm.VoterData
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v (body: %s)", err, rec.Body.String())
	}
	if got.Allowed || got.Registered {
		t.Errorf("expected voter to be unknown (false, false), got %+v", got)
	}
}

func TestHandleGetVoterData_MissingIDNotRoutable(t *testing.T) {
	mux := newTestServer(t)

	// GET /voter/ (no ID segment) does not match "GET /voter/{voter_id}" at all —
	// ServeMux returns 404 before the handler's own empty-string check ever runs.
	req := httptest.NewRequest(http.MethodGet, "/voter/", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404 for /voter/ with no id segment, got %d", rec.Code)
	}
}

// TestHandleGetCommitments_OrderAndResetScoping verifies handleGetCommitments
// returns commitments in insertion order and excludes anything registered before
// the most recent RESET_ELECTION — otherwise a client rebuilding the Merkle tree
// locally (see packages/blockchain/integration-test) would reconstruct a tree
// that doesn't match the live on-chain root.
//
// This drives bc directly (bypassing HTTP/admin-auth) since handleGetCommitments
// only reads the blockchain's transaction log, not the EVM bridge — same pattern
// as internal/evm/replay_test.go's newTestBlockchain helper.
func TestHandleGetCommitments_OrderAndResetScoping(t *testing.T) {
	bc := core.NewBlockchain("Commitments test", []string{"Yes", "No"})
	InitServer(bc, &persistence.FileStore{}, nil)
	t.Cleanup(func() { InitServer(nil, nil, nil) })
	mux := newPublicMux()

	addRegisterTx := func(voterID, commitment string) {
		tx, err := core.NewTransaction(core.TxRegister, core.RegisterPayload{
			VoterID: voterID, Commitment: commitment,
		})
		if err != nil {
			t.Fatalf("NewTransaction REGISTER: %v", err)
		}
		if _, err := bc.AddTransaction(tx); err != nil {
			t.Fatalf("AddTransaction REGISTER: %v", err)
		}
	}
	getCommitments := func() []string {
		req := httptest.NewRequest(http.MethodGet, "/commitments", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
		}
		var got []string
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode response: %v (body: %s)", err, rec.Body.String())
		}
		return got
	}

	if got := getCommitments(); len(got) != 0 {
		t.Fatalf("expected no commitments initially, got %v", got)
	}

	addRegisterTx("alice@example.com", "0x1")
	addRegisterTx("bob@example.com", "0x2")

	got := getCommitments()
	want := []string{"0x1", "0x2"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("expected commitments in insertion order %v, got %v", want, got)
	}

	// A reset must exclude everything registered before it.
	resetTx, err := core.NewTransaction(core.TxResetElection, struct{}{})
	if err != nil {
		t.Fatalf("NewTransaction RESET_ELECTION: %v", err)
	}
	if _, err := bc.AddTransaction(resetTx); err != nil {
		t.Fatalf("AddTransaction RESET_ELECTION: %v", err)
	}

	if got := getCommitments(); len(got) != 0 {
		t.Fatalf("expected no commitments right after reset, got %v", got)
	}

	addRegisterTx("carol@example.com", "0x3")

	got = getCommitments()
	if len(got) != 1 || got[0] != "0x3" {
		t.Fatalf("expected only post-reset commitments [0x3], got %v", got)
	}
}

func TestHandleGetVotingData_NoBridge(t *testing.T) {
	bc := core.NewBlockchain("no bridge", nil)
	InitServer(bc, &persistence.FileStore{}, nil)
	t.Cleanup(func() { InitServer(nil, nil, nil) })

	req := httptest.NewRequest(http.MethodGet, "/voting-data", nil)
	rec := httptest.NewRecorder()
	newPublicMux().ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503 when bridge is nil, got %d", rec.Code)
	}
}
