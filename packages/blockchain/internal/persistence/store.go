package persistence

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"time"

	"go.etcd.io/bbolt"
	"zk-blockchain/internal/core"
)

const (
	dbFileName = "blockchain.db"
	blocksBucket = "blocks"
)

// ErrNoBlockchain is returned by LoadBlockchain when the database exists but holds
// no blocks (a fresh, never-written node). Callers must distinguish this from a
// genuine load/validation failure: the former means "create genesis", the latter
// must be fatal so a corrupt chain is never silently discarded.
var ErrNoBlockchain = errors.New("no blocks found in database")

// FileStore provides BoltDB-based persistence for the blockchain.
type FileStore struct {
	db *bbolt.DB
}

// NewFileStore opens the BoltDB database and ensures the blocks bucket exists.
func NewFileStore(dataDir string) (*FileStore, error) {
	dbPath := filepath.Join(dataDir, dbFileName)
	db, err := bbolt.Open(dbPath, 0600, &bbolt.Options{Timeout: 1 * time.Second})
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	//create teh blocks bucket if it doesn't exists
	err = db.Update(func(tx *bbolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists([]byte(blocksBucket))
		return err
	})
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("failed to create bucket: %w", err)
	}

	return &FileStore{db: db}, nil
}

// Close safely closes the database connection.
func (fs *FileStore) Close() error {
	return fs.db.Close()
}

// itob returns an 8-byte big endian representation of v.
// This is used to ensure block keys sort correctly in BoltDB.
func itob(v uint64) []byte {
	b := make([]byte, 8)
	binary.BigEndian.PutUint64(b, v)
	return b
}

// SaveBlock appends a single block to the database.
func (fs *FileStore) SaveBlock(block *core.Block) error {
	return fs.db.Update(func(tx *bbolt.Tx) error {
		b := tx.Bucket([]byte(blocksBucket))

		data, err := json.Marshal(block)
		if err != nil {
			return err
		}

		return b.Put(itob(block.Index), data)
	})
}

// SaveBlockchain saves all blocks in the given blockchain.
// Used primarily for genesis or mass import.
func (fs *FileStore) SaveBlockchain(bc *core.Blockchain) error {
	return fs.db.Update(func(tx *bbolt.Tx) error {
		b := tx.Bucket([]byte(blocksBucket))
		for _, block := range bc.GetBlocks() {
			data, err := json.Marshal(block)
			if err != nil {
				return err
			}
			if err := b.Put(itob(block.Index), data); err != nil {
				return err
			}
		}
		return nil
	})
}

// LoadBlockchain iterates through the BoltDB bucket and reconstructs the chain.
func (fs *FileStore) LoadBlockchain() (*core.Blockchain, error) {
	var blocks []*core.Block

	err := fs.db.View(func(tx *bbolt.Tx) error {
		b := tx.Bucket([]byte(blocksBucket))
		c := b.Cursor()

		for k, v := c.First(); k != nil; k, v = c.Next() {
			var block core.Block
			if err := json.Unmarshal(v, &block); err != nil {
				return fmt.Errorf("failed to unmarshal block: %w", err)
			}
			blocks = append(blocks, &block)
		}
		return nil
	})

	if err != nil {
		return nil, err
	}

	if len(blocks) == 0 {
		return nil, ErrNoBlockchain
	}

	// Validate the loaded blocks
	return core.LoadFromBlocks(blocks)
}