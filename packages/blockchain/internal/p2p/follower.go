package p2p

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ethereum/go-ethereum/core/types"
	"github.com/rs/zerolog/log"

	"zk-blockchain/internal/chain"
)

// DefaultPollInterval is how often a replica asks the primary for its head
// as a fallback for a missed push (M10 deliverable 3). Pushes are the normal
// path and arrive in milliseconds; this exists so that a replica which was
// down, or whose push was dropped by a full queue, converges on its own
// within seconds rather than waiting for the next block.
const DefaultPollInterval = 5 * time.Second

// ExternalBlockApplier is the verifying apply path a replica runs every
// received block through — internal/chain.Sequencer.ApplyExternalBlock.
type ExternalBlockApplier interface {
	ApplyExternalBlock(block *types.Block) error
}

// PrimaryClient is the subset of *Client a follower uses. Narrowing it to
// two methods is what lets the tests drive catch-up against a scripted
// primary (one that stalls, or serves a short page, or is briefly
// unreachable) without running a second node.
type PrimaryClient interface {
	Head(ctx context.Context) (HeadResponse, error)
	Blocks(ctx context.Context, from uint64, limit int) (BlocksResponse, error)
}

// FollowerConfig configures NewFollower.
type FollowerConfig struct {
	// Chain reads the local head. Required.
	Chain BlockStore
	// Applier verifies and applies each received block. Required.
	Applier ExternalBlockApplier
	// Primary is where catch-up pulls go. Required.
	Primary PrimaryClient
	// PollInterval is the missed-push fallback period; zero means
	// DefaultPollInterval.
	PollInterval time.Duration
	// PullLimit is how many blocks one catch-up request asks for; zero means
	// DefaultPullLimit.
	PullLimit int
}

// FollowerStatus is what /health reports on a replica (M10 deliverable 3).
type FollowerStatus struct {
	Height        uint64 `json:"height"`
	PrimaryHeight uint64 `json:"primaryHeight"`
	Synced        bool   `json:"synced"`
}

// Follower is a replica's block intake: it accepts pushes, pulls whatever it
// is missing, and keeps a view of how far behind the primary it is.
//
// Every block — pushed or pulled — goes through the same verifying applier,
// so the source a block arrived by has no bearing on how much it is trusted.
// The only difference between the two paths is who noticed the block first.
type Follower struct {
	chain        BlockStore
	applier      ExternalBlockApplier
	primary      PrimaryClient
	pollInterval time.Duration
	pullLimit    int

	// apply serialises the push path against the pull path. Without it a
	// push arriving mid-catch-up would race the pull for the same height:
	// one of them loses, and while losing is harmless (the loser sees
	// ErrBlockAlreadyApplied or a gap), the two would be interleaving writes
	// to the same head in the meantime.
	apply sync.Mutex

	// kick asks the run loop to catch up now rather than at the next tick.
	// Buffered with capacity 1: several kicks between two catch-ups are the
	// same request.
	kick chan struct{}

	primaryHeight atomic.Uint64
	contacted     atomic.Bool
}

// NewFollower validates cfg and builds a Follower.
func NewFollower(cfg FollowerConfig) (*Follower, error) {
	switch {
	case cfg.Chain == nil:
		return nil, errors.New("p2p: follower needs a BlockStore")
	case cfg.Applier == nil:
		return nil, errors.New("p2p: follower needs an ExternalBlockApplier")
	case cfg.Primary == nil:
		return nil, errors.New("p2p: follower needs a primary client")
	}

	poll := cfg.PollInterval
	if poll <= 0 {
		poll = DefaultPollInterval
	}
	limit := cfg.PullLimit
	if limit <= 0 {
		limit = DefaultPullLimit
	}

	return &Follower{
		chain:        cfg.Chain,
		applier:      cfg.Applier,
		primary:      cfg.Primary,
		pollInterval: poll,
		pullLimit:    limit,
		kick:         make(chan struct{}, 1),
	}, nil
}

// ApplyBlock is the push path (BlockApplier, called by the HTTP handler).
//
// A gap is returned to the caller unchanged — the pusher deserves an honest
// 409 telling it this node is behind — but it also schedules a catch-up, so
// the replica repairs itself without the primary having to do anything
// about it.
func (f *Follower) ApplyBlock(block *types.Block) error {
	f.apply.Lock()
	err := f.applier.ApplyExternalBlock(block)
	f.apply.Unlock()

	var outOfOrder *chain.OutOfOrderError
	if errors.As(err, &outOfOrder) {
		f.RequestCatchUp()
	}
	if err == nil {
		// A block that arrived by push is proof of contact with the primary
		// just as a successful pull is, so a replica kept current entirely by
		// pushes still reports itself synced.
		f.contacted.Store(true)
		f.noteLocalProgress(block.NumberU64())
	}
	return err
}

// RequestCatchUp asks the run loop to pull now. Non-blocking, and
// deduplicating: if a catch-up is already queued this is a no-op.
func (f *Follower) RequestCatchUp() {
	select {
	case f.kick <- struct{}{}:
	default:
	}
}

// CatchUp pulls and applies every block this node is missing, page by page,
// until it is level with the primary.
//
// It returns an error rather than retrying internally: the run loop is the
// only caller that knows whether trying again is appropriate, and a
// verification failure (which is not a transient condition) must be visible
// there rather than absorbed here.
func (f *Follower) CatchUp(ctx context.Context) error {
	f.apply.Lock()
	defer f.apply.Unlock()

	for {
		if err := ctx.Err(); err != nil {
			return err
		}

		local, _, err := f.chain.HeadInfo()
		if err != nil {
			return fmt.Errorf("reading the local head: %w", err)
		}

		resp, err := f.primary.Blocks(ctx, local+1, f.pullLimit)
		if err != nil {
			return fmt.Errorf("pulling blocks from %d: %w", local+1, err)
		}
		f.primaryHeight.Store(resp.Head)
		f.contacted.Store(true)

		if len(resp.Blocks) == 0 {
			// Nothing to do. Either this node is level with the primary, or
			// the primary served an empty page while claiming a higher head —
			// which would be a bug on its side, and is reported rather than
			// looped on.
			if local < resp.Head {
				return fmt.Errorf("primary reports head %d but served no blocks from %d", resp.Head, local+1)
			}
			return nil
		}

		for _, msg := range resp.Blocks {
			block, err := msg.Decode()
			if err != nil {
				return err
			}
			if err := f.applier.ApplyExternalBlock(block); err != nil {
				if errors.Is(err, chain.ErrBlockAlreadyApplied) {
					// A push landed the same block while this page was in
					// flight. Harmless; keep going.
					continue
				}
				return fmt.Errorf("applying pulled block %d: %w", block.NumberU64(), err)
			}
		}

		// Progress check. Without it, a primary that keeps serving blocks
		// this node cannot use (all duplicates, say) would spin this loop
		// forever, holding the apply lock and burning a core.
		after, _, err := f.chain.HeadInfo()
		if err != nil {
			return fmt.Errorf("reading the local head after applying a page: %w", err)
		}
		if after <= local {
			return fmt.Errorf("catch-up made no progress: still at block %d after applying %d block(s)", after, len(resp.Blocks))
		}
		f.noteLocalProgress(after)
	}
}

// Run performs the boot catch-up (M10 deliverable 3: "compare local head to
// primary head → pull gap → then serve") and then keeps the replica current,
// waking on either a kick from the push path or the poll tick.
//
// It logs pull failures and carries on rather than exiting. A replica whose
// primary is briefly unreachable is still useful — it serves reads from the
// state it has — and the next tick retries. Only a cancelled context stops
// the loop.
func (f *Follower) Run(ctx context.Context) {
	f.catchUpLogged(ctx, "boot")

	ticker := time.NewTicker(f.pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("replica follower stopped")
			return
		case <-f.kick:
			f.catchUpLogged(ctx, "push-gap")
		case <-ticker.C:
			f.catchUpLogged(ctx, "poll")
		}
	}
}

func (f *Follower) catchUpLogged(ctx context.Context, reason string) {
	before, _, _ := f.chain.HeadInfo()

	if err := f.CatchUp(ctx); err != nil {
		if ctx.Err() != nil {
			return
		}
		log.Warn().Err(err).Str("reason", reason).Msg("catch-up failed; will retry")
		return
	}

	after, _, _ := f.chain.HeadInfo()
	if after != before {
		log.Info().
			Str("reason", reason).
			Uint64("from", before).
			Uint64("to", after).
			Msg("replica caught up")
	}
}

// Status reports what /health publishes on a replica.
//
// synced is false until the primary has been reached at least once, even
// when both are at the same height. "I have not spoken to the primary" and
// "I am level with the primary" are different states, and on a fresh cluster
// where both are at block 0 they are otherwise indistinguishable — which is
// exactly when an operator most wants to know which one they are looking at.
func (f *Follower) Status() FollowerStatus {
	height, _, err := f.chain.HeadInfo()
	if err != nil {
		height = 0
	}
	primaryHeight := f.primaryHeight.Load()
	return FollowerStatus{
		Height:        height,
		PrimaryHeight: primaryHeight,
		Synced:        f.contacted.Load() && height >= primaryHeight,
	}
}

// noteLocalProgress keeps the cached primary height from lagging behind
// reality when blocks arrive by push: a pushed block proves the primary is
// at least that high, and without this the status would read "behind" until
// the next poll even though the replica is level.
func (f *Follower) noteLocalProgress(height uint64) {
	for {
		current := f.primaryHeight.Load()
		if height <= current {
			return
		}
		if f.primaryHeight.CompareAndSwap(current, height) {
			return
		}
	}
}
