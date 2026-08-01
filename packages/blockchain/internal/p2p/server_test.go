package p2p

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"

	"zk-blockchain/internal/chain"
	"zk-blockchain/internal/config"
)

// directApplier is the push path without a Follower's catch-up behaviour:
// every pushed block goes straight into the same verifying apply path a
// real replica uses, so these tests exercise real verification while
// keeping the asynchronous parts (kicks, polling) out of the picture. The
// Follower's own behaviour is tested in follower_test.go.
type directApplier struct {
	seq *chain.Sequencer
}

func (d directApplier) ApplyBlock(block *types.Block) error {
	return d.seq.ApplyExternalBlock(block)
}

// newPrimaryEndpoint serves seq's chain in the primary role (reads only).
func newPrimaryEndpoint(t *testing.T, seq *chain.Sequencer, maxPull int) *Client {
	t.Helper()

	handler, err := NewHandler(HandlerConfig{Role: config.RolePrimary, Chain: seq, MaxPullLimit: maxPull})
	if err != nil {
		t.Fatalf("NewHandler(primary): %v", err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	return NewClientWithHTTP(server.URL, server.Client())
}

// newReplicaEndpoint serves seq's chain in the replica role, accepting
// pushes through applier.
func newReplicaEndpoint(t *testing.T, seq *chain.Sequencer, applier BlockApplier) *Client {
	t.Helper()

	handler, err := NewHandler(HandlerConfig{Role: config.RoleReplica, Chain: seq, Applier: applier})
	if err != nil {
		t.Fatalf("NewHandler(replica): %v", err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	return NewClientWithHTTP(server.URL, server.Client())
}

func TestNewHandlerValidatesItsConfiguration(t *testing.T) {
	seq := newChain(t)

	if _, err := NewHandler(HandlerConfig{Role: config.RolePrimary}); err == nil {
		t.Error("NewHandler accepted a configuration with no chain")
	}
	if _, err := NewHandler(HandlerConfig{Role: config.RoleReplica, Chain: seq}); err == nil {
		t.Error("NewHandler accepted a replica with no applier: it would 500 on every push")
	}
	if _, err := NewHandler(HandlerConfig{Role: "observer", Chain: seq}); err == nil {
		t.Error("NewHandler accepted an unknown role")
	}
	if _, err := NewHandler(HandlerConfig{Role: config.RolePrimary, Chain: seq}); err != nil {
		t.Errorf("NewHandler(primary with a chain) = %v, want nil", err)
	}
}

func TestHeadReportsTheLocalHead(t *testing.T) {
	seq := newChain(t)
	blocks := mineBlocks(t, seq, 3)
	client := newPrimaryEndpoint(t, seq, 0)

	head, err := client.Head(context.Background())
	if err != nil {
		t.Fatalf("Head: %v", err)
	}
	if head.Number != 3 {
		t.Errorf("head number = %d, want 3", head.Number)
	}
	// The hash is what makes the answer meaningful: two nodes can agree on a
	// height while disagreeing on every block in it.
	if head.Hash != blocks[2].Hash() {
		t.Errorf("head hash = %s, want %s", head.Hash, blocks[2].Hash())
	}
}

func TestBlocksServesTheRequestedRange(t *testing.T) {
	seq := newChain(t)
	blocks := mineBlocks(t, seq, 5)
	client := newPrimaryEndpoint(t, seq, 0)

	resp, err := client.Blocks(context.Background(), 2, 3)
	if err != nil {
		t.Fatalf("Blocks: %v", err)
	}
	if resp.Head != 5 {
		t.Errorf("reported head = %d, want 5", resp.Head)
	}
	if len(resp.Blocks) != 3 {
		t.Fatalf("returned %d blocks, want 3", len(resp.Blocks))
	}

	for i, msg := range resp.Blocks {
		want := blocks[i+1] // blocks[0] is block 1, so blocks[1] is block 2
		if msg.Number != want.NumberU64() {
			t.Errorf("block %d: number = %d, want %d", i, msg.Number, want.NumberU64())
		}
		decoded, err := msg.Decode()
		if err != nil {
			t.Fatalf("block %d: Decode: %v", i, err)
		}
		if decoded.Hash() != want.Hash() {
			t.Errorf("block %d: hash = %s, want %s", i, decoded.Hash(), want.Hash())
		}
	}
}

// TestBlocksBeyondTheHeadIsAnEmptyAnswerNotAnError: a synced replica asks
// for head+1 on every poll. If that were a 404, a healthy idle cluster would
// log an error every five seconds.
func TestBlocksBeyondTheHeadIsAnEmptyAnswerNotAnError(t *testing.T) {
	seq := newChain(t)
	mineBlocks(t, seq, 2)
	client := newPrimaryEndpoint(t, seq, 0)

	resp, err := client.Blocks(context.Background(), 3, 10)
	if err != nil {
		t.Fatalf("Blocks: %v", err)
	}
	if len(resp.Blocks) != 0 {
		t.Errorf("returned %d blocks, want 0", len(resp.Blocks))
	}
	if resp.Head != 2 {
		t.Errorf("reported head = %d, want 2", resp.Head)
	}
}

// TestBlocksCapsTheRequestedLimit: the limit is the server's, not the
// caller's. Otherwise one request could ask a node to encode its entire
// chain into a single response body.
func TestBlocksCapsTheRequestedLimit(t *testing.T) {
	seq := newChain(t)
	mineBlocks(t, seq, 6)
	client := newPrimaryEndpoint(t, seq, 2)

	resp, err := client.Blocks(context.Background(), 1, 1000)
	if err != nil {
		t.Fatalf("Blocks: %v", err)
	}
	if len(resp.Blocks) != 2 {
		t.Errorf("returned %d blocks, want the server cap of 2", len(resp.Blocks))
	}
}

func TestBlocksRejectsUnusableParameters(t *testing.T) {
	seq := newChain(t)
	mineBlocks(t, seq, 1)
	client := newPrimaryEndpoint(t, seq, 0)

	// from=0 asks for genesis, which is never transferred.
	if _, err := client.Blocks(context.Background(), 0, 10); err == nil {
		t.Error("Blocks(from=0) was accepted; genesis is derived locally, never sent")
	}

	// A non-numeric parameter, which the typed client cannot produce.
	resp, err := http.Get(client.BaseURL() + PathBlocks + "?from=banana")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
}

func TestPrimaryRefusesPushedBlocks(t *testing.T) {
	primary := newChain(t)
	other := newChain(t)
	block := mineBlocks(t, other, 1)[0]

	client := newPrimaryEndpoint(t, primary, 0)
	_, err := client.PushBlock(context.Background(), block)

	var remote *RemoteError
	if !errors.As(err, &remote) {
		t.Fatalf("PushBlock error = %v, want a *RemoteError", err)
	}
	if remote.StatusCode != http.StatusForbidden || remote.Code != CodeRefused {
		t.Errorf("status/code = %d/%s, want 403/%s", remote.StatusCode, remote.Code, CodeRefused)
	}
	if got := chainHeight(t, primary); got != 0 {
		t.Errorf("the sequencer's chain moved to %d on a pushed block", got)
	}
}

// TestPushedBlocksBecomeTheReplicaHead is the happy path end to end: real
// blocks, real encoding, real HTTP, real verification.
func TestPushedBlocksBecomeTheReplicaHead(t *testing.T) {
	primary := newChain(t)
	replica := newChain(t)
	client := newReplicaEndpoint(t, replica, directApplier{seq: replica})

	blocks := mineBlocks(t, primary, 4)
	for _, block := range blocks {
		resp, err := client.PushBlock(context.Background(), block)
		if err != nil {
			t.Fatalf("PushBlock(%d): %v", block.NumberU64(), err)
		}
		if resp.Status != StatusApplied {
			t.Errorf("block %d: status = %q, want %q", block.NumberU64(), resp.Status, StatusApplied)
		}
	}

	primaryHeight, primaryHash, err := primary.HeadInfo()
	if err != nil {
		t.Fatalf("primary HeadInfo: %v", err)
	}
	replicaHeight, replicaHash, err := replica.HeadInfo()
	if err != nil {
		t.Fatalf("replica HeadInfo: %v", err)
	}
	if replicaHeight != primaryHeight || replicaHash != primaryHash {
		t.Errorf("replica head = %d/%s, primary head = %d/%s",
			replicaHeight, replicaHash, primaryHeight, primaryHash)
	}
}

func TestDuplicatePushIsReportedAsDuplicate(t *testing.T) {
	primary := newChain(t)
	replica := newChain(t)
	client := newReplicaEndpoint(t, replica, directApplier{seq: replica})
	block := mineBlocks(t, primary, 1)[0]

	if _, err := client.PushBlock(context.Background(), block); err != nil {
		t.Fatalf("first push: %v", err)
	}
	resp, err := client.PushBlock(context.Background(), block)
	if err != nil {
		t.Fatalf("second push returned an error, want a duplicate success: %v", err)
	}
	if resp.Status != StatusDuplicate {
		t.Errorf("status = %q, want %q", resp.Status, StatusDuplicate)
	}
}

func TestOutOfOrderPushReturnsAGapWithTheHeightNeeded(t *testing.T) {
	primary := newChain(t)
	replica := newChain(t)
	client := newReplicaEndpoint(t, replica, directApplier{seq: replica})

	blocks := mineBlocks(t, primary, 3)
	_, err := client.PushBlock(context.Background(), blocks[2]) // block 3, nothing before it

	var remote *RemoteError
	if !errors.As(err, &remote) {
		t.Fatalf("PushBlock error = %v, want a *RemoteError", err)
	}
	if remote.StatusCode != http.StatusConflict {
		t.Errorf("status = %d, want 409", remote.StatusCode)
	}
	if remote.Code != CodeGap {
		t.Errorf("code = %q, want %q", remote.Code, CodeGap)
	}
	if remote.Expected != 1 {
		t.Errorf("expected = %d, want 1", remote.Expected)
	}
	// A gap is the replica being behind, not the block being bad — so it
	// must not be retried into an error storm.
	if remote.Retryable() {
		t.Error("a gap was reported as retryable; re-pushing cannot fix it, pulling can")
	}
}

// TestTamperedPushIsRefusedWithAStateMismatch is the M10 tamper scenario in
// Go form (the cluster test repeats it across a real three-node cluster):
// take a block the primary really sealed, change the state root it claims,
// and watch the replica re-execute and refuse it.
func TestTamperedPushIsRefusedWithAStateMismatch(t *testing.T) {
	primary := newChain(t)
	replica := newChain(t)
	client := newReplicaEndpoint(t, replica, directApplier{seq: replica})

	honest := mineBlocks(t, primary, 1)[0]
	header := honest.Header()
	header.Root = common.HexToHash("0x4444444444444444444444444444444444444444444444444444444444444444")
	// The block carries no transactions, so a header-only copy is a faithful
	// forgery of it — nothing in the body is lost.
	forged := types.NewBlockWithHeader(header)

	_, err := client.PushBlock(context.Background(), forged)

	var remote *RemoteError
	if !errors.As(err, &remote) {
		t.Fatalf("PushBlock error = %v, want a *RemoteError", err)
	}
	if remote.StatusCode != http.StatusConflict {
		t.Errorf("status = %d, want 409", remote.StatusCode)
	}
	if remote.Code != CodeStateMismatch {
		t.Errorf("code = %q, want %q", remote.Code, CodeStateMismatch)
	}
	if remote.Retryable() {
		t.Error("a state mismatch was reported as retryable")
	}
	if got := chainHeight(t, replica); got != 0 {
		t.Errorf("replica height = %d, want 0: a refused block must leave no trace", got)
	}
}

func TestMalformedPushBodiesAreRejected(t *testing.T) {
	replica := newChain(t)
	client := newReplicaEndpoint(t, replica, directApplier{seq: replica})

	tests := []struct {
		name string
		body string
	}{
		{name: "not json", body: "{"},
		{name: "no payload", body: `{"number":1,"rlp":"0x"}`},
		{name: "payload is not a block", body: `{"number":1,"rlp":"0xdeadbeef"}`},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			resp, err := http.Post(client.BaseURL()+PathBlock, "application/json", bytes.NewBufferString(tc.body))
			if err != nil {
				t.Fatalf("POST: %v", err)
			}
			defer func() { _ = resp.Body.Close() }()

			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", resp.StatusCode)
			}
			var body ErrorResponse
			if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
				t.Fatalf("decode error body: %v", err)
			}
			if body.Code != CodeMalformed {
				t.Errorf("code = %q, want %q", body.Code, CodeMalformed)
			}
		})
	}
}

func TestWrongMethodsAreRejected(t *testing.T) {
	seq := newChain(t)
	client := newPrimaryEndpoint(t, seq, 0)

	// POST to a read endpoint.
	resp, err := http.Post(client.BaseURL()+PathHead, "application/json", nil)
	if err != nil {
		t.Fatalf("POST %s: %v", PathHead, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST %s status = %d, want 405", PathHead, resp.StatusCode)
	}

	// GET the push endpoint.
	getResp, err := http.Get(client.BaseURL() + PathBlock)
	if err != nil {
		t.Fatalf("GET %s: %v", PathBlock, err)
	}
	defer func() { _ = getResp.Body.Close() }()
	if getResp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("GET %s status = %d, want 405", PathBlock, getResp.StatusCode)
	}
}

// TestPushOverMutualTLS runs the same push through the real transport: the
// mTLS listener, the mTLS client, and the certificates certgen.go produces.
// The tests above use plain HTTP to keep protocol failures legible; this one
// makes sure the composition they skip actually works.
func TestPushOverMutualTLS(t *testing.T) {
	certs := newCertSet(t, "primary", "replica1")

	primary := newChain(t)
	replica := newChain(t)

	handler, err := NewHandler(HandlerConfig{
		Role:    config.RoleReplica,
		Chain:   replica,
		Applier: directApplier{seq: replica},
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	url := serveTLS(t, certs.serverConfig(t, "replica1"), handler)

	client, err := NewClient(url, certs.clientConfig(t, "primary"), 5*time.Second)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	block := mineBlocks(t, primary, 1)[0]
	resp, err := client.PushBlock(context.Background(), block)
	if err != nil {
		t.Fatalf("PushBlock over mTLS: %v", err)
	}
	if resp.Status != StatusApplied {
		t.Errorf("status = %q, want %q", resp.Status, StatusApplied)
	}
	if got := chainHeight(t, replica); got != 1 {
		t.Errorf("replica height = %d, want 1", got)
	}
}
