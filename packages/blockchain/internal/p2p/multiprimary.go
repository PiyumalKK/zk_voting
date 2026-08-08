package p2p

import (
	"context"
	"errors"
	"fmt"

	"github.com/ethereum/go-ethereum/common"

	"zk-blockchain/internal/consensus"
)

// MultiPrimary presents several peers as one PrimaryClient.
//
// M10's Follower was written against a single sequencer: there was exactly one
// node allowed to extend the chain, so "pull from the primary" was
// unambiguous. Under consensus there is no single source — every validator
// holds the same finalized chain, and any of them will do.
//
// Generalising the *source* is a much smaller change than writing a second
// syncer, and it keeps the property that matters: whatever a peer sends is
// still applied through Sequencer.ApplyExternalBlock, which re-executes it
// with replay.go and refuses anything whose state root does not follow from
// its contents. A validator catching up therefore verifies every block it
// missed itself. It is not trusting the peer it happened to ask; it is using
// that peer as a source of bytes and checking them.
type MultiPrimary struct {
	peers []*Client
}

// NewMultiPrimary builds the aggregate source.
func NewMultiPrimary(peers []*Client) (*MultiPrimary, error) {
	if len(peers) == 0 {
		return nil, errors.New("p2p: MultiPrimary needs at least one peer")
	}
	return &MultiPrimary{peers: peers}, nil
}

// Head returns the highest head any reachable peer reports.
//
// Highest rather than first: with one validator allowed to be down and others
// possibly a block behind at any instant, asking a single peer would make
// this node's idea of "how far behind am I" depend on which peer it happened
// to ask. Taking the maximum makes it depend on the cluster.
func (m *MultiPrimary) Head(ctx context.Context) (HeadResponse, error) {
	var (
		best     HeadResponse
		found    bool
		lastErr  error
		anyReply bool
	)
	for _, peer := range m.peers {
		head, err := peer.Head(ctx)
		if err != nil {
			lastErr = err
			continue
		}
		anyReply = true
		if !found || head.Number > best.Number {
			best, found = head, true
		}
	}
	if !anyReply {
		return HeadResponse{}, fmt.Errorf("no validator answered a head query: %w", lastErr)
	}
	return best, nil
}

// Blocks pulls a page from whichever peer can serve it, trying each in turn.
//
// A peer that is itself behind returns fewer blocks (or none) rather than an
// error, so an empty page is not treated as failure — the caller's loop
// re-reads the head and tries again. Only a peer that cannot be reached at all
// moves on to the next.
func (m *MultiPrimary) Blocks(ctx context.Context, from uint64, limit int) (BlocksResponse, error) {
	var (
		best    BlocksResponse
		found   bool
		lastErr error
	)
	for _, peer := range m.peers {
		resp, err := peer.Blocks(ctx, from, limit)
		if err != nil {
			lastErr = err
			continue
		}
		if len(resp.Blocks) > 0 {
			return resp, nil
		}
		if !found || resp.Head > best.Head {
			best, found = resp, true
		}
	}
	if !found {
		return BlocksResponse{}, fmt.Errorf("no validator served blocks from %d: %w", from, lastErr)
	}
	return best, nil
}

// CommitSeals pulls certificates for [from, to] from whichever peer has them.
//
// A peer with no certificates for the range is not an error and not worth
// trying to distinguish from a peer that simply has none: a block's validity
// is established by re-execution, never by its seals, so a node that syncs
// from a peer with a truncated seal store must still be able to run. It will
// hold blocks it verified itself with no record of who agreed to them, and
// zk_getCommitSeals reports null for those — which is honest.
func (m *MultiPrimary) CommitSeals(ctx context.Context, from, to uint64) (SealsResponse, error) {
	var lastErr error
	for _, peer := range m.peers {
		resp, err := peer.CommitSeals(ctx, from, to)
		if err != nil {
			lastErr = err
			continue
		}
		if len(resp.Seals) > 0 {
			return resp, nil
		}
	}
	if lastErr != nil {
		return SealsResponse{}, lastErr
	}
	return SealsResponse{}, nil
}

// SealSink stores certificates fetched during catch-up. *consensus.Store
// satisfies it.
type SealSink interface {
	Put(height uint64, hash common.Hash, seals *consensus.CommitSeals) error
}
