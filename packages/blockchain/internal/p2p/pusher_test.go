package p2p

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"zk-blockchain/internal/chain"
	"zk-blockchain/internal/config"
)

// noSleep replaces the retry backoff in tests. The backoff schedule itself
// is not what is under test — that a failed push is retried, and a refused
// one is not, is.
func noSleep(_ context.Context, _ time.Duration) {}

// newReplicaHandler builds the replica-side handler for seq, applying
// straight to its chain.
func newReplicaHandler(t *testing.T, seq *chain.Sequencer) http.Handler {
	t.Helper()

	handler, err := NewHandler(HandlerConfig{
		Role:    config.RoleReplica,
		Chain:   seq,
		Applier: directApplier{seq: seq},
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	return handler
}

// TestPusherAnnouncesEverySealedBlockToEveryPeer wires the pusher to the
// sequencer's real block feed, the way cmd/node does, and mines through it.
func TestPusherAnnouncesEverySealedBlockToEveryPeer(t *testing.T) {
	primary := newChain(t)
	replicaA := newChain(t)
	replicaB := newChain(t)

	serverA := httptest.NewServer(newReplicaHandler(t, replicaA))
	t.Cleanup(serverA.Close)
	serverB := httptest.NewServer(newReplicaHandler(t, replicaB))
	t.Cleanup(serverB.Close)

	pusher := NewPusher(PusherConfig{
		Peers: []*Client{
			NewClientWithHTTP(serverA.URL, serverA.Client()),
			NewClientWithHTTP(serverB.URL, serverB.Client()),
		},
		sleep: noSleep,
	})

	// Subscribe before mining, exactly as cmd/node must: a subscription
	// taken afterwards would miss the blocks already sealed.
	events := primary.Subscribe(32)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go pusher.Run(ctx, events)

	mineBlocks(t, primary, 5)

	waitFor(t, 10*time.Second, "both replicas to reach block 5", func() bool {
		return chainHeight(t, replicaA) == 5 && chainHeight(t, replicaB) == 5
	})
	if pusher.Dropped() != 0 {
		t.Errorf("dropped %d pushes on an idle link", pusher.Dropped())
	}
}

// TestPusherRetriesATransientFailure: a replica that is briefly failing
// (restarting, a slow disk) must not cost the cluster a block. Three
// failures then a success, with the retry budget at its default of 3.
func TestPusherRetriesATransientFailure(t *testing.T) {
	primary := newChain(t)
	replica := newChain(t)
	// Not named `real`: that shadows a Go builtin.
	upstream := newReplicaHandler(t, replica)

	var attempts atomic.Int32
	flaky := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == PathBlock && attempts.Add(1) <= 3 {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(ErrorResponse{Code: CodeInternal, Message: "still starting up"})
			return
		}
		upstream.ServeHTTP(w, r)
	}))
	t.Cleanup(flaky.Close)

	pusher := NewPusher(PusherConfig{
		Peers: []*Client{NewClientWithHTTP(flaky.URL, flaky.Client())},
		sleep: noSleep,
	})

	events := primary.Subscribe(8)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go pusher.Run(ctx, events)

	mineBlocks(t, primary, 1)

	waitFor(t, 10*time.Second, "the block to land after retries", func() bool {
		return chainHeight(t, replica) == 1
	})
	if got := attempts.Load(); got != 4 {
		t.Errorf("attempts = %d, want 4 (the initial try plus 3 retries)", got)
	}
}

// TestPusherDoesNotRetryARefusal is the other half of the retry policy. A
// state-root mismatch is a considered verdict: asking again produces the
// same verdict, four identical CRITICAL log lines, and no progress.
func TestPusherDoesNotRetryARefusal(t *testing.T) {
	primary := newChain(t)

	var attempts atomic.Int32
	refusing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(ErrorResponse{Code: CodeStateMismatch, Message: "block 1: stateRoot mismatch"})
	}))
	t.Cleanup(refusing.Close)

	pusher := NewPusher(PusherConfig{
		Peers: []*Client{NewClientWithHTTP(refusing.URL, refusing.Client())},
		sleep: noSleep,
	})

	events := primary.Subscribe(8)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go pusher.Run(ctx, events)

	mineBlocks(t, primary, 1)

	waitFor(t, 5*time.Second, "the push to be attempted", func() bool {
		return attempts.Load() >= 1
	})
	// Give any (incorrect) retry time to arrive before concluding.
	time.Sleep(100 * time.Millisecond)
	if got := attempts.Load(); got != 1 {
		t.Errorf("attempts = %d, want exactly 1: a refusal is not retryable", got)
	}
}

// TestSealingIsNeverBlockedByAnUnresponsivePeer is M10 deliverable 4's
// actual requirement. A replica that accepts connections and then never
// answers is the worst case for a naive implementation: every push would
// block until timeout, and with a synchronous pusher the sequencer would
// seal at the speed of the slowest replica.
func TestSealingIsNeverBlockedByAnUnresponsivePeer(t *testing.T) {
	primary := newChain(t)

	release := make(chan struct{})
	blackhole := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	// Cleanup order matters and is LIFO: releasing the stuck handlers must
	// be registered *after* Close, so it runs *before* it. Close waits for
	// outstanding requests, and requests that are blocked forever would
	// hang the test rather than fail it.
	t.Cleanup(blackhole.Close)
	t.Cleanup(func() { close(release) })

	pusher := NewPusher(PusherConfig{
		Peers:     []*Client{NewClientWithHTTP(blackhole.URL, blackhole.Client())},
		QueueSize: 2,
		Timeout:   50 * time.Millisecond,
		sleep:     noSleep,
	})

	events := primary.Subscribe(32)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go pusher.Run(ctx, events)

	// Sealing 30 blocks against a peer that answers nothing must take about
	// as long as sealing 30 blocks against no peer at all. The bound is
	// deliberately loose (the point is "not blocked", not a benchmark) but
	// far below what a synchronous push would cost: 30 blocks at a 50 ms
	// timeout each is at least 1.5 s even before retries.
	started := time.Now()
	mineBlocks(t, primary, 30)
	elapsed := time.Since(started)

	if elapsed > time.Second {
		t.Errorf("sealing 30 blocks took %s with an unresponsive peer; pushing is not fire-and-forget", elapsed)
	}
	waitFor(t, 5*time.Second, "the pusher to start dropping for a stuck peer", func() bool {
		return pusher.Dropped() > 0
	})
}

func TestPusherWithNoPeersIsHarmless(t *testing.T) {
	primary := newChain(t)
	pusher := NewPusher(PusherConfig{sleep: noSleep})

	events := primary.Subscribe(8)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	stopped := make(chan struct{})
	go func() {
		pusher.Run(ctx, events)
		close(stopped)
	}()

	mineBlocks(t, primary, 3)
	if got := chainHeight(t, primary); got != 3 {
		t.Errorf("height = %d, want 3", got)
	}
	if pusher.Dropped() != 0 {
		t.Errorf("dropped = %d, want 0", pusher.Dropped())
	}

	cancel()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after its context was cancelled")
	}
}
