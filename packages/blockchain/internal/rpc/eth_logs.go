package rpc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/ethereum/go-ethereum/common"
	gethrpc "github.com/ethereum/go-ethereum/rpc"

	"zk-blockchain/internal/chain"
)

// This file implements eth_getLogs (M06) — the method behind the audit
// page's event replay, /api/verify-vote, /api/merkle-path's NewLeaf history
// and the block explorer (MASTER §9).
//
// The filter object's JSON decoding is hand-rolled below rather than taken
// from go-ethereum's eth/filters.FilterCriteria (which has exactly this
// UnmarshalJSON). Importing eth/filters would drag the whole eth package —
// backend interfaces, the bloom-bit indexer, an event system — into a node
// that has none of those, and would break the package-boundary rule
// internal/state/chainconfig.go states: internal/rpc depends on
// internal/chain plus go-ethereum's common/types/rpc leaf packages, nothing
// heavier. The decoding rules reproduced here are the spec's, and
// e2e/diff/logs.mjs proves them against a real Hardhat node.

// EthLogsService implements eth_getLogs. It is a third receiver under the
// same "eth" namespace, for the same reason EthWriteService is a second one
// (see server.go): it needs a dependency the others don't — the configured
// range cap.
type EthLogsService struct {
	seq *chain.Sequencer
	// logRangeLimit is config.LogRangeLimit: the maximum number of blocks
	// one query may span. 0 disables the cap.
	logRangeLimit uint64
}

// NewEthLogsService builds the eth_getLogs method set over seq, capping any
// single query at logRangeLimit blocks.
func NewEthLogsService(seq *chain.Sequencer, logRangeLimit uint64) *EthLogsService {
	return &EthLogsService{seq: seq, logRangeLimit: logRangeLimit}
}

// LogFilterArgs is eth_getLogs' single parameter: the standard filter
// object. Its fields are deliberately not decodable by encoding/json's
// default rules — `address` is a string *or* an array of strings, and each
// `topics` element is null, a string, *or* an array of strings — so it
// carries its own UnmarshalJSON below.
type LogFilterArgs struct {
	FromBlock *gethrpc.BlockNumber
	ToBlock   *gethrpc.BlockNumber
	BlockHash *common.Hash
	Addresses []common.Address
	Topics    [][]common.Hash
}

// rawLogFilter is LogFilterArgs' wire form: the polymorphic fields are held
// as raw JSON and interpreted by UnmarshalJSON.
type rawLogFilter struct {
	FromBlock *gethrpc.BlockNumber `json:"fromBlock"`
	ToBlock   *gethrpc.BlockNumber `json:"toBlock"`
	BlockHash *common.Hash         `json:"blockHash"`
	Address   json.RawMessage      `json:"address"`
	Topics    []json.RawMessage    `json:"topics"`
}

// UnmarshalJSON decodes a JSON-RPC filter object.
//
// Accepted shapes, all of which viem produces somewhere in this app:
//
//	address: omitted | null | "0x…" | ["0x…", "0x…"]
//	topics:  omitted | null | [ null | "0x…" | ["0x…", …] , … ]
//
// A null topic position is a wildcard. A null *inside* an inner array makes
// that whole position a wildcard too — matching go-ethereum's behavior,
// since "match this OR match anything" is just "match anything".
func (a *LogFilterArgs) UnmarshalJSON(data []byte) error {
	// `null` for the whole filter is the empty filter (everything at the
	// head block), not an error.
	if string(data) == "null" {
		*a = LogFilterArgs{}
		return nil
	}

	var raw rawLogFilter
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}

	a.FromBlock = raw.FromBlock
	a.ToBlock = raw.ToBlock
	a.BlockHash = raw.BlockHash
	a.Addresses = nil
	a.Topics = nil

	if !isJSONNull(raw.Address) {
		addrs, err := decodeAddressField(raw.Address)
		if err != nil {
			return err
		}
		// Normalized to nil when empty. An empty address list and an absent
		// one both mean "unconstrained", and collapsing them here gives the
		// type a single representation for that state — otherwise callers
		// (and tests) would have to care whether encoding/json produced a nil
		// or an empty-but-non-nil slice for `"address": []`, a distinction
		// that carries no meaning.
		if len(addrs) > 0 {
			a.Addresses = addrs
		}
	}

	if len(raw.Topics) > 0 {
		// Same normalization: `"topics": []` (which the block explorer's
		// address-only query actually sends — verified against viem's wire
		// output) constrains nothing, so it stays nil rather than becoming an
		// empty outer slice.
		topics := make([][]common.Hash, len(raw.Topics))
		for i, rawTopic := range raw.Topics {
			sub, err := decodeTopicPosition(rawTopic)
			if err != nil {
				return fmt.Errorf("topics[%d]: %w", i, err)
			}
			topics[i] = sub
		}
		a.Topics = topics
	}
	return nil
}

// isJSONNull reports whether raw is absent or the JSON literal null. Both
// mean "field not supplied" for every field of a filter object.
func isJSONNull(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) == 0 || string(trimmed) == "null"
}

// decodeAddressField accepts either a single address or an array of them.
// The shape is chosen by looking at the first token rather than by trying
// one decode and falling back to the other on error: the fallback approach
// reports the *array* decoder's complaint for a malformed single address,
// which sends whoever reads the error looking in the wrong place.
func decodeAddressField(raw json.RawMessage) ([]common.Address, error) {
	trimmed := bytes.TrimSpace(raw)

	if len(trimmed) > 0 && trimmed[0] == '[' {
		var many []common.Address
		if err := json.Unmarshal(trimmed, &many); err != nil {
			return nil, fmt.Errorf("address array must hold 20-byte addresses: %w", err)
		}
		return many, nil
	}

	var single common.Address
	if err := json.Unmarshal(trimmed, &single); err != nil {
		return nil, fmt.Errorf("address must be a 20-byte address or an array of them: %w", err)
	}
	return []common.Address{single}, nil
}

// decodeTopicPosition decodes one element of the topics array. A nil return
// (with a nil error) means "wildcard at this position", which is what
// internal/chain's matcher treats an empty inner slice as.
func decodeTopicPosition(raw json.RawMessage) ([]common.Hash, error) {
	if isJSONNull(raw) {
		return nil, nil
	}
	trimmed := bytes.TrimSpace(raw)

	if trimmed[0] != '[' {
		var single common.Hash
		if err := json.Unmarshal(trimmed, &single); err != nil {
			return nil, fmt.Errorf("must be null, a 32-byte topic, or an array of topics: %w", err)
		}
		return []common.Hash{single}, nil
	}

	// An inner array: an OR-list. Decoded element-by-element as raw JSON
	// rather than straight into []common.Hash so that a null *inside* the
	// list is detectable — common.Hash would turn it into the zero hash,
	// which matches nothing instead of everything.
	var items []json.RawMessage
	if err := json.Unmarshal(trimmed, &items); err != nil {
		return nil, fmt.Errorf("topic array is malformed: %w", err)
	}

	out := make([]common.Hash, 0, len(items))
	for _, item := range items {
		if string(bytes.TrimSpace(item)) == "null" {
			// "this OR anything" collapses to "anything".
			return nil, nil
		}
		var h common.Hash
		if err := json.Unmarshal(item, &h); err != nil {
			return nil, fmt.Errorf("array element must be a 32-byte topic: %w", err)
		}
		out = append(out, h)
	}
	// An explicitly empty array is also a wildcard (nothing to constrain).
	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

// toFilter projects the decoded args onto internal/chain's filter type.
func (a LogFilterArgs) toFilter() chain.LogFilter {
	return chain.LogFilter{
		FromBlock: a.FromBlock,
		ToBlock:   a.ToBlock,
		BlockHash: a.BlockHash,
		Addresses: a.Addresses,
		Topics:    a.Topics,
	}
}

// GetLogs implements eth_getLogs.
//
// The result is always a non-nil slice so an empty match marshals as `[]`,
// never `null` (M06 deliverable 3): viem's getLogs maps over the result
// unconditionally, and `null` would fail far from the cause.
func (e *EthLogsService) GetLogs(ctx context.Context, args LogFilterArgs) ([]*RPCLog, error) {
	logs, err := e.seq.FilterLogs(args.toFilter(), e.logRangeLimit)
	if err != nil {
		return nil, mapFilterError(err)
	}

	out := make([]*RPCLog, 0, len(logs))
	for _, l := range logs {
		out = append(out, newRPCLog(l))
	}
	return out, nil
}

// mapFilterError translates internal/chain's filter errors into the
// JSON-RPC shapes a client expects.
//
// A blockHash naming a block this chain doesn't have is reported as an
// error, not as an empty result: unlike eth_getBlockByHash (where "no such
// block" is a legitimate null answer), a filter pinned to a nonexistent
// block is a caller mistake, and go-ethereum reports it the same way.
func mapFilterError(err error) error {
	if errors.Is(err, chain.ErrFilterConflict) {
		// go-ethereum's own wording for this, which Hardhat mirrors;
		// e2e/diff/logs.mjs compares the two.
		return newCodedError(invalidParamsCode,
			"cannot specify both BlockHash and FromBlock/ToBlock, choose one or the other")
	}

	var rangeErr *chain.LogRangeError
	if errors.As(err, &rangeErr) {
		return newCodedError(invalidInputCode,
			"query returned more than %d blocks (requested %d, from block %d to %d); narrow the block range or raise LOG_RANGE_LIMIT",
			rangeErr.Limit, rangeErr.To-rangeErr.From+1, rangeErr.From, rangeErr.To)
	}

	if errors.Is(err, chain.ErrBlockNotFound) {
		return newCodedError(invalidInputCode, "%v", err)
	}
	return err
}
