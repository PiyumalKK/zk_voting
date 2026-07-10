package network

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"zk-blockchain/internal/core"
)

// mockStore is a minimal SaveBlockchain implementation for tests that don't
// need real persistence — just a call counter.
type mockStore struct {
	mu    sync.Mutex
	saves int
}

func (m *mockStore) SaveBlockchain(*core.Blockchain) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.saves++
	return nil
}

// newPeerServer starts an httptest TLS server that serves the given blockchain's
// blocks at /internal/chain, mimicking handleSendChain. Cleans itself up and
// resets the package-level Peers/tlsClient at test end so tests don't leak state.
func newPeerServer(t *testing.T, bc *core.Blockchain) *httptest.Server {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(bc.GetBlocks())
	}))
	t.Cleanup(srv.Close)
	return srv
}

// withPeer points the package-level Peers/tlsClient at srv for the duration of
// the test, restoring the previous values afterward (these are shared package
// state, so tests using them must not run in parallel with each other).
func withPeer(t *testing.T, srv *httptest.Server) {
	t.Helper()
	prevPeers, prevClient := Peers, tlsClient
	Peers = []string{srv.URL}
	tlsClient = srv.Client()
	t.Cleanup(func() {
		Peers, tlsClient = prevPeers, prevClient
	})
}

func longerChain(t *testing.T, extraBlocks int) *core.Blockchain {
	t.Helper()
	bc := core.NewBlockchain("Peer's chain", []string{"Yes", "No"})
	for i := 0; i < extraBlocks; i++ {
		tx, err := core.NewTransaction(core.TxAddVoter, core.AddVoterPayload{
			VoterID: "voter", Allowed: true,
		})
		if err != nil {
			t.Fatalf("NewTransaction: %v", err)
		}
		if _, err := bc.AddTransaction(tx); err != nil {
			t.Fatalf("AddTransaction: %v", err)
		}
	}
	return bc
}

func TestSyncWithPeers_AdoptsLongerChain(t *testing.T) {
	peerChain := longerChain(t, 3) // genesis + 3 = 4 blocks
	srv := newPeerServer(t, peerChain)
	withPeer(t, srv)

	bc := core.NewBlockchain("Our chain", nil) // just genesis = 1 block
	store := &mockStore{}

	synced := SyncWithPeers(bc, store)

	if !synced {
		t.Fatal("expected SyncWithPeers to report a sync happened")
	}
	if bc.Len() != peerChain.Len() {
		t.Errorf("expected local chain to adopt peer's %d blocks, got %d", peerChain.Len(), bc.Len())
	}
	if store.saves != 1 {
		t.Errorf("expected exactly 1 SaveBlockchain call, got %d", store.saves)
	}
}

func TestSyncWithPeers_IgnoresShorterOrEqualChain(t *testing.T) {
	peerChain := longerChain(t, 0) // genesis only — same length as ours
	srv := newPeerServer(t, peerChain)
	withPeer(t, srv)

	bc := core.NewBlockchain("Our chain", nil)
	store := &mockStore{}

	synced := SyncWithPeers(bc, store)

	if synced {
		t.Error("expected no sync when peer's chain is not longer than ours")
	}
	if store.saves != 0 {
		t.Errorf("expected no SaveBlockchain call, got %d", store.saves)
	}
}

// TestSyncWithPeers_MutatesInPlace is the regression test for the exact bug
// ReplaceBlocks was introduced to fix: a caller holding the *core.Blockchain
// pointer from before the sync call must see the update — SyncWithPeers must
// NOT require the caller to swap a variable to observe the new chain.
func TestSyncWithPeers_MutatesInPlace(t *testing.T) {
	peerChain := longerChain(t, 2)
	srv := newPeerServer(t, peerChain)
	withPeer(t, srv)

	bc := core.NewBlockchain("Our chain", nil)
	held := bc // simulates api.InitServer capturing this pointer before sync runs
	store := &mockStore{}

	SyncWithPeers(bc, store)

	if held.Len() != peerChain.Len() {
		t.Errorf("a pointer captured before sync must observe the replaced chain; got %d blocks, want %d",
			held.Len(), peerChain.Len())
	}
}

func TestStartPeriodicSync_TicksAndInvokesCallback(t *testing.T) {
	peerChain := longerChain(t, 1)
	srv := newPeerServer(t, peerChain)
	withPeer(t, srv)

	bc := core.NewBlockchain("Our chain", nil)
	store := &mockStore{}

	var onSyncCalls int32
	stop := StartPeriodicSync(bc, store, 20*time.Millisecond, func() {
		atomic.AddInt32(&onSyncCalls, 1)
	}, nil, nil)
	defer stop()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if atomic.LoadInt32(&onSyncCalls) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	if atomic.LoadInt32(&onSyncCalls) == 0 {
		t.Fatal("expected onSync to be called at least once within the deadline")
	}
	if bc.Len() != peerChain.Len() {
		t.Errorf("expected bc to have adopted the peer's chain, got %d blocks, want %d", bc.Len(), peerChain.Len())
	}
}

func TestStartPeriodicSync_DisabledWithZeroInterval(t *testing.T) {
	bc := core.NewBlockchain("Our chain", nil)
	store := &mockStore{}

	called := false
	StartPeriodicSync(bc, store, 0, func() { called = true }, nil, nil)

	time.Sleep(50 * time.Millisecond)
	if called {
		t.Error("expected StartPeriodicSync to do nothing when interval <= 0")
	}
}
