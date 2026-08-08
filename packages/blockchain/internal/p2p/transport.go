package p2p

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/rs/zerolog/log"

	"zk-blockchain/internal/consensus"
)

// ConsensusTransport broadcasts BFT messages to the other validators over the
// existing mTLS link.
//
// It is modelled on BlockPusher — one goroutine per peer, a bounded queue, a
// non-blocking enqueue so the state machine is never held up by the network —
// with one deliberate difference: **there are no retries.**
//
// A block push is retried because a block is still worth delivering a second
// later. A consensus message is not. By the time a retry would go out, the
// round it belongs to has usually moved on, and re-sending a stale PREPARE
// only adds load while a peer that missed it has already timed out. The
// recovery mechanism for a lost consensus message is the round change, which
// is designed for exactly this and needs no help. Retrying would also make
// delivery ordering harder to reason about for no benefit, since every
// message is independently signed and independently meaningful.
type ConsensusTransport struct {
	workers []*consensusWorker
	dropped atomic.Uint64
}

// ConsensusTransportConfig configures NewConsensusTransport.
type ConsensusTransportConfig struct {
	// Peers is one client per *other* validator.
	Peers []*Client
	// QueueSize bounds each peer's outbound backlog.
	QueueSize int
	// Timeout bounds one delivery attempt.
	Timeout time.Duration
}

const (
	// defaultConsensusQueue is generous relative to what a round actually
	// needs — four phases times a handful of validators — so an ordinary
	// burst never drops, while a peer that has stopped reading cannot make
	// this node buffer without limit.
	defaultConsensusQueue = 256
	// defaultConsensusTimeout bounds one delivery. Deliberately shorter than
	// the block-push timeout: a consensus message that takes longer than this
	// has almost certainly missed its round anyway.
	defaultConsensusTimeout = 5 * time.Second
)

type consensusWorker struct {
	client  *Client
	queue   chan *consensus.SignedMessage
	timeout time.Duration
	dropped *atomic.Uint64
}

// NewConsensusTransport builds the transport. Run must be called to start the
// per-peer workers.
func NewConsensusTransport(cfg ConsensusTransportConfig) *ConsensusTransport {
	queueSize := cfg.QueueSize
	if queueSize <= 0 {
		queueSize = defaultConsensusQueue
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = defaultConsensusTimeout
	}

	t := &ConsensusTransport{}
	for _, peer := range cfg.Peers {
		t.workers = append(t.workers, &consensusWorker{
			client:  peer,
			queue:   make(chan *consensus.SignedMessage, queueSize),
			timeout: timeout,
			dropped: &t.dropped,
		})
	}
	return t
}

// Run starts one sender per peer and blocks until ctx is cancelled.
func (t *ConsensusTransport) Run(ctx context.Context) {
	done := make(chan struct{}, len(t.workers))
	for _, w := range t.workers {
		go func(w *consensusWorker) {
			w.run(ctx)
			done <- struct{}{}
		}(w)
	}
	for range t.workers {
		<-done
	}
}

// Broadcast implements consensus.Transport. Non-blocking on every peer, so a
// single unreachable validator can never stall the state machine — which is
// the whole point of tolerating one failure.
func (t *ConsensusTransport) Broadcast(msg *consensus.SignedMessage) {
	for _, w := range t.workers {
		select {
		case w.queue <- msg:
		default:
			t.dropped.Add(1)
		}
	}
}

// Dropped counts messages that could not even be queued, for diagnostics. A
// non-zero value on a healthy cluster means a peer has stopped reading.
func (t *ConsensusTransport) Dropped() uint64 { return t.dropped.Load() }

func (w *consensusWorker) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-w.queue:
			w.send(ctx, msg)
		}
	}
}

func (w *consensusWorker) send(ctx context.Context, msg *consensus.SignedMessage) {
	attemptCtx, cancel := context.WithTimeout(ctx, w.timeout)
	defer cancel()

	if err := w.client.SendConsensus(attemptCtx, msg); err != nil {
		// Debug, not warn: with one validator permitted to be down at any
		// time, delivery failures to a peer are an expected steady state, not
		// an incident. What is worth an operator's attention is the chain
		// failing to advance, which the engine logs on its own.
		log.Debug().
			Err(err).
			Str("peer", w.client.BaseURL()).
			Str("type", msg.Type.String()).
			Uint64("height", msg.Height).
			Msg("could not deliver a consensus message; the round change will recover if it mattered")
	}
}
