package persistence

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"zk-blockchain/internal/core"
)

// chainData is the serialization format for the blockchain.
type chainData struct {
	Blocks []*core.Block `json:"blocks"`
}

// FileStore provides JSON file-based persistence for the blockchain.
// It saves and loads the entire chain to/from a single JSON file.
//
// For a voting application, this is sufficient — the chain grows linearly
// with the number of voters (typically hundreds to thousands of blocks).
type FileStore struct {
	dataDir  string
	filename string
}

// NewFileStore creates a new file-based persistence store.
// The data directory is created if it doesn't exist.
func NewFileStore(dataDir string) *FileStore {
	return &FileStore{
		dataDir:  dataDir,
		filename: "blockchain.json",
	}
}

// SaveBlockchain writes the entire blockchain to a JSON file.
// The file is written atomically (write to temp, then rename) to prevent
// corruption if the process is interrupted during write.
func (fs *FileStore) SaveBlockchain(bc *core.Blockchain) error {
	// Ensure data directory exists
	if err := os.MkdirAll(fs.dataDir, 0755); err != nil {
		return fmt.Errorf("failed to create data directory: %w", err)
	}

	data := chainData{
		Blocks: bc.GetBlocks(),
	}

	bytes, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal blockchain: %w", err)
	}

	filePath := filepath.Join(fs.dataDir, fs.filename)

	// Write to temp file first, then rename (atomic write)
	tmpPath := filePath + ".tmp"
	if err := os.WriteFile(tmpPath, bytes, 0644); err != nil {
		return fmt.Errorf("failed to write temp file: %w", err)
	}

	if err := os.Rename(tmpPath, filePath); err != nil {
		// If rename fails, try direct write as fallback
		os.Remove(tmpPath)
		if err := os.WriteFile(filePath, bytes, 0644); err != nil {
			return fmt.Errorf("failed to write blockchain file: %w", err)
		}
	}

	return nil
}

// LoadBlockchain reads a blockchain from the JSON file.
// It validates the loaded chain's integrity before returning it.
// Returns an error if the file doesn't exist, is corrupted, or
// the chain fails validation.
func (fs *FileStore) LoadBlockchain() (*core.Blockchain, error) {
	filePath := filepath.Join(fs.dataDir, fs.filename)

	bytes, err := os.ReadFile(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("no blockchain file found at %s", filePath)
		}
		return nil, fmt.Errorf("failed to read blockchain file: %w", err)
	}

	var data chainData
	if err := json.Unmarshal(bytes, &data); err != nil {
		return nil, fmt.Errorf("failed to parse blockchain file: %w", err)
	}

	if len(data.Blocks) == 0 {
		return nil, fmt.Errorf("blockchain file contains no blocks")
	}

	// Reconstruct and validate the blockchain
	bc, err := core.LoadFromBlocks(data.Blocks)
	if err != nil {
		return nil, fmt.Errorf("failed to load blockchain: %w", err)
	}

	return bc, nil
}

// Exists checks whether a blockchain file exists.
func (fs *FileStore) Exists() bool {
	filePath := filepath.Join(fs.dataDir, fs.filename)
	_, err := os.Stat(filePath)
	return err == nil
}

// FilePath returns the full path to the blockchain file.
func (fs *FileStore) FilePath() string {
	return filepath.Join(fs.dataDir, fs.filename)
}

// Delete removes the blockchain file. Use with caution.
func (fs *FileStore) Delete() error {
	filePath := filepath.Join(fs.dataDir, fs.filename)
	if err := os.Remove(filePath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to delete blockchain file: %w", err)
	}
	return nil
}
