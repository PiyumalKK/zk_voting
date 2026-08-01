package p2p

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ethereum/go-ethereum/core/types"
	"github.com/rs/zerolog/log"

	"zk-blockchain/internal/chain"
)

// Defaults for the primary's push path (M10 deliverable 4: "fire-and-forget
// with retry queue (in-memory, 3 retries, exponential backoff); a slow
// replica never blocks sealing").
const (
	DefaultPushRetries = 3
	DefaultPushBackoff = 250 * time.Millisecond
	DefaultPushTimeout = 10 * time.Second
	// DefaultPushQueueSize bounds how far behind a replica may fall before
	// its pushes start being dropped. It is deliberately generous relative
	// to the cost — a queued block is a pointer, not a copy — because a
	// dropped push costs the replica a poll interval of staleness.
	DefaultPushQueueSize = 256
)

// BlockPusher is the primary's announcement path: for every block it seals,
// it tells each replica, and it never lets that telling get in the way of
// sealing the next one.
//
// The guarantee is at-least-once *delivery attempt*, not at-least-once
// delivery: a block whose pushes all fail is not resent later. That is
// intentional and safe, because the replica's own catch-up loop
// (follower.go) is the authoritative repair mechanism — it polls the
// primary's head every few seconds and pulls whatever it is missing. Making
// the pusher durable as well would be a second, redundant recovery path
// with its own failure modes; making it best-effort keeps recovery in one
// place. MASTER §3 makes the same argument for why the block feed drops
// events instead of blocking.
type BlockPusher struct {
	workers []*peerWorker
}

// PusherConfig configures NewPusher.
type PusherConfig struct {
	// Peers are the replicas to announce to. An empty list is valid — that
	// is a standalone single-node deployment, and the pusher becomes a
	// no-op.
	Peers []*Client
	// QueueSize, Retries, Backoff and Timeout default to the constants
	// above when zero.
	QueueSize int
	Retries   int
	Backoff   time.Duration
	Timeout   time.Duration
	// sleep is injected by tests so retry backoff does not cost real time.
	// Nil means a context-aware time.Sleep.
	sleep func(ctx context.Context, d time.Duration)
}

// NewPusher builds a pusher for the configured peers.
func NewPusher(cfg PusherConfig) *BlockPusher {
	queueSize := cfg.QueueSize
	if queueSize <= 0 {
		queueSize = DefaultPushQueueSize
	}
	retries := cfg.Retries
	if retries < 0 {
		retries = 0
	} else if retries == 0 {
		retries = DefaultPushRetries
	}
	backoff := cfg.Backoff
	if backoff <= 0 {
		backoff = DefaultPushBackoff
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = DefaultPushTimeout
	}
	sleep := cfg.sleep
	if sleep == nil {
		sleep = sleepContext
	}

	p := &BlockPusher{}
	for _, peer := range cfg.Peers {
		p.workers = append(p.workers, &peerWorker{
			client:  peer,
			queue:   make(chan *types.Block, queueSize),
			retries: retries,
			backoff: backoff,
			timeout: timeout,
			sleep:   sleep,
		})
	}
	return p
}

// Run fans sealed blocks out to every peer and blocks until ctx is cancelled
// or events is closed. Intended to be started on its own goroutine by
// cmd/node.
//
// The only work done on this goroutine is a non-blocking channel send per
// peer, so the sequencer's block feed is drained promptly no matter how slow
// or unreachable a replica is.
func (p *BlockPusher) Run(ctx context.Context, events <-chan chain.NewBlockEvent) {
	var wg sync.WaitGroup
	for _, w := range p.workers {
		wg.Add(1)
		go func(w *peerWorker) {
			defer wg.Done()
			w.run(ctx)
		}(w)
	}
	defer wg.Wait()

	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-events:
			if !ok {
				return
			}
			for _, w := range p.workers {
				w.enqueue(ev.Block)
			}
		}
	}
}

// Dropped reports how many pushes were discarded because a peer's queue was
// full, summed over peers. Exposed for tests and for the operational
// question it answers: a non-zero and growing value means a replica is
// persistently behind and is being kept alive by polling rather than by
// pushes.
func (p *BlockPusher) Dropped() uint64 {
	var total uint64
	for _, w := range p.workers {
		total += w.dropped.Load()
	}
	return total
}

// peerWorker owns one peer's queue and pushes from it sequentially, which
// is what keeps blocks arriving in order on a healthy link.
type peerWorker struct {
	client  *Client
	queue   chan *types.Block
	retries int
	backoff time.Duration
	timeout time.Duration
	sleep   func(ctx context.Context, d time.Duration)

	dropped atomic.Uint64
}

// enqueue never blocks. A full queue means this peer is far enough behind
// that the block would be stale by the time it drained; dropping it and
// letting the replica pull is both cheaper and more likely to converge.
func (w *peerWorker) enqueue(block *types.Block) {
	select {
	case w.queue <- block:
	default:
		count := w.dropped.Add(1)
		log.Warn().
			Str("peer", w.client.BaseURL()).
			Uint64("block", block.NumberU64()).
			Uint64("droppedTotal", count).
			Msg("push queue is full; dropping this announcement (the replica will pull it)")
	}
}

func (w *peerWorker) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case block := <-w.queue:
			w.push(ctx, block)
		}
	}
}

// push delivers one block, retrying only what is worth retrying.
//
// The distinction is the point of RemoteError.Retryable: a 5xx is the peer
// failing at something and may clear, while every considered refusal — a
// state-root mismatch, a fork, a gap — will refuse identically however many
// times it is asked. Retrying those would turn one alarming log line into
// four.
func (w *peerWorker) push(ctx context.Context, block *types.Block) {
	backoff := w.backoff

	for attempt := 0; ; attempt++ {
		if ctx.Err() != nil {
			return
		}

		attemptCtx, cancel := context.WithTimeout(ctx, w.timeout)
		resp, err := w.client.PushBlock(attemptCtx, block)
		cancel()

		if err == nil {
			log.Debug().
				Str("peer", w.client.BaseURL()).
				Uint64("block", block.NumberU64()).
				Str("status", resp.Status).
				Msg("pushed block")
			return
		}

		var remote *RemoteError
		if errors.As(err, &remote) && !remote.Retryable() {
			// Logged at info for a gap (the replica is behind and healing
			// itself) and at error for anything else, since a mismatch or a
			// fork is the replica telling this node its blocks do not
			// verify — the loudest signal in the system.
			event := log.Error()
			if remote.Code == CodeGap {
				event = log.Info()
			}
			event.
				Str("peer", w.client.BaseURL()).
				Uint64("block", block.NumberU64()).
				Str("code", remote.Code).
				Str("reason", remote.Message).
				Msg("peer refused a pushed block")
			return
		}

		if attempt >= w.retries {
			log.Warn().
				Err(err).
				Str("peer", w.client.BaseURL()).
				Uint64("block", block.NumberU64()).
				Int("attempts", attempt+1).
				Msg("giving up on this push; the peer will pull the block when it polls")
			return
		}

		w.sleep(ctx, backoff)
		backoff *= 2
	}
}

// sleepContext waits for d, or returns early if ctx is cancelled — so a
// shutdown is not held up by a retry backoff.
func sleepContext(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}
