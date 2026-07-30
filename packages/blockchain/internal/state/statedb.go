package state

import (
	"fmt"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/state"
	"github.com/ethereum/go-ethereum/ethdb"
	"github.com/ethereum/go-ethereum/triedb"
)

// At opens a *state.StateDB rooted at root, backed by db. Every caller that
// needs to read or mutate account state — RPC reads (M04), tx execution
// (M03), audit replay (M09) — goes through this one function so the rest
// of the codebase never imports geth's state/triedb packages directly
// (MASTER §4 package boundary: "the rest of the code never imports geth
// state packages directly").
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
