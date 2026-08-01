package state

import (
	"errors"
	"fmt"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/rawdb"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethdb"
)

// Height returns the current chain head's block number. Until
// internal/chain (M03) starts sealing blocks, every node reports the
// genesis height (0); from M03 on this reflects the real head. cmd/node
// wires /health's HeightProvider through this function (instead of the
// hardcoded 0 from M01) so it needs no changes when M03 lands.
func Height(db ethdb.Database) uint64 {
	headHash := rawdb.ReadHeadBlockHash(db)
	if headHash == (common.Hash{}) {
		return 0
	}
	number, ok := rawdb.ReadHeaderNumber(db, headHash)
	if !ok {
		return 0
	}
	return number
}

// ErrNoHead means db has no head pointer, or one that does not resolve to a
// stored header. On a chain that has had EnsureGenesis run, this cannot
// happen — genesis is itself a head — so it always indicates an empty or
// damaged data directory.
var ErrNoHead = errors.New("no chain head found")

// HeadHeader returns the header the head pointer resolves to.
//
// This deliberately reads the *header* pointer rather than the block
// pointer. seal.go's persist writes both in one atomic batch, so they never
// disagree today, but the header pointer is the one go-ethereum's own
// recovery paths treat as authoritative, and the sequencer
// (Sequencer.currentHeader) already builds on it — two different notions of
// "the head" in one binary is exactly the sort of divergence M09 exists to
// rule out.
func HeadHeader(db ethdb.Database) (*types.Header, error) {
	headHash := rawdb.ReadHeadHeaderHash(db)
	if headHash == (common.Hash{}) {
		return nil, ErrNoHead
	}
	number, ok := rawdb.ReadHeaderNumber(db, headHash)
	if !ok {
		return nil, fmt.Errorf("%w: head hash %s has no stored block number", ErrNoHead, headHash)
	}
	header := rawdb.ReadHeader(db, headHash, number)
	if header == nil {
		return nil, fmt.Errorf("%w: header %s (block %d) is missing", ErrNoHead, headHash, number)
	}
	return header, nil
}

// VerifyHead is the node's boot-time durability check (M09 deliverable 1):
// resolve the head pointer, then prove the state trie at that head's root
// can actually be opened. It returns the head header so the caller can log
// what it recovered to.
//
// Doing this at startup rather than lazily is the whole point. Without it,
// a data directory whose trie is incomplete — a disk that filled up
// mid-commit, a half-restored backup, a `data/` directory copied while the
// node was running — starts up looking perfectly healthy, accepts
// transactions, and only fails when the first eth_call or eth_getBalance
// tries to read state. By then the operator is debugging an RPC error
// several layers away from the actual cause, and the chain may have sealed
// blocks on top of a root it cannot serve.
//
// The error text names cmd/audit because that tool is what turns "the state
// is broken" into "the state is broken at block N" — see RUNNING-GATES §6.
func VerifyHead(db ethdb.Database) (*types.Header, error) {
	header, err := HeadHeader(db)
	if err != nil {
		return nil, err
	}

	if _, err := At(db, header.Root); err != nil {
		return nil, fmt.Errorf(
			"chain head is block %d (%s) but its state root %s cannot be opened: %w — "+
				"the data directory is incomplete or corrupt; run `make audit` (cmd/audit) to find the first bad block, "+
				"or `make reset` to start from a fresh genesis",
			header.Number.Uint64(), header.Hash(), header.Root, err,
		)
	}
	return header, nil
}
