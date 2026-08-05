package chain

import (
	"errors"
	"fmt"
	"slices"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/rawdb"
	"github.com/ethereum/go-ethereum/core/types"
	gethrpc "github.com/ethereum/go-ethereum/rpc"
)

// This file implements the chain-side half of eth_getLogs (M06). It is a
// pure read of what M03 persisted — no lock, no head mutation — following
// read.go/txlookup.go's established pattern.
//
// The scan is deliberately the simple one M06's spec asks for: walk the
// resolved block range, skip any block whose *header* bloom cannot contain
// a match, and only then pay for reading and deriving that block's
// receipts. go-ethereum's own filter system (eth/filters) is not reused
// because it is built around a bloom-bit *index* maintained by a background
// indexer over a full BlockChain object — machinery this node does not have
// and does not need at an election's scale (a few thousand blocks, each
// holding at most one transaction).
//
// Precision note on the bloom pre-filter: a bloom match is necessary but not
// sufficient (false positives are possible by construction), so every block
// the bloom admits is still matched exactly by matchLog below. The bloom is
// therefore only ever an optimisation — deleting bloomMatches entirely would
// change the runtime, never the result. That property is asserted directly
// by TestFilterLogsBloomSkipIsOnlyAnOptimisation in logs_test.go.

// ErrFilterConflict is returned when a filter sets blockHash together with
// fromBlock or toBlock. The JSON-RPC spec makes those mutually exclusive:
// blockHash pins the query to exactly one block.
var ErrFilterConflict = errors.New("cannot specify both blockHash and fromBlock/toBlock")

// LogRangeError reports a filter whose resolved block span exceeds the
// caller-supplied cap. It carries the numbers so internal/rpc can build a
// message naming both the request and the limit, which is what makes this
// error actionable to whoever wrote the query.
type LogRangeError struct {
	From  uint64
	To    uint64
	Limit uint64
}

func (e *LogRangeError) Error() string {
	return fmt.Sprintf("log query spans %d blocks (from %d to %d) but the limit is %d",
		e.To-e.From+1, e.From, e.To, e.Limit)
}

// LogFilter is an eth_getLogs filter object with its block bounds still
// expressed as tags-or-numbers. Resolution against the current head happens
// inside FilterLogs, which is the only thing that knows the head.
//
// FromBlock/ToBlock are pointers so that "absent" is distinguishable from
// an explicit tag; both default to latest, matching the JSON-RPC spec and
// go-ethereum. Topics uses a nil (or empty) inner slice as the wildcard
// that JSON `null` decodes to.
type LogFilter struct {
	FromBlock *gethrpc.BlockNumber
	ToBlock   *gethrpc.BlockNumber

	// BlockHash, when set, pins the query to that single block and makes
	// FromBlock/ToBlock illegal (ErrFilterConflict).
	BlockHash *common.Hash

	// Addresses is an OR-list; empty matches any address.
	Addresses []common.Address

	// Topics is positional: Topics[i] constrains the log's i'th topic, and
	// an empty Topics[i] is a wildcard for that position. A log with fewer
	// topics than len(Topics) never matches.
	Topics [][]common.Hash
}

// FilterLogs returns every log matching f, in ascending (block number, log
// index) order — the order eth_getLogs is required to return, and the one
// the audit page's event replay assumes.
//
// rangeLimit caps how many blocks a single query may span. It is passed in
// rather than stored on the Sequencer on purpose: it is an RPC-surface DoS
// guard (config.LogRangeLimit) with no effect whatsoever on execution,
// sealing or state, so making it a Sequencer field would put an HTTP-layer
// policy inside the consensus-relevant object. A rangeLimit of 0 disables
// the cap entirely, which is what this package's own tests use.
//
// The returned slice is always non-nil, so internal/rpc can marshal it
// straight to `[]` rather than JSON `null` (M06 deliverable 3 — viem
// iterates the result unconditionally).
func (s *Sequencer) FilterLogs(f LogFilter, rangeLimit uint64) ([]*types.Log, error) {
	if f.BlockHash != nil {
		if f.FromBlock != nil || f.ToBlock != nil {
			return nil, ErrFilterConflict
		}
		block, err := s.BlockByHash(*f.BlockHash)
		if err != nil {
			return nil, err
		}
		out := make([]*types.Log, 0)
		return s.appendBlockLogs(out, block, f)
	}

	from, to, err := s.resolveLogRange(f)
	if err != nil {
		return nil, err
	}

	// from > to is not an error: it is the empty range. This happens
	// naturally for a well-formed query whose fromBlock is simply ahead of
	// the head (e.g. a poller asking for "anything after the last block I
	// saw" before a new one has been sealed), so erroring would turn a
	// normal polling step into a client-visible failure.
	if from > to {
		return make([]*types.Log, 0), nil
	}

	if rangeLimit > 0 && to-from+1 > rangeLimit {
		return nil, &LogRangeError{From: from, To: to, Limit: rangeLimit}
	}

	out := make([]*types.Log, 0)
	for n := from; n <= to; n++ {
		header, err := s.HeaderByNumber(n)
		if err != nil {
			return nil, err
		}
		if !bloomMatches(header.Bloom, f.Addresses, f.Topics) {
			continue
		}
		block, err := s.blockByHeader(header)
		if err != nil {
			return nil, err
		}
		out, err = s.appendBlockLogs(out, block, f)
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

// resolveLogRange turns f's from/to tags into concrete, inclusive block
// numbers.
//
// The upper bound is *clamped* to the current head rather than rejected
// when it exceeds it. Clients routinely pass a deliberately huge toBlock to
// mean "as far as you have" (and viem sends an explicit number whenever the
// caller gave one), so clamping is both what makes those queries work and
// what makes the range cap meaningful — after clamping, a span can never
// exceed the chain's own height, so the cap can only ever be hit by a
// genuinely enormous chain, never by a client typo.
func (s *Sequencer) resolveLogRange(f LogFilter) (uint64, uint64, error) {
	head, err := s.currentHeader()
	if err != nil {
		return 0, 0, err
	}
	headNumber := head.Number.Uint64()

	resolve := func(bn *gethrpc.BlockNumber) (uint64, error) {
		if bn == nil {
			return headNumber, nil
		}
		switch *bn {
		case gethrpc.LatestBlockNumber, gethrpc.PendingBlockNumber,
			gethrpc.SafeBlockNumber, gethrpc.FinalizedBlockNumber:
			// Same mapping as headerForBlockNumber: no mempool and no
			// safe/finalized distinction on this chain (MASTER §10 pitfall 4).
			return headNumber, nil
		case gethrpc.EarliestBlockNumber:
			return 0, nil
		default:
			if *bn < 0 {
				return 0, fmt.Errorf("unsupported block tag %d", *bn)
			}
			return uint64(*bn), nil
		}
	}

	from, err := resolve(f.FromBlock)
	if err != nil {
		return 0, 0, err
	}
	to, err := resolve(f.ToBlock)
	if err != nil {
		return 0, 0, err
	}
	if to > headNumber {
		to = headNumber
	}
	return from, to, nil
}

// appendBlockLogs appends every log in block matching f to out. Receipts are
// read raw and completed by deriveReceiptFields for exactly the reasons
// txlookup.go's header comment gives — and it is that derivation, not the
// stored receipt, that supplies the blockHash/blockNumber/txHash/txIndex/
// logIndex annotations M06 deliverable 3 requires on every returned log.
func (s *Sequencer) appendBlockLogs(out []*types.Log, block *types.Block, f LogFilter) ([]*types.Log, error) {
	receipts := rawdb.ReadRawReceipts(s.db, block.Hash(), block.NumberU64())
	if len(receipts) == 0 {
		// A block with no transactions (genesis, or an evm_mine block)
		// legitimately has no receipts stored. deriveReceiptFields would
		// accept this case too, but returning early keeps the "receipts
		// missing for a block that has transactions" error below meaningful.
		if len(block.Transactions()) == 0 {
			return out, nil
		}
		return nil, fmt.Errorf("block %d (%s) has %d transactions but no stored receipts",
			block.NumberU64(), block.Hash(), len(block.Transactions()))
	}

	if err := s.deriveReceiptFields(receipts, block); err != nil {
		return nil, err
	}

	for _, receipt := range receipts {
		for _, l := range receipt.Logs {
			if matchLog(l, f.Addresses, f.Topics) {
				out = append(out, l)
			}
		}
	}
	return out, nil
}

// bloomMatches reports whether a block whose header bloom is bloom *could*
// contain a log matching the address and topic constraints. False means
// definitely not (skip the block); true means maybe (read it and match
// exactly). This mirrors go-ethereum's own eth/filters bloomFilter.
func bloomMatches(bloom types.Bloom, addresses []common.Address, topics [][]common.Hash) bool {
	if len(addresses) > 0 {
		if !slices.ContainsFunc(addresses, func(a common.Address) bool {
			return types.BloomLookup(bloom, a)
		}) {
			return false
		}
	}
	for _, sub := range topics {
		if len(sub) == 0 {
			continue // wildcard position: constrains nothing
		}
		if !slices.ContainsFunc(sub, func(t common.Hash) bool {
			return types.BloomLookup(bloom, t)
		}) {
			return false
		}
	}
	return true
}

// matchLog is the exact (non-probabilistic) filter test: address must be in
// the address OR-list when one is given, and each positional topic
// constraint must be satisfied by the log's topic at that index.
func matchLog(l *types.Log, addresses []common.Address, topics [][]common.Hash) bool {
	if len(addresses) > 0 && !slices.Contains(addresses, l.Address) {
		return false
	}
	// A filter constraining more topic positions than the log actually has
	// can never match — including the common "filter on topic1 of an event
	// that has no indexed arguments" mistake.
	//
	// Note this guard runs *before* the wildcard skip below, so a surplus
	// position rejects even when it is a wildcard. That is go-ethereum's
	// eth/filters ordering and therefore Hardhat's, which is why it is
	// written this way rather than the arguably-tidier "skip wildcards, then
	// bounds-check" alternative — the two differ on exactly one input, and
	// e2e/diff/logs.mjs check (n) measures that input against a live hardhat
	// node rather than trusting this comment. See the long note on
	// logs_test.go's "over-padding past the log's topic count" case.
	if len(topics) > len(l.Topics) {
		return false
	}
	for i, sub := range topics {
		if len(sub) == 0 {
			continue
		}
		if !slices.Contains(sub, l.Topics[i]) {
			return false
		}
	}
	return true
}
