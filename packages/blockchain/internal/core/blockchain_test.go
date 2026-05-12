package core

import (
	"encoding/json"
	"fmt"
	"testing"
)

// --- Genesis Block Tests ---

func TestNewBlockchain(t *testing.T) {
	bc := NewBlockchain("Do you support this proposal?")

	if bc.Len() != 1 {
		t.Fatalf("expected 1 block (genesis), got %d", bc.Len())
	}

	genesis := bc.GetLatestBlock()
	if genesis.Index != 0 {
		t.Errorf("genesis index should be 0, got %d", genesis.Index)
	}
	if genesis.PrevHash != GenesisBlockPrevHash {
		t.Errorf("genesis prev_hash should be all zeros")
	}
	if !genesis.IsGenesis() {
		t.Error("genesis block should report IsGenesis() == true")
	}
	if !genesis.HasTransactions() {
		t.Error("genesis block should have at least one transaction")
	}
	if genesis.Hash == "" {
		t.Error("genesis block should have a computed hash")
	}

	// Verify genesis payload contains the question
	var payload GenesisPayload
	if err := genesis.Transactions[0].ParsePayload(&payload); err != nil {
		t.Fatalf("failed to parse genesis payload: %v", err)
	}
	if payload.Question != "Do you support this proposal?" {
		t.Errorf("expected question 'Do you support this proposal?', got '%s'", payload.Question)
	}
	if payload.Action != "GENESIS" {
		t.Errorf("expected action 'GENESIS', got '%s'", payload.Action)
	}
	if payload.Version != "1.0.0" {
		t.Errorf("expected version '1.0.0', got '%s'", payload.Version)
	}
}

// --- Transaction Tests ---

func TestNewTransaction(t *testing.T) {
	payload := AddVoterPayload{VoterID: "voter1", Allowed: true}
	tx, err := NewTransaction(TxAddVoter, payload)
	if err != nil {
		t.Fatalf("failed to create transaction: %v", err)
	}

	if tx.Type != TxAddVoter {
		t.Errorf("expected type %s, got %s", TxAddVoter, tx.Type)
	}
	if tx.Hash == "" {
		t.Error("transaction should have a computed hash")
	}
	if tx.ID == "" {
		t.Error("transaction should have an ID")
	}
	if len(tx.ID) != 16 {
		t.Errorf("expected ID length 16, got %d", len(tx.ID))
	}
	if !tx.VerifyHash() {
		t.Error("transaction hash verification should pass")
	}

	// Verify payload is stored correctly
	var parsed AddVoterPayload
	if err := tx.ParsePayload(&parsed); err != nil {
		t.Fatalf("failed to parse payload: %v", err)
	}
	if parsed.VoterID != "voter1" || parsed.Allowed != true {
		t.Error("parsed payload doesn't match original")
	}
}

func TestTransactionTamperDetection(t *testing.T) {
	payload := AddVoterPayload{VoterID: "voter1", Allowed: true}
	tx, _ := NewTransaction(TxAddVoter, payload)

	// Tamper with the payload
	tampered := AddVoterPayload{VoterID: "hacker", Allowed: true}
	tamperedBytes, _ := json.Marshal(tampered)
	tx.Payload = tamperedBytes

	if tx.VerifyHash() {
		t.Error("tampered transaction should fail hash verification")
	}
}

// --- Block Addition Tests ---

func TestAddBlock(t *testing.T) {
	bc := NewBlockchain("Test question")

	tx1, _ := NewTransaction(TxAddVoter, AddVoterPayload{VoterID: "voter1", Allowed: true})
	tx2, _ := NewTransaction(TxAddVoter, AddVoterPayload{VoterID: "voter2", Allowed: true})

	block, err := bc.AddBlock([]Transaction{*tx1, *tx2})
	if err != nil {
		t.Fatalf("failed to add block: %v", err)
	}

	if block.Index != 1 {
		t.Errorf("expected block index 1, got %d", block.Index)
	}
	if block.TransactionCount() != 2 {
		t.Errorf("expected 2 transactions, got %d", block.TransactionCount())
	}
	if bc.Len() != 2 {
		t.Errorf("expected 2 blocks, got %d", bc.Len())
	}

	// Verify chain linkage
	genesis, _ := bc.GetBlock(0)
	if block.PrevHash != genesis.Hash {
		t.Error("block 1's prev_hash should match genesis hash")
	}
}

func TestAddTransaction(t *testing.T) {
	bc := NewBlockchain("Test question")

	tx, _ := NewTransaction(TxRegister, RegisterPayload{
		VoterID:    "voter1",
		Commitment: "0xabcdef",
		LeafIndex:  0,
	})

	block, err := bc.AddTransaction(tx)
	if err != nil {
		t.Fatalf("failed to add transaction: %v", err)
	}

	if block.TransactionCount() != 1 {
		t.Errorf("expected 1 transaction, got %d", block.TransactionCount())
	}
}

func TestAddEmptyBlock(t *testing.T) {
	bc := NewBlockchain("Test question")

	_, err := bc.AddBlock([]Transaction{})
	if err == nil {
		t.Error("adding empty block should fail")
	}
}

// --- Chain Building Tests ---

func TestMultipleBlocks(t *testing.T) {
	bc := NewBlockchain("Test question")

	// Add 5 blocks with different transaction types
	for i := 0; i < 5; i++ {
		tx, _ := NewTransaction(TxAddVoter, AddVoterPayload{
			VoterID: fmt.Sprintf("voter%d", i),
			Allowed: true,
		})
		_, err := bc.AddTransaction(tx)
		if err != nil {
			t.Fatalf("failed to add block %d: %v", i+1, err)
		}
	}

	if bc.Len() != 6 { // genesis + 5
		t.Errorf("expected 6 blocks, got %d", bc.Len())
	}

	if bc.Height() != 5 {
		t.Errorf("expected height 5, got %d", bc.Height())
	}

	// Each block should link to the previous
	blocks := bc.GetBlocks()
	for i := 1; i < len(blocks); i++ {
		if blocks[i].PrevHash != blocks[i-1].Hash {
			t.Errorf("block %d has broken chain link", i)
		}
	}
}

// --- Chain Validation Tests ---

func TestValidateChain(t *testing.T) {
	bc := NewBlockchain("Test question")

	tx, _ := NewTransaction(TxAddVoter, AddVoterPayload{VoterID: "voter1", Allowed: true})
	bc.AddTransaction(tx)

	tx2, _ := NewTransaction(TxVote, VotePayload{
		Proof:         "0xproof",
		NullifierHash: "0xnull",
		Root:          "0xroot",
		Vote:          true,
		Depth:         3,
	})
	bc.AddTransaction(tx2)

	err := bc.ValidateChain()
	if err != nil {
		t.Errorf("valid chain should pass validation: %v", err)
	}
}

func TestTamperDetection_ModifyBlockHash(t *testing.T) {
	bc := NewBlockchain("Test question")

	tx, _ := NewTransaction(TxAddVoter, AddVoterPayload{VoterID: "voter1", Allowed: true})
	bc.AddTransaction(tx)

	// Tamper with block 1's hash
	bc.blocks[1].Hash = "tampered_hash_value"

	err := bc.ValidateChain()
	if err == nil {
		t.Error("tampered chain should fail validation")
	}
}

func TestTamperDetection_ModifyPrevHash(t *testing.T) {
	bc := NewBlockchain("Test question")

	tx1, _ := NewTransaction(TxAddVoter, AddVoterPayload{VoterID: "voter1", Allowed: true})
	bc.AddTransaction(tx1)

	tx2, _ := NewTransaction(TxAddVoter, AddVoterPayload{VoterID: "voter2", Allowed: true})
	bc.AddTransaction(tx2)

	// Tamper with block 2's prev_hash (breaks chain linkage)
	bc.blocks[2].PrevHash = "tampered_prev_hash"

	err := bc.ValidateChain()
	if err == nil {
		t.Error("broken chain linkage should fail validation")
	}
}

func TestTamperDetection_ModifyTransactionData(t *testing.T) {
	bc := NewBlockchain("Test question")

	tx, _ := NewTransaction(TxVote, VotePayload{
		Proof:         "0xlegit_proof",
		NullifierHash: "0xnull",
		Root:          "0xroot",
		Vote:          true,
		Depth:         3,
	})
	bc.AddTransaction(tx)

	// Tamper with vote payload inside the block
	tamperedPayload, _ := json.Marshal(VotePayload{
		Proof:         "0xlegit_proof",
		NullifierHash: "0xnull",
		Root:          "0xroot",
		Vote:          false, // Changed from true to false!
		Depth:         3,
	})
	bc.blocks[1].Transactions[0].Payload = tamperedPayload

	err := bc.ValidateChain()
	if err == nil {
		t.Error("tampered transaction data should fail validation")
	}
}

// --- Query Tests ---

func TestGetBlock(t *testing.T) {
	bc := NewBlockchain("Test question")

	genesis, err := bc.GetBlock(0)
	if err != nil {
		t.Fatalf("failed to get genesis: %v", err)
	}
	if !genesis.IsGenesis() {
		t.Error("block 0 should be genesis")
	}

	_, err = bc.GetBlock(999)
	if err == nil {
		t.Error("getting non-existent block should fail")
	}
}

func TestGetAllTransactions(t *testing.T) {
	bc := NewBlockchain("Test question")

	// Add different transaction types
	tx1, _ := NewTransaction(TxAddVoter, AddVoterPayload{VoterID: "voter1", Allowed: true})
	bc.AddTransaction(tx1)

	tx2, _ := NewTransaction(TxRegister, RegisterPayload{VoterID: "voter1", Commitment: "0xabc"})
	bc.AddTransaction(tx2)

	tx3, _ := NewTransaction(TxVote, VotePayload{Vote: true})
	bc.AddTransaction(tx3)

	// Get all transactions (including genesis)
	allTxs := bc.GetAllTransactions("")
	if len(allTxs) != 4 { // genesis + 3
		t.Errorf("expected 4 total transactions, got %d", len(allTxs))
	}

	// Filter by type
	registerTxs := bc.GetAllTransactions(TxRegister)
	if len(registerTxs) != 1 {
		t.Errorf("expected 1 REGISTER transaction, got %d", len(registerTxs))
	}

	voteTxs := bc.GetAllTransactions(TxVote)
	if len(voteTxs) != 1 {
		t.Errorf("expected 1 VOTE transaction, got %d", len(voteTxs))
	}
}

func TestGetTransactionsByType(t *testing.T) {
	bc := NewBlockchain("Test question")

	// Add a block with mixed transaction types
	tx1, _ := NewTransaction(TxAddVoter, AddVoterPayload{VoterID: "voter1", Allowed: true})
	tx2, _ := NewTransaction(TxAddVoter, AddVoterPayload{VoterID: "voter2", Allowed: true})
	tx3, _ := NewTransaction(TxRegister, RegisterPayload{VoterID: "voter1", Commitment: "0xabc"})

	block, _ := bc.AddBlock([]Transaction{*tx1, *tx2, *tx3})

	addVoterTxs := block.GetTransactionsByType(TxAddVoter)
	if len(addVoterTxs) != 2 {
		t.Errorf("expected 2 ADD_VOTER transactions, got %d", len(addVoterTxs))
	}

	registerTxs := block.GetTransactionsByType(TxRegister)
	if len(registerTxs) != 1 {
		t.Errorf("expected 1 REGISTER transaction, got %d", len(registerTxs))
	}
}

// --- Load From Blocks Tests ---

func TestLoadFromBlocks(t *testing.T) {
	// Create a valid chain
	original := NewBlockchain("Test question")
	tx, _ := NewTransaction(TxAddVoter, AddVoterPayload{VoterID: "voter1", Allowed: true})
	original.AddTransaction(tx)

	// Extract blocks and reconstruct
	blocks := original.GetBlocks()
	loaded, err := LoadFromBlocks(blocks)
	if err != nil {
		t.Fatalf("failed to load from valid blocks: %v", err)
	}

	if loaded.Len() != original.Len() {
		t.Errorf("loaded chain length (%d) != original (%d)", loaded.Len(), original.Len())
	}

	if loaded.GetLatestBlock().Hash != original.GetLatestBlock().Hash {
		t.Error("loaded chain's latest hash should match original")
	}
}

func TestLoadFromBlocks_Invalid(t *testing.T) {
	// Try to load with tampered blocks
	bc := NewBlockchain("Test question")
	tx, _ := NewTransaction(TxAddVoter, AddVoterPayload{VoterID: "voter1", Allowed: true})
	bc.AddTransaction(tx)

	blocks := bc.GetBlocks()
	blocks[1].Hash = "tampered"

	_, err := LoadFromBlocks(blocks)
	if err == nil {
		t.Error("loading tampered blocks should fail")
	}
}

func TestLoadFromBlocks_Empty(t *testing.T) {
	_, err := LoadFromBlocks([]*Block{})
	if err == nil {
		t.Error("loading empty blocks should fail")
	}
}

