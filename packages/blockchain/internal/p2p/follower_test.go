package p2p

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"

	"zk-blockchain/internal/chain"
)

// scriptedPrimary is a primary whose answers the test writes itself — used
// for the cases a real, honest primary cannot produce on demand: serving a
// tampered block, claiming a head it will not serve, or being unreachable.
type scriptedPrimary struct {
	head   HeadResponse
	blocks func(from uint64, limit int) (BlocksResponse, error)
}

func (s *scriptedPrimary) Head(_ context.Context) (HeadResponse, error) {
	return s.head, nil
}

func (s *scriptedPrimary) Blocks(_ context.Context, from uint64, limit int) (BlocksResponse, error) {
	return s.blocks(from, limit)
}

func newTestFollower(t *testing.T, replica *chain.Sequencer, primary PrimaryClient, pullLimit int) *Follower {
	t.Helper()

	follower, err := NewFollower(FollowerConfig{
		Chain:   replica,
		Applier: replica,
		Primary: primary,
		// Long enough that no test depends on the tick unless it asks for
		// it; the tests that do exercise polling set their own.
		PollInterval: time.Hour,
		PullLimit:    pullLimit,
	})
	if err != nil {
		t.Fatalf("NewFollower: %v", err)
	}
	return follower
}

func TestNewFollowerValidatesItsConfiguration(t *testing.T) {
	seq := newChain(t)
	primary := newPrimaryEndpoint(t, seq, 0)

	if _, err := NewFollower(FollowerConfig{Applier: seq, Primary: primary}); err == nil {
		t.Error("NewFollower accepted a configuration with no chain")
	}
	if _, err := NewFollower(FollowerConfig{Chain: seq, Primary: primary}); err == nil {
		t.Error("NewFollower accepted a configuration with no applier")
	}
	if _, err := NewFollower(FollowerConfig{Chain: seq, Applier: seq}); err == nil {
		t.Error("NewFollower accepted a configuration with no primary")
	}
}

// TestCatchUpPullsTheWholeChainInPages is the boot path: a replica
// provisioned after the election started must be able to reconstruct
// everything from genesis, verifying as it goes. The page size is set below
// the chain height on purpose — paginated catch-up is where an off-by-one
// would hide.
func TestCatchUpPullsTheWholeChainInPages(t *testing.T) {
	primary := newChain(t)
	mineBlocks(t, primary, 7)

	replica := newChain(t)
	follower := newTestFollower(t, replica, newPrimaryEndpoint(t, primary, 0), 3)

	if err := follower.CatchUp(context.Background()); err != nil {
		t.Fatalf("CatchUp: %v", err)
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
		t.Fatalf("replica head = %d/%s, primary head = %d/%s",
			replicaHeight, replicaHash, primaryHeight, primaryHash)
	}

	status := follower.Status()
	if !status.Synced {
		t.Errorf("status = %+v, want synced", status)
	}
	if status.PrimaryHeight != primaryHeight {
		t.Errorf("status primary height = %d, want %d", status.PrimaryHeight, primaryHeight)
	}
}

// TestCatchUpResumesFromWhereItStopped: the second call must fetch only what
// is new. A replica that re-pulled from genesis on every poll would work,
// slowly, and mask a broken resume — so the pull is asserted, not just the
// outcome.
func TestCatchUpResumesFromWhereItStopped(t *testing.T) {
	primary := newChain(t)
	mineBlocks(t, primary, 3)

	replica := newChain(t)
	endpoint := newPrimaryEndpoint(t, primary, 0)
	follower := newTestFollower(t, replica, endpoint, 0)

	if err := follower.CatchUp(context.Background()); err != nil {
		t.Fatalf("first CatchUp: %v", err)
	}
	if got := chainHeight(t, replica); got != 3 {
		t.Fatalf("height after first catch-up = %d, want 3", got)
	}

	mineBlocks(t, primary, 2)

	counted := &countingPrimary{inner: endpoint}
	resumed := newTestFollower(t, replica, counted, 0)
	if err := resumed.CatchUp(context.Background()); err != nil {
		t.Fatalf("second CatchUp: %v", err)
	}

	if got := chainHeight(t, replica); got != 5 {
		t.Errorf("height after second catch-up = %d, want 5", got)
	}
	if counted.firstFrom != 4 {
		t.Errorf("resumed pull started at block %d, want 4", counted.firstFrom)
	}
}

// countingPrimary records the first block a catch-up asked for.
type countingPrimary struct {
	inner     PrimaryClient
	firstFrom uint64
	calls     int
}

func (c *countingPrimary) Head(ctx context.Context) (HeadResponse, error) {
	return c.inner.Head(ctx)
}

func (c *countingPrimary) Blocks(ctx context.Context, from uint64, limit int) (BlocksResponse, error) {
	if c.calls == 0 {
		c.firstFrom = from
	}
	c.calls++
	return c.inner.Blocks(ctx, from, limit)
}

// TestCatchUpRefusesATamperedBlockFromAPull: a pulled block is verified
// exactly like a pushed one. If it were not, "which endpoint did this arrive
// on" would decide whether a block is trusted, and catch-up would be the way
// around the tamper check.
func TestCatchUpRefusesATamperedBlockFromAPull(t *testing.T) {
	source := newChain(t)
	honest := mineBlocks(t, source, 1)[0]

	header := honest.Header()
	header.Root = common.HexToHash("0x5555555555555555555555555555555555555555555555555555555555555555")
	forged, err := EncodeBlock(types.NewBlockWithHeader(header))
	if err != nil {
		t.Fatalf("EncodeBlock: %v", err)
	}

	liar := &scriptedPrimary{
		head: HeadResponse{Number: 1},
		blocks: func(_ uint64, _ int) (BlocksResponse, error) {
			return BlocksResponse{Head: 1, Blocks: []BlockMessage{forged}}, nil
		},
	}

	replica := newChain(t)
	follower := newTestFollower(t, replica, liar, 0)

	err = follower.CatchUp(context.Background())
	if err == nil {
		t.Fatal("CatchUp accepted a tampered block")
	}
	var mismatch *chain.ReplayMismatch
	if !errors.As(err, &mismatch) {
		t.Fatalf("error = %v, want a *chain.ReplayMismatch", err)
	}
	if mismatch.Field != "stateRoot" {
		t.Errorf("mismatch field = %q, want stateRoot", mismatch.Field)
	}
	if got := chainHeight(t, replica); got != 0 {
		t.Errorf("replica height = %d, want 0", got)
	}
}

// TestCatchUpStopsWhenThePrimaryMakesNoProgress guards the loop's
// termination condition. A primary that reports a head it will not serve
// would otherwise spin this loop forever, holding the apply lock.
func TestCatchUpStopsWhenThePrimaryMakesNoProgress(t *testing.T) {
	stalled := &scriptedPrimary{
		head: HeadResponse{Number: 10},
		blocks: func(_ uint64, _ int) (BlocksResponse, error) {
			return BlocksResponse{Head: 10, Blocks: nil}, nil
		},
	}

	replica := newChain(t)
	follower := newTestFollower(t, replica, stalled, 0)

	done := make(chan error, 1)
	go func() { done <- follower.CatchUp(context.Background()) }()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("CatchUp reported success against a primary that served nothing")
		}
		if !strings.Contains(err.Error(), "served no blocks") {
			t.Errorf("error = %v, want it to name the stalled primary", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("CatchUp did not terminate against a stalled primary")
	}
}

// TestAGapInAPushTriggersCatchUp: the replica repairs itself. The push
// still returns the gap — the pusher deserves an honest answer — but by the
// time the run loop has turned around, the missing blocks are there.
func TestAGapInAPushTriggersCatchUp(t *testing.T) {
	primary := newChain(t)
	blocks := mineBlocks(t, primary, 3)

	replica := newChain(t)
	follower := newTestFollower(t, replica, newPrimaryEndpoint(t, primary, 0), 0)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go follower.Run(ctx)

	// Skip blocks 1 and 2 entirely: push only the third.
	err := follower.ApplyBlock(blocks[2])
	var outOfOrder *chain.OutOfOrderError
	if !errors.As(err, &outOfOrder) {
		t.Fatalf("ApplyBlock error = %v, want an *OutOfOrderError", err)
	}

	waitFor(t, 5*time.Second, "the replica to heal the gap itself", func() bool {
		n, _, err := replica.HeadInfo()
		return err == nil && n == 3
	})

	_, replicaHash, err := replica.HeadInfo()
	if err != nil {
		t.Fatalf("replica HeadInfo: %v", err)
	}
	if replicaHash != blocks[2].Hash() {
		t.Errorf("replica head = %s, want %s", replicaHash, blocks[2].Hash())
	}
}

// TestPollingCatchesMissedPushes covers M10 deliverable 3's fallback: no
// push is ever delivered here, and the replica still converges.
func TestPollingCatchesMissedPushes(t *testing.T) {
	primary := newChain(t)
	replica := newChain(t)

	follower, err := NewFollower(FollowerConfig{
		Chain:        replica,
		Applier:      replica,
		Primary:      newPrimaryEndpoint(t, primary, 0),
		PollInterval: 10 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("NewFollower: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go follower.Run(ctx)

	mineBlocks(t, primary, 4)
	waitFor(t, 5*time.Second, "the replica to converge by polling alone", func() bool {
		return chainHeight(t, replica) == 4
	})

	if status := follower.Status(); !status.Synced {
		t.Errorf("status = %+v, want synced", status)
	}
}

func TestFollowerRunStopsWhenItsContextIsCancelled(t *testing.T) {
	primary := newChain(t)
	replica := newChain(t)

	follower, err := NewFollower(FollowerConfig{
		Chain:        replica,
		Applier:      replica,
		Primary:      newPrimaryEndpoint(t, primary, 0),
		PollInterval: 10 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("NewFollower: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() {
		follower.Run(ctx)
		close(stopped)
	}()

	cancel()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after its context was cancelled")
	}
}

// TestStatusDistinguishesUncontactedFromLevel: on a fresh cluster both
// heights are 0, so "synced" would otherwise be true before the replica has
// ever reached the primary — the one moment an operator most needs to be
// told otherwise.
func TestStatusDistinguishesUncontactedFromLevel(t *testing.T) {
	primary := newChain(t)
	replica := newChain(t)
	follower := newTestFollower(t, replica, newPrimaryEndpoint(t, primary, 0), 0)

	if status := follower.Status(); status.Synced {
		t.Errorf("status = %+v, want synced=false before the primary has been reached", status)
	}

	if err := follower.CatchUp(context.Background()); err != nil {
		t.Fatalf("CatchUp: %v", err)
	}
	if status := follower.Status(); !status.Synced {
		t.Errorf("status = %+v, want synced=true once the primary has answered", status)
	}
}
