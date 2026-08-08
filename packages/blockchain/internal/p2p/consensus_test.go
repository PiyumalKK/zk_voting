package p2p

import (
	"context"
	"crypto/ecdsa"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"

	"zk-blockchain/internal/config"
	"zk-blockchain/internal/consensus"
)

// Hardhat account #0, the same non-secret key the rest of this repo's tests
// sign with. See internal/consensus/testutil_test.go.
const testValidatorKey = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

func validatorKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	key, err := crypto.HexToECDSA(testValidatorKey)
	if err != nil {
		t.Fatalf("HexToECDSA: %v", err)
	}
	return key
}

func singleValidatorSet(t *testing.T) *consensus.ValidatorSet {
	t.Helper()
	addr := crypto.PubkeyToAddress(validatorKey(t).PublicKey)
	vs, err := consensus.NewValidatorSet([]config.ValidatorEntry{{Name: "authority", Address: addr}}, 1)
	if err != nil {
		t.Fatalf("NewValidatorSet: %v", err)
	}
	return vs
}

// capturingReceiver records what the handler delivered to the engine.
type capturingReceiver struct {
	got chan *consensus.SignedMessage
}

func newCapturingReceiver() *capturingReceiver {
	return &capturingReceiver{got: make(chan *consensus.SignedMessage, 8)}
}

func (c *capturingReceiver) Deliver(msg *consensus.SignedMessage) {
	select {
	case c.got <- msg:
	default:
	}
}

// TestAConsensusMessageSurvivesTheWire is the property the transport rests
// on: a signature is over a digest of the message's own fields, so if any
// signed field changed in transit, every receiver would compute a different
// digest and reject every message. That failure would be total and would look
// like a network fault, so it is worth proving directly — over a real HTTP
// round trip, not just a JSON round trip.
func TestAConsensusMessageSurvivesTheWire(t *testing.T) {
	seq := newChain(t)
	receiver := newCapturingReceiver()
	vs := singleValidatorSet(t)

	handler, err := NewHandler(HandlerConfig{
		Role: config.RolePrimary, Chain: seq, Consensus: receiver,
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	block := mineBlocks(t, seq, 1)[0]
	encoded, err := EncodeBlock(block)
	if err != nil {
		t.Fatalf("EncodeBlock: %v", err)
	}

	sent, err := consensus.Sign(testChainID, validatorKey(t), consensus.Message{
		Type: consensus.MsgProposal, Height: 1, Round: 2,
		BlockHash: block.Hash(), BlockRLP: encoded.RLP,
	})
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	client := NewClientWithHTTP(server.URL, server.Client())
	if err := client.SendConsensus(context.Background(), sent); err != nil {
		t.Fatalf("SendConsensus: %v", err)
	}

	select {
	case received := <-receiver.got:
		// The decisive check: the signature must still verify against the
		// message as it arrived.
		signer, err := consensus.Verify(testChainID, vs, received)
		if err != nil {
			t.Fatalf("the delivered message no longer verifies: %v", err)
		}
		if signer.Name != "authority" {
			t.Errorf("recovered %q, want authority", signer.Name)
		}
		if received.Round != 2 {
			t.Errorf("round = %d, want 2", received.Round)
		}
		// And the block must still be bound to the hash the signature covers.
		carried, err := received.Block()
		if err != nil {
			t.Fatalf("the carried block did not survive: %v", err)
		}
		if carried.Hash() != block.Hash() {
			t.Errorf("carried block hash = %s, want %s", carried.Hash(), block.Hash())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the handler never delivered the message to the engine")
	}
}

// TestASoloNodeDoesNotServeTheConsensusEndpoint: the endpoints are registered
// only when consensus is configured, so a solo node answers 404 exactly as it
// would for a path that was never written.
//
// That is stronger than a runtime flag check. There is no code path on a solo
// node that can reach a consensus state machine, because there is no handler
// and no engine — which is the same argument DEV_RPC's gating makes in
// internal/rpc/dev.go.
func TestASoloNodeDoesNotServeTheConsensusEndpoint(t *testing.T) {
	seq := newChain(t)
	handler, err := NewHandler(HandlerConfig{Role: config.RolePrimary, Chain: seq})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	for _, path := range []string{PathConsensus, PathCommitSeals} {
		resp, err := server.Client().Post(server.URL+path, "application/json", http.NoBody)
		if err != nil {
			t.Fatalf("POST %s: %v", path, err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("POST %s on a solo node returned %d, want 404", path, resp.StatusCode)
		}
	}
}

// TestTheConsensusEndpointRejectsGarbageWithoutDoingCrypto: shape checks run
// on the HTTP goroutine, signature recovery does not. A peer must not be able
// to make this node spend ECDSA recoveries — or any unbounded work — from the
// handler.
func TestTheConsensusEndpointRejectsGarbageWithoutDoingCrypto(t *testing.T) {
	seq := newChain(t)
	receiver := newCapturingReceiver()

	handler, err := NewHandler(HandlerConfig{
		Role: config.RolePrimary, Chain: seq, Consensus: receiver,
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	tests := []struct {
		name string
		body string
	}{
		{name: "not json", body: `{{{`},
		{name: "unknown message type", body: `{"type":99,"height":1,"signature":"0x00"}`},
		{name: "short signature", body: `{"type":2,"height":1,"signature":"0xdead"}`},
		{name: "proposal with no block", body: `{"type":1,"height":1,"signature":"0x` + repeat("00", 65) + `"}`},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			resp, err := server.Client().Post(server.URL+PathConsensus, "application/json", stringReader(tc.body))
			if err != nil {
				t.Fatalf("POST: %v", err)
			}
			_ = resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				t.Errorf("status = %d, want 400", resp.StatusCode)
			}
		})
	}

	select {
	case msg := <-receiver.got:
		t.Errorf("a malformed message reached the engine: %+v", msg.Message)
	default:
	}
}

// TestCommitSealsEndpointServesWhatItHasAndOmitsWhatItDoesNot.
//
// A block with no recorded certificate is omitted rather than reported as an
// error, and that choice is load-bearing: a block's validity is established
// by re-execution in replay.go, never by its seals, so a node syncing from a
// peer with a truncated seal store must still be able to sync. Refusing would
// turn a cosmetic gap in the audit trail into an outage.
func TestCommitSealsEndpointServesWhatItHasAndOmitsWhatItDoesNot(t *testing.T) {
	seq := newChain(t)
	blocks := mineBlocks(t, seq, 3)

	store := consensus.NewMemorySealStore()
	key := validatorKey(t)
	// Certificates for blocks 1 and 3 only; block 2 deliberately has none.
	for _, block := range []*types.Block{blocks[0], blocks[2]} {
		signed, err := consensus.Sign(testChainID, key, consensus.Message{
			Type: consensus.MsgCommit, Height: block.NumberU64(), BlockHash: block.Hash(),
		})
		if err != nil {
			t.Fatalf("Sign: %v", err)
		}
		if err := store.Put(block.NumberU64(), block.Hash(), &consensus.CommitSeals{
			Round: 1, Seals: [][]byte{signed.Signature},
		}); err != nil {
			t.Fatalf("Put: %v", err)
		}
	}

	handler, err := NewHandler(HandlerConfig{Role: config.RolePrimary, Chain: seq, Seals: store})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	client := NewClientWithHTTP(server.URL, server.Client())
	resp, err := client.CommitSeals(context.Background(), 1, 3)
	if err != nil {
		t.Fatalf("CommitSeals: %v", err)
	}

	if resp.Head != 3 {
		t.Errorf("Head = %d, want 3", resp.Head)
	}
	if len(resp.Seals) != 2 {
		t.Fatalf("got %d certificates, want 2 (block 2 has none)", len(resp.Seals))
	}
	got := map[uint64]common.Hash{}
	for _, entry := range resp.Seals {
		got[entry.Number] = entry.BlockHash
		if entry.Round != 1 {
			t.Errorf("block %d round = %d, want 1", entry.Number, entry.Round)
		}
		if len(entry.Seals) != 1 || len(entry.Seals[0]) != consensus.SignatureLength {
			t.Errorf("block %d carries %d seals of unexpected length", entry.Number, len(entry.Seals))
		}
	}
	if got[1] != blocks[0].Hash() || got[3] != blocks[2].Hash() {
		t.Errorf("wrong blocks served: %v", got)
	}
	if _, present := got[2]; present {
		t.Error("block 2 was served a certificate it does not have")
	}
}

// TestCommitSealsEndpointCapsItsResponse: the same bound /p2p/blocks enforces,
// for the same reason — one request must not be able to make this node buffer
// an unbounded slice of the chain.
func TestCommitSealsEndpointCapsItsResponse(t *testing.T) {
	seq := newChain(t)
	blocks := mineBlocks(t, seq, 6)

	store := consensus.NewMemorySealStore()
	key := validatorKey(t)
	for _, block := range blocks {
		signed, err := consensus.Sign(testChainID, key, consensus.Message{
			Type: consensus.MsgCommit, Height: block.NumberU64(), BlockHash: block.Hash(),
		})
		if err != nil {
			t.Fatalf("Sign: %v", err)
		}
		if err := store.Put(block.NumberU64(), block.Hash(), &consensus.CommitSeals{Seals: [][]byte{signed.Signature}}); err != nil {
			t.Fatalf("Put: %v", err)
		}
	}

	handler, err := NewHandler(HandlerConfig{
		Role: config.RolePrimary, Chain: seq, Seals: store, MaxPullLimit: 2,
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	client := NewClientWithHTTP(server.URL, server.Client())
	resp, err := client.CommitSeals(context.Background(), 1, 6)
	if err != nil {
		t.Fatalf("CommitSeals: %v", err)
	}
	if len(resp.Seals) != 2 {
		t.Errorf("got %d certificates with a limit of 2", len(resp.Seals))
	}
}

// TestConsensusTransportDeliversToEveryPeer covers the broadcast path,
// including the property that makes one dead validator survivable: an
// unreachable peer must not stop delivery to the reachable ones, and must not
// block the state machine.
func TestConsensusTransportDeliversToEveryPeer(t *testing.T) {
	seq := newChain(t)

	receiverA := newCapturingReceiver()
	receiverB := newCapturingReceiver()
	serverA := httptest.NewServer(mustConsensusHandler(t, seq, receiverA))
	t.Cleanup(serverA.Close)
	serverB := httptest.NewServer(mustConsensusHandler(t, seq, receiverB))
	t.Cleanup(serverB.Close)

	// A third peer that is not listening at all — the "one validator is down"
	// steady state.
	deadServer := httptest.NewServer(http.NotFoundHandler())
	deadURL := deadServer.URL
	deadServer.Close()

	transport := NewConsensusTransport(ConsensusTransportConfig{
		Peers: []*Client{
			NewClientWithHTTP(serverA.URL, serverA.Client()),
			NewClientWithHTTP(serverB.URL, serverB.Client()),
			NewClientWithHTTP(deadURL, &http.Client{Timeout: time.Second}),
		},
		Timeout: time.Second,
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go transport.Run(ctx)

	msg, err := consensus.Sign(testChainID, validatorKey(t), consensus.Message{
		Type: consensus.MsgPrepare, Height: 7, BlockHash: common.HexToHash("0xabc"),
	})
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	transport.Broadcast(msg)

	for name, receiver := range map[string]*capturingReceiver{"A": receiverA, "B": receiverB} {
		select {
		case got := <-receiver.got:
			if got.Height != 7 {
				t.Errorf("peer %s got height %d, want 7", name, got.Height)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("peer %s never received the broadcast (an unreachable third peer must not block delivery)", name)
		}
	}

	if dropped := transport.Dropped(); dropped != 0 {
		t.Errorf("dropped %d messages on an idle transport", dropped)
	}
}

// TestMultiPrimaryTakesTheHighestHead: with one validator allowed to be down
// and others possibly a block behind at any instant, asking a single peer
// would make "how far behind am I" depend on which peer was asked.
func TestMultiPrimaryTakesTheHighestHead(t *testing.T) {
	behind := newChain(t)
	mineBlocks(t, behind, 1)
	ahead := newChain(t)
	mineBlocks(t, ahead, 4)

	behindServer := httptest.NewServer(mustReadHandler(t, behind))
	t.Cleanup(behindServer.Close)
	aheadServer := httptest.NewServer(mustReadHandler(t, ahead))
	t.Cleanup(aheadServer.Close)

	// A dead peer first in the list, to prove it is skipped rather than fatal.
	deadServer := httptest.NewServer(http.NotFoundHandler())
	deadURL := deadServer.URL
	deadServer.Close()

	multi, err := NewMultiPrimary([]*Client{
		NewClientWithHTTP(deadURL, &http.Client{Timeout: time.Second}),
		NewClientWithHTTP(behindServer.URL, behindServer.Client()),
		NewClientWithHTTP(aheadServer.URL, aheadServer.Client()),
	})
	if err != nil {
		t.Fatalf("NewMultiPrimary: %v", err)
	}

	head, err := multi.Head(context.Background())
	if err != nil {
		t.Fatalf("Head: %v", err)
	}
	if head.Number != 4 {
		t.Errorf("Head().Number = %d, want the highest peer's 4", head.Number)
	}

	// And blocks must come from a peer that actually has them.
	resp, err := multi.Blocks(context.Background(), 2, 10)
	if err != nil {
		t.Fatalf("Blocks: %v", err)
	}
	if len(resp.Blocks) != 3 {
		t.Errorf("pulled %d blocks from height 2, want 3", len(resp.Blocks))
	}
}

// TestMultiPrimaryFailsOnlyWhenEveryPeerIsUnreachable: a single dead peer is
// an expected steady state, not an error.
func TestMultiPrimaryFailsOnlyWhenEveryPeerIsUnreachable(t *testing.T) {
	deadServer := httptest.NewServer(http.NotFoundHandler())
	deadURL := deadServer.URL
	deadServer.Close()

	multi, err := NewMultiPrimary([]*Client{NewClientWithHTTP(deadURL, &http.Client{Timeout: time.Second})})
	if err != nil {
		t.Fatalf("NewMultiPrimary: %v", err)
	}
	if _, err := multi.Head(context.Background()); err == nil {
		t.Error("Head succeeded with every peer unreachable")
	}

	if _, err := NewMultiPrimary(nil); err == nil {
		t.Error("NewMultiPrimary accepted an empty peer list")
	}
}

func stringReader(s string) io.Reader { return strings.NewReader(s) }

func repeat(s string, n int) string { return strings.Repeat(s, n) }

func mustConsensusHandler(t *testing.T, seq BlockStore, receiver ConsensusReceiver) http.Handler {
	t.Helper()
	handler, err := NewHandler(HandlerConfig{Role: config.RolePrimary, Chain: seq, Consensus: receiver})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	return handler
}

func mustReadHandler(t *testing.T, seq BlockStore) http.Handler {
	t.Helper()
	handler, err := NewHandler(HandlerConfig{Role: config.RolePrimary, Chain: seq})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	return handler
}
