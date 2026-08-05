package state

import (
	"fmt"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/state"
	"github.com/ethereum/go-ethereum/ethdb"
	"github.com/ethereum/go-ethereum/triedb"
)

// At opens a *state.StateDB rooted at root, backed by db, for read-only use.
// Every caller that only reads account state — RPC reads (M04), Call/
// EstimateGas dry-runs (M03) — goes through this one function so the rest
// of the codebase never imports geth's state/triedb packages directly
// (MASTER §4 package boundary: "the rest of the code never imports geth
// state packages directly"). The triedb backing the returned StateDB is not
// exposed, so nothing this function returns can be used to durably commit a
// mutation to disk — see Writable for that.
//
// Hash-scheme trie database, matching genesis.go's EnsureGenesis — the
// chain never switches trie schemes mid-life.
func At(db ethdb.Database, root common.Hash) (*state.StateDB, error) {
	tdb := triedb.NewDatabase(db, triedb.HashDefaults)
	sdb := state.NewDatabase(tdb, nil)

	statedb, err := state.New(root, sdb)
	if err != nil {
		return nil, fmt.Errorf("open state at root %s: %w", root, err)
	}
	return statedb, nil
}

// WritableState pairs a StateDB with the triedb.Database backing it. Unlike
// At's return value, the trie nodes a caller writes into this StateDB (via
// SSTORE-driven state mutations during EVM execution, then StateDB.Commit)
// are not actually durable until the caller also commits and closes TrieDB
// — see the doc comment on Writable.
type WritableState struct {
	*state.StateDB
	TrieDB *triedb.Database
}

// Writable opens a *state.StateDB rooted at root, backed by db, for callers
// that mutate state and need to persist the result — internal/chain (M03)
// is the only such caller today. Only internal/chain should call this; RPC
// reads and audit replay want At's read-only, no-commit-responsibility
// version instead.
//
// The expected lifecycle, mirroring the only triedb usage already proven to
// work in this codebase (genesis.go's EnsureGenesis: open a fresh
// triedb.Database, use it for exactly one commit, close it) is:
//
//	ws, err := state.Writable(db, parentRoot)
//	// ... mutate ws.StateDB via EVM execution ...
//	root, err := ws.Commit(blockNumber, true, false)   // StateDB.Commit (embedded)
//	err = ws.TrieDB.Commit(root, false)                // flush trie nodes to disk
//	err = ws.TrieDB.Close()
//
// If the caller decides not to keep the mutation (e.g. the transaction
// reverted or a validation check failed after Writable was already opened),
// it must still call ws.TrieDB.Close() to release the trie database's
// resources; it must NOT call ws.Commit / ws.TrieDB.Commit, since nothing
// has been written to db until those are called.
func Writable(db ethdb.Database, root common.Hash) (*WritableState, error) {
	tdb := triedb.NewDatabase(db, triedb.HashDefaults)
	sdb := state.NewDatabase(tdb, nil)

	statedb, err := state.New(root, sdb)
	if err != nil {
		tdb.Close()
		return nil, fmt.Errorf("open writable state at root %s: %w", root, err)
	}
	return &WritableState{StateDB: statedb, TrieDB: tdb}, nil
}
