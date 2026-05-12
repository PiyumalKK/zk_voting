package main

import (
	"fmt"
	"log"
	"os"

	"zk-blockchain/internal/core"
	"zk-blockchain/internal/persistence"
)

func main() {
	fmt.Println("╔══════════════════════════════════════════╗")
	fmt.Println("║     ZK Voting Blockchain Node            ║")
	fmt.Println("║     Stage 1: Foundation Demo             ║")
	fmt.Println("╚══════════════════════════════════════════╝")
	fmt.Println()

	dataDir := "data"
	store := persistence.NewFileStore(dataDir)

	var bc *core.Blockchain

	// Try to load existing chain, or create a new one
	if store.Exists() {
		fmt.Println("Found existing blockchain, loading...")
		loaded, err := store.LoadBlockchain()
		if err != nil {
			log.Fatalf("Failed to load blockchain: %v", err)
		}
		bc = loaded
		fmt.Printf("Loaded chain with %d blocks\n\n", bc.Len())
	} else {
		fmt.Println("No existing chain found, creating new blockchain...")
		bc = core.NewBlockchain("Do you support this proposal?")
		fmt.Println("Genesis block created")
		fmt.Println()

		// === DEMO: Simulate a voting workflow ===
		fmt.Println("Simulating voting workflow...")
		fmt.Println()

		// Step 1: Admin adds voters
		fmt.Println("Step 1: Admin adds voters to allowlist")
		voters := []string{"alice", "bob", "charlie"}
		for _, voter := range voters {
			tx, err := core.NewTransaction(core.TxAddVoter, core.AddVoterPayload{
				VoterID: voter,
				Allowed: true,
			})
			if err != nil {
				log.Fatalf("Failed to create ADD_VOTER tx: %v", err)
			}
			block, err := bc.AddTransaction(tx)
			if err != nil {
				log.Fatalf("Failed to add block: %v", err)
			}
			fmt.Printf("  ✓ Added voter '%s' in block #%d\n", voter, block.Index)
		}
		fmt.Println()

		// Step 2: Voters register commitments
		fmt.Println("Step 2: Voters register commitments")
		commitments := map[string]string{
			"alice":   "0x1a2b3c4d5e6f7890abcdef1234567890abcdef1234567890abcdef1234567890",
			"bob":     "0x2b3c4d5e6f7890ab1234567890abcdef1234567890abcdef1234567890abcdef",
			"charlie": "0x3c4d5e6f7890abcd234567890abcdef1234567890abcdef1234567890abcdef12",
		}
		leafIndex := uint64(0)
		for voter, commitment := range commitments {
			tx, err := core.NewTransaction(core.TxRegister, core.RegisterPayload{
				VoterID:    voter,
				Commitment: commitment,
				LeafIndex:  leafIndex,
			})
			if err != nil {
				log.Fatalf("Failed to create REGISTER tx: %v", err)
			}
			block, err := bc.AddTransaction(tx)
			if err != nil {
				log.Fatalf("Failed to add block: %v", err)
			}
			fmt.Printf("  ✓ Registered '%s' commitment (leaf %d) in block #%d\n",
				voter, leafIndex, block.Index)
			leafIndex++
		}
		fmt.Println()

		// Step 3: Anonymous votes (no voter identity!)
		fmt.Println("Step 3: Anonymous votes with ZK proofs")
		votes := []core.VotePayload{
			{
				Proof:         "0xproof_aaa111",
				NullifierHash: "0xnull_hash_1",
				Root:          "0xmerkle_root",
				Vote:          true, // Yes
				Depth:         2,
			},
			{
				Proof:         "0xproof_bbb222",
				NullifierHash: "0xnull_hash_2",
				Root:          "0xmerkle_root",
				Vote:          false, // No
				Depth:         2,
			},
			{
				Proof:         "0xproof_ccc333",
				NullifierHash: "0xnull_hash_3",
				Root:          "0xmerkle_root",
				Vote:          true, // Yes
				Depth:         2,
			},
		}
		for i, vote := range votes {
			tx, err := core.NewTransaction(core.TxVote, vote)
			if err != nil {
				log.Fatalf("Failed to create VOTE tx: %v", err)
			}
			block, err := bc.AddTransaction(tx)
			if err != nil {
				log.Fatalf("Failed to add block: %v", err)
			}
			choice := "No"
			if vote.Vote {
				choice = "Yes"
			}
			fmt.Printf("  ✓ Vote #%d: %s (nullifier: %s...) in block #%d\n",
				i+1, choice, vote.NullifierHash[:12], block.Index)
		}
		fmt.Println()
	}

	// === Validate chain integrity ===
	fmt.Println("Validating chain integrity...")
	if err := bc.ValidateChain(); err != nil {
		log.Fatalf("❌ Chain validation FAILED: %v", err)
	}
	fmt.Println("Chain is valid — all hashes verified, all links intact")
	fmt.Println()

	// === Print chain summary ===
	bc.PrintChain()

	// === Transaction statistics ===
	fmt.Println("Transaction Summary:")
	addVoterTxs := bc.GetAllTransactions(core.TxAddVoter)
	registerTxs := bc.GetAllTransactions(core.TxRegister)
	voteTxs := bc.GetAllTransactions(core.TxVote)
	fmt.Printf("  ADD_VOTER:  %d transactions\n", len(addVoterTxs))
	fmt.Printf("  REGISTER:   %d transactions\n", len(registerTxs))
	fmt.Printf("  VOTE:       %d transactions\n", len(voteTxs))

	// Count votes
	yesVotes, noVotes := 0, 0
	for _, tx := range voteTxs {
		var payload core.VotePayload
		if err := tx.ParsePayload(&payload); err == nil {
			if payload.Vote {
				yesVotes++
			} else {
				noVotes++
			}
		}
	}
	fmt.Printf("\n  📗 Yes: %d    📕 No: %d\n", yesVotes, noVotes)
	fmt.Println()

	// === Save to disk ===
	fmt.Println("Saving blockchain to disk...")
	if err := store.SaveBlockchain(bc); err != nil {
		log.Fatalf("❌ Failed to save: %v", err)
	}
	fmt.Printf("Saved to %s\n\n", store.FilePath())

	// === Verify persistence ===
	fmt.Println("Verifying persistence (reload from disk)...")
	loaded, err := store.LoadBlockchain()
	if err != nil {
		log.Fatalf("❌ Failed to reload: %v", err)
	}
	if loaded.Len() != bc.Len() {
		log.Fatalf("❌ Reloaded chain has %d blocks (expected %d)", loaded.Len(), bc.Len())
	}
	if err := loaded.ValidateChain(); err != nil {
		log.Fatalf("❌ Reloaded chain validation failed: %v", err)
	}
	fmt.Printf("Reloaded %d blocks — chain integrity verified\n\n", loaded.Len())

	os.Exit(0)
}
