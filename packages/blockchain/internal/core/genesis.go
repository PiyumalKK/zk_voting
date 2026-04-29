package core

import "time"

// CreateGenesisBlock creates the first block of the blockchain.
// The genesis block contains a special transaction recording the voting
// question and protocol version. It serves as the immutable root of the chain.
//
// The genesis block has:
//   - Index: 0
//   - PrevHash: all zeros (no previous block)
//   - A single GENESIS transaction with the voting question
func CreateGenesisBlock(question string) *Block {
	genesisPayload := GenesisPayload{
		Action:   "GENESIS",
		Question: question,
		Version:  "1.0.0",
	}

	genesisTx, _ := NewTransaction(TxAddVoter, genesisPayload)

	block := &Block{
		Index:        0,
		Timestamp:    time.Now().UnixMilli(),
		Transactions: []Transaction{*genesisTx},
		PrevHash:     GenesisBlockPrevHash,
	}
	block.Hash = block.computeHash()
	return block
}
