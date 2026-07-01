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

	return newMux()
}

func TestHandleGetVotingData(t *testing.T) {
	mux := newTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/voting-data", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var got evm.VotingData
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v (body: %s)", err, rec.Body.String())
	}
	if got.Question != "Stage 4 API test question" {
		t.Errorf("unexpected question: %q", got.Question)
	}
	if got.TreeSize == nil || got.TreeSize.Sign() != 0 {
		t.Errorf("expected empty tree, got %v", got.TreeSize)
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

func TestHandleGetVotingData_NoBridge(t *testing.T) {
	bc := core.NewBlockchain("no bridge", nil)
	InitServer(bc, &persistence.FileStore{}, nil)
	t.Cleanup(func() { InitServer(nil, nil, nil) })

	req := httptest.NewRequest(http.MethodGet, "/voting-data", nil)
	rec := httptest.NewRecorder()
	newMux().ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503 when bridge is nil, got %d", rec.Code)
	}
}
