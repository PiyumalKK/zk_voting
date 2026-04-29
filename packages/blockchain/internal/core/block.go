package core

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// Block represents a single block in the voting blockchain.
// Each block contains a set of transactions and is cryptographically linked
// to the previous block via PrevHash, forming an immutable chain.
//
// Unlike Ethereum/Bitcoin, there is no mining, no nonce, and no difficulty.
// Blocks are created by the authority (election admin) when transactions
// are submitted. This is sufficient for a centrally-administered election.
type Block struct {
	Index        uint64        `json:"index"`        // Block number (0 = genesis)
	Timestamp    int64         `json:"timestamp"`    // Unix milliseconds when block was created
	Transactions []Transaction `json:"transactions"` // Transactions included in this block
	PrevHash     string        `json:"prev_hash"`    // SHA-256 hash of the previous block
	Hash         string        `json:"hash"`         // SHA-256 hash of this block
}

// GenesisBlockPrevHash is the sentinel value for the genesis block's PrevHash.
// It is a string of 64 zeros (representing an all-zero SHA-256 hash).
const GenesisBlockPrevHash = "0000000000000000000000000000000000000000000000000000000000000000"

// NewBlock creates a new block containing the given transactions.
// The block is linked to the previous block via prevHash, and its own
// hash is computed from its contents (index, timestamp, prevHash, tx hashes).
func NewBlock(index uint64, transactions []Transaction, prevHash string) *Block {
	block := &Block{
		Index:        index,
		Timestamp:    time.Now().UnixMilli(),
		Transactions: transactions,
		PrevHash:     prevHash,
	}
	block.Hash = block.computeHash()
	return block
}

// computeHash generates a SHA-256 hash of the block's content.
// The hash covers: index, timestamp, prevHash, and all transaction hashes.
// This ensures any modification to the block or its transactions is detectable.
func (b *Block) computeHash() string {
	txHashes := make([]string, len(b.Transactions))
	for i, tx := range b.Transactions {
		txHashes[i] = tx.Hash
	}

	data := fmt.Sprintf("%d:%d:%s:%s",
		b.Index,
		b.Timestamp,
		b.PrevHash,
		strings.Join(txHashes, ","),
	)

	hash := sha256.Sum256([]byte(data))
	return hex.EncodeToString(hash[:])
}

// VerifyHash checks whether the stored hash matches the recomputed hash.
// Returns false if the block data has been tampered with.
func (b *Block) VerifyHash() bool {
	return b.Hash == b.computeHash()
}

// HasTransactions returns true if the block contains any transactions.
func (b *Block) HasTransactions() bool {
	return len(b.Transactions) > 0
}

// IsGenesis returns true if this is the genesis block (index 0).
func (b *Block) IsGenesis() bool {
	return b.Index == 0 && b.PrevHash == GenesisBlockPrevHash
}

// TransactionCount returns the number of transactions in the block.
func (b *Block) TransactionCount() int {
	return len(b.Transactions)
}

// GetTransactionsByType filters and returns transactions of a specific type.
func (b *Block) GetTransactionsByType(txType TxType) []Transaction {
	var result []Transaction
	for _, tx := range b.Transactions {
		if tx.Type == txType {
			result = append(result, tx)
		}
	}
	return result
}
