package core

import (
	"fmt"
	"sync"
)

// Blockchain manages an append-only chain of blocks.
// It provides thread-safe operations for adding blocks, querying state,
// and validating the integrity of the entire chain.
//
// Unlike Ethereum, this blockchain:
//   - Has no mining or proof-of-work/stake
//   - Has no gas fees or currency
//   - Uses authority-based consensus (single admin)
//   - Creates blocks on-demand when transactions are submitted
type Blockchain struct {
	mu     sync.RWMutex
	blocks []*Block
}

// NewBlockchain creates a new blockchain with a genesis block.
// The question parameter is embedded in the genesis block as the voting question.
func NewBlockchain(question string) *Blockchain {
	genesis := CreateGenesisBlock(question)
	return &Blockchain{
		blocks: []*Block{genesis},
	}
}

// LoadFromBlocks reconstructs a blockchain from a persisted set of blocks.
// It validates the entire chain before accepting it. Returns an error
// if the chain is empty, corrupted, or contains invalid hashes.
func LoadFromBlocks(blocks []*Block) (*Blockchain, error) {
	if len(blocks) == 0 {
		return nil, fmt.Errorf("cannot load empty blockchain")
	}

	bc := &Blockchain{blocks: blocks}

	if err := bc.validateChainInternal(); err != nil {
		return nil, fmt.Errorf("chain validation failed during load: %w", err)
	}

	return bc, nil
}

// AddBlock creates a new block containing the given transactions and
// appends it to the chain. Returns the new block or an error if the
// transaction list is empty.
//
// The new block is automatically linked to the previous block via
// hash chaining (PrevHash = latest block's Hash).
func (bc *Blockchain) AddBlock(transactions []Transaction) (*Block, error) {
	bc.mu.Lock()
	defer bc.mu.Unlock()

	if len(transactions) == 0 {
		return nil, fmt.Errorf("cannot create block with no transactions")
	}

	// Verify all transaction hashes before including them
	for i, tx := range transactions {
		if !tx.VerifyHash() {
			return nil, fmt.Errorf("transaction %d has invalid hash", i)
		}
	}

	latestBlock := bc.blocks[len(bc.blocks)-1]
	newBlock := NewBlock(latestBlock.Index+1, transactions, latestBlock.Hash)
	bc.blocks = append(bc.blocks, newBlock)

	return newBlock, nil
}

// AddTransaction is a convenience method that creates a single-transaction
// block and appends it to the chain. Useful for immediate processing of
// individual operations (register, vote, etc.).
func (bc *Blockchain) AddTransaction(tx *Transaction) (*Block, error) {
	return bc.AddBlock([]Transaction{*tx})
}

// GetLatestBlock returns the most recent block in the chain.
// For a new blockchain, this is the genesis block.
func (bc *Blockchain) GetLatestBlock() *Block {
	bc.mu.RLock()
	defer bc.mu.RUnlock()
	return bc.blocks[len(bc.blocks)-1]
}

// GetBlock returns a specific block by its index.
// Returns an error if the index is out of range.
func (bc *Blockchain) GetBlock(index uint64) (*Block, error) {
	bc.mu.RLock()
	defer bc.mu.RUnlock()

	if index >= uint64(len(bc.blocks)) {
		return nil, fmt.Errorf("block index %d out of range (chain has %d blocks)", index, len(bc.blocks))
	}

	return bc.blocks[index], nil
}

// GetBlocks returns a copy of all blocks in the chain.
// The returned slice is safe to modify without affecting the chain.
func (bc *Blockchain) GetBlocks() []*Block {
	bc.mu.RLock()
	defer bc.mu.RUnlock()

	result := make([]*Block, len(bc.blocks))
	copy(result, bc.blocks)
	return result
}

// Len returns the total number of blocks in the chain (including genesis).
func (bc *Blockchain) Len() int {
	bc.mu.RLock()
	defer bc.mu.RUnlock()
	return len(bc.blocks)
}

// Height returns the index of the latest block (Len - 1).
func (bc *Blockchain) Height() uint64 {
	bc.mu.RLock()
	defer bc.mu.RUnlock()
	return uint64(len(bc.blocks) - 1)
}

// GetAllTransactions returns all transactions across all blocks,
// optionally filtered by transaction type. Pass empty string for all types.
func (bc *Blockchain) GetAllTransactions(filterType TxType) []Transaction {
	bc.mu.RLock()
	defer bc.mu.RUnlock()

	var result []Transaction
	for _, block := range bc.blocks {
		for _, tx := range block.Transactions {
			if filterType == "" || tx.Type == filterType {
				result = append(result, tx)
			}
		}
	}
	return result
}

// ValidateChain verifies the integrity of the entire blockchain.
// It checks:
//  1. Each block's hash is correctly computed from its data
//  2. Each block's PrevHash matches the previous block's Hash
//  3. Block indices are sequential
//  4. All transaction hashes within each block are valid
//  5. Genesis block is valid (index 0, correct PrevHash)
//
// Returns nil if the chain is valid, or an error describing the first
// integrity violation found.
func (bc *Blockchain) ValidateChain() error {
	bc.mu.RLock()
	defer bc.mu.RUnlock()
	return bc.validateChainInternal()
}

// validateChainInternal performs chain validation without acquiring the lock.
// This is used internally by both ValidateChain (public) and LoadFromBlocks.
func (bc *Blockchain) validateChainInternal() error {
	if len(bc.blocks) == 0 {
		return fmt.Errorf("blockchain is empty")
	}

	// Validate genesis block
	genesis := bc.blocks[0]
	if genesis.Index != 0 {
		return fmt.Errorf("genesis block has invalid index: %d (expected 0)", genesis.Index)
	}
	if genesis.PrevHash != GenesisBlockPrevHash {
		return fmt.Errorf("genesis block has invalid prev_hash")
	}
	if !genesis.VerifyHash() {
		return fmt.Errorf("genesis block has invalid hash")
	}

	// Validate each subsequent block
	for i := 1; i < len(bc.blocks); i++ {
		current := bc.blocks[i]
		previous := bc.blocks[i-1]

		// Verify current block's hash
		if !current.VerifyHash() {
			return fmt.Errorf("block %d has invalid hash", current.Index)
		}

		// Verify chain linkage
		if current.PrevHash != previous.Hash {
			return fmt.Errorf("block %d has broken chain link (prev_hash mismatch)", current.Index)
		}

		// Verify sequential index
		if current.Index != previous.Index+1 {
			return fmt.Errorf("block %d has non-sequential index (expected %d, got %d)",
				i, previous.Index+1, current.Index)
		}

		// Verify timestamp is non-decreasing
		if current.Timestamp < previous.Timestamp {
			return fmt.Errorf("block %d has timestamp before previous block", current.Index)
		}

		// Verify all transaction hashes within the block
		for j, tx := range current.Transactions {
			if !tx.VerifyHash() {
				return fmt.Errorf("block %d, transaction %d has invalid hash", current.Index, j)
			}
		}
	}

	return nil
}

// PrintChain prints a human-readable summary of the blockchain to stdout.
// Useful for debugging and demonstration.
func (bc *Blockchain) PrintChain() {
	bc.mu.RLock()
	defer bc.mu.RUnlock()

	fmt.Printf("\n╔══════════════════════════════════════════╗\n")
	fmt.Printf("║        ZK VOTING BLOCKCHAIN              ║\n")
	fmt.Printf("║        Total Blocks: %-5d               ║\n", len(bc.blocks))
	fmt.Printf("╚══════════════════════════════════════════╝\n\n")

	for _, block := range bc.blocks {
		isGenesis := ""
		if block.IsGenesis() {
			isGenesis = " (GENESIS)"
		}

		fmt.Printf("┌─ Block #%d%s\n", block.Index, isGenesis)
		fmt.Printf("│  Hash:      %s\n", block.Hash[:16]+"...")
		fmt.Printf("│  PrevHash:  %s\n", block.PrevHash[:16]+"...")
		fmt.Printf("│  Timestamp: %d\n", block.Timestamp)
		fmt.Printf("│  Transactions: %d\n", len(block.Transactions))

		for _, tx := range block.Transactions {
			fmt.Printf("│    ├─ [%s] %s (hash: %s...)\n", tx.Type, tx.ID, tx.Hash[:12])
		}

		fmt.Printf("└──────────────────────────────────────\n\n")
	}
}
