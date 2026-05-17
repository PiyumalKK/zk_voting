package persistence

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"zk-blockchain/internal/core"
	"zk-blockchain/internal/security"
)

// chainData is the serialization format for the blockchain.
type chainData struct {
	Blocks []*core.Block `json:"blocks"`
}

// FileStore provides JSON file-based persistence for the blockchain.
// It saves and loads the entire chain to/from a single JSON file.
//
// When an encryption key is configured (via SetEncryptionKey), the file
// is encrypted at rest using AES-256-GCM symmetric encryption. This protects
// election data if an attacker gains physical access to the server's filesystem.
//
// BACKWARD COMPATIBILITY: The store automatically detects whether a file
// is encrypted (prefixed with "ZKENC") or plaintext JSON, and handles both.
// Existing unencrypted blockchain files will load without any changes.
//
// For a voting application, this is sufficient — the chain grows linearly
// with the number of voters (typically hundreds to thousands of blocks).
type FileStore struct {
	dataDir       string
	filename      string
	encryptionKey []byte // nil = no encryption, 32 bytes = AES-256 key
}

// NewFileStore creates a new file-based persistence store.
// The data directory is created if it doesn't exist.
// By default, no encryption is applied — call SetEncryptionKey to enable.
func NewFileStore(dataDir string) *FileStore {
	return &FileStore{
		dataDir:  dataDir,
		filename: "blockchain.json",
	}
}

// SetEncryptionKey enables AES-256-GCM encryption for the blockchain file.
//
// The passphrase is converted to a 32-byte AES-256 key using SHA-256
// key derivation (see security.DeriveKey). The same passphrase must be
// provided on subsequent runs to decrypt the stored blockchain.
//
// How this works:
//   - passphrase → SHA-256 hash → 32-byte AES key (deterministic)
//   - Same passphrase always produces the same key → can decrypt later
//   - SHA-256 is one-way → original passphrase cannot be recovered from key
//
// This is a SYMMETRIC ENCRYPTION scheme — the same key is used for both
// encrypting (saving) and decrypting (loading) the blockchain data.
func (fs *FileStore) SetEncryptionKey(passphrase string) {
	fs.encryptionKey = security.DeriveKey(passphrase)
	fmt.Println("🔐 Storage: AES-256-GCM encryption ENABLED for blockchain data")
}

// SaveBlockchain writes the entire blockchain to a file.
//
// If an encryption key is configured:
//   1. The blockchain is serialized to JSON (plaintext)
//   2. The JSON bytes are encrypted using AES-256-GCM:
//      - A random 12-byte nonce is generated (ensures unique ciphertext each save)
//      - The plaintext is encrypted with AES-256 in counter mode
//      - A GCM authentication tag is computed (verifies integrity on decrypt)
//   3. The magic prefix "ZKENC" is prepended to identify the file as encrypted
//   4. The encrypted data is written to disk atomically
//
// If no encryption key is configured:
//   - The blockchain is saved as plaintext JSON (original behaviour)
//
// The file is always written atomically (write to temp, then rename) to prevent
// corruption if the process is interrupted during write.
func (fs *FileStore) SaveBlockchain(bc *core.Blockchain) error {
	// Ensure data directory exists
	if err := os.MkdirAll(fs.dataDir, 0755); err != nil {
		return fmt.Errorf("failed to create data directory: %w", err)
	}

	data := chainData{
		Blocks: bc.GetBlocks(),
	}

	// Serialize the blockchain to JSON
	jsonBytes, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal blockchain: %w", err)
	}

	// Determine the final file content — encrypted or plaintext
	var fileData []byte

	if fs.encryptionKey != nil {
		// ── AES-256-GCM Encryption ──────────────────────────────────
		// Encrypt the JSON bytes using the symmetric encryption key.
		// Each save generates a new random nonce, so the ciphertext is
		// different every time even for identical blockchain data.
		encrypted, err := security.EncryptAESGCM(jsonBytes, fs.encryptionKey)
		if err != nil {
			return fmt.Errorf("failed to encrypt blockchain data: %w", err)
		}

		// Prepend the "ZKENC" magic prefix so we can identify encrypted
		// files during loading (backward compatibility with plaintext files)
		fileData = append([]byte(nil), security.EncryptedMagic...)
		fileData = append(fileData, encrypted...)
	} else {
		// No encryption — save as plaintext JSON (original behaviour)
		fileData = jsonBytes
	}

	filePath := filepath.Join(fs.dataDir, fs.filename)

	// Write to temp file first, then rename (atomic write)
	// This protects data integrity — if the process crashes during write,
	// the original file remains intact
	tmpPath := filePath + ".tmp"
	if err := os.WriteFile(tmpPath, fileData, 0644); err != nil {
		return fmt.Errorf("failed to write temp file: %w", err)
	}

	if err := os.Rename(tmpPath, filePath); err != nil {
		// If rename fails, try direct write as fallback
		os.Remove(tmpPath)
		if err := os.WriteFile(filePath, fileData, 0644); err != nil {
			return fmt.Errorf("failed to write blockchain file: %w", err)
		}
	}

	return nil
}

// LoadBlockchain reads a blockchain from the file.
//
// BACKWARD COMPATIBILITY — this function handles both encrypted and
// plaintext files automatically:
//
//   1. Reads the raw file bytes
//   2. Checks for the "ZKENC" magic prefix:
//      - If present → file is encrypted → decrypt with AES-256-GCM
//      - If absent → file is plaintext JSON → parse directly
//   3. Unmarshals the JSON data into blockchain structures
//   4. Validates the loaded chain's integrity (SHA-256 hash verification)
//
// This means:
//   - Existing plaintext blockchain.json files continue to work ✅
//   - Encrypted files are decrypted transparently ✅
//   - Encrypted files without the correct key produce a clear error ✅
//   - Tampered encrypted files are detected by GCM authentication ✅
func (fs *FileStore) LoadBlockchain() (*core.Blockchain, error) {
	filePath := filepath.Join(fs.dataDir, fs.filename)

	fileBytes, err := os.ReadFile(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("no blockchain file found at %s", filePath)
		}
		return nil, fmt.Errorf("failed to read blockchain file: %w", err)
	}

	// ── Detect encrypted vs. plaintext file ─────────────────────────
	// Encrypted files start with the "ZKENC" magic prefix (5 bytes).
	// Plaintext JSON files start with '{' or whitespace.
	var jsonBytes []byte

	if bytes.HasPrefix(fileBytes, security.EncryptedMagic) {
		// File is encrypted — we need the decryption key
		if fs.encryptionKey == nil {
			return nil, fmt.Errorf("blockchain file is encrypted (ZKENC prefix detected) but no ENCRYPTION_KEY was provided — set the ENCRYPTION_KEY environment variable")
		}

		// Strip the magic prefix to get the raw AES-GCM ciphertext
		encryptedData := fileBytes[len(security.EncryptedMagic):]

		// Decrypt using AES-256-GCM
		// This also verifies the GCM authentication tag — if the file
		// was tampered with on disk, decryption will fail with an error
		decrypted, err := security.DecryptAESGCM(encryptedData, fs.encryptionKey)
		if err != nil {
			return nil, fmt.Errorf("failed to decrypt blockchain file: %w", err)
		}

		jsonBytes = decrypted
		fmt.Println("🔐 Storage: Blockchain data decrypted successfully")
	} else {
		// File is plaintext JSON — load directly (backward compatible)
		jsonBytes = fileBytes
	}

	// Parse the JSON into blockchain structures
	var data chainData
	if err := json.Unmarshal(jsonBytes, &data); err != nil {
		return nil, fmt.Errorf("failed to parse blockchain file: %w", err)
	}

	if len(data.Blocks) == 0 {
		return nil, fmt.Errorf("blockchain file contains no blocks")
	}

	// Reconstruct and validate the blockchain
	// This performs SHA-256 hash verification on every block and transaction
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
