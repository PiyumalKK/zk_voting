// Package storage owns the node's on-disk persistence: opening and closing
// the geth-native key/value + ancient (freezer) database that
// internal/state and internal/chain build blocks and state on top of.
//
// M02 only opens/closes the database; genesis construction lives in
// internal/state (it needs an open database, not the other way around).
package storage

import (
	"fmt"
	"path/filepath"

	"github.com/ethereum/go-ethereum/core/rawdb"
	"github.com/ethereum/go-ethereum/ethdb"
	"github.com/ethereum/go-ethereum/ethdb/pebble"
)

// dbNamespace prefixes the Prometheus metrics rawdb and the underlying
// key-value store register their instrumentation under. It has no effect
// on the data itself.
const dbNamespace = "zkchain/db/"

// cacheSizeMB and fileHandles are conservative single-node defaults — this
// is not a mainnet archive node, just a small permissioned chain's data
// directory. Revisit if M10 replication shows contention.
const (
	cacheSizeMB = 512
	fileHandles = 256
)

// Open opens (creating on first run) the node's persistent chain database
// at dataDir, backed by Pebble. Per go-ethereum v1.16's actual layering
// (verified against core/rawdb/database.go and node/database.go): the raw
// Pebble key-value store is constructed first via ethdb/pebble.New, then
// wrapped with rawdb.Open to attach the ancient/freezer store — rawdb.Open
// takes an already-open ethdb.KeyValueStore, it does not open one itself.
// The ancient store lives in dataDir/ancient, so a single DATA_DIR env var
// locates the whole database.
//
// Pebble holds an exclusive OS-level lock on dataDir for as long as the
// database is open. If another process (or another instance of this node)
// already has it open, the underlying error is wrapped with a clearer
// explanation than Pebble's raw lock message.
func Open(dataDir string) (ethdb.Database, error) {
	kv, err := pebble.New(dataDir, cacheSizeMB, fileHandles, dbNamespace, false)
	if err != nil {
		return nil, lockErr(dataDir, err)
	}

	db, err := rawdb.Open(kv, rawdb.OpenOptions{
		Ancient:          filepath.Join(dataDir, "ancient"),
		MetricsNamespace: dbNamespace,
		ReadOnly:         false,
	})
	if err != nil {
		kv.Close()
		return nil, lockErr(dataDir, err)
	}
	return db, nil
}

func lockErr(dataDir string, err error) error {
	return fmt.Errorf(
		"open chain database at %q: %w (if another zk-blockchain process is running against this data dir, stop it first; a stale lock after a crash can be cleared once you're sure no process holds it)",
		dataDir, err,
	)
}
