package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"zk-blockchain/internal/core"
	"zk-blockchain/internal/persistence"
)

// Global blockchain reference (simple for Phase 1)
var bc *core.Blockchain
var store *persistence.FileStore

// InitServer sets up blockchain + storage
func InitServer(blockchain *core.Blockchain, fs *persistence.FileStore) {
	bc = blockchain
	store = fs
}

// StartServer starts the HTTP node
func StartServer(port string) {
	http.HandleFunc("/health", handleHealth)
	http.HandleFunc("/chain", handleGetChain)
	http.HandleFunc("/blocks", handleGetBlocks)

	// voting-related (Phase 1 test endpoints)
	http.HandleFunc("/add-voter", handleAddVoter)
	http.HandleFunc("/register", handleRegister)
	http.HandleFunc("/vote", handleVote)

	fmt.Println("🌐 Blockchain Node running on", port)
	log.Fatal(http.ListenAndServe(port, nil))
}

/*
========================
        HANDLERS
========================
*/

func handleHealth(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(map[string]string{
		"status": "ok",
	})
}

func handleGetChain(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	json.NewEncoder(w).Encode(map[string]interface{}{
		"length": len(bc.GetBlocks()),
		"blocks": bc.GetBlocks(),
	})
}

func handleGetBlocks(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(bc.GetBlocks())
}

/*
========================
   TEST API (PHASE 1)
========================
*/

type AddVoterRequest struct {
	VoterID string `json:"voter_id"`
}

func handleAddVoter(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	var req AddVoterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	tx, err := core.NewTransaction(core.TxAddVoter, core.AddVoterPayload{
		VoterID: req.VoterID,
		Allowed: true,
	})
	if err != nil {
		http.Error(w, "tx error", http.StatusInternalServerError)
		return
	}

	block, err := bc.AddTransaction(tx)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	_ = store.SaveBlockchain(bc)

	json.NewEncoder(w).Encode(block)
}

/*
========================
 REGISTER (dummy Phase 1)
========================
*/

type RegisterRequest struct {
	VoterID    string `json:"voter_id"`
	Commitment string `json:"commitment"`
}

func handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	var req RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	tx, err := core.NewTransaction(core.TxRegister, core.RegisterPayload{
		VoterID:    req.VoterID,
		Commitment: req.Commitment,
		LeafIndex:  uint64(len(bc.GetBlocks())),
	})
	if err != nil {
		http.Error(w, "tx error", http.StatusInternalServerError)
		return
	}

	block, err := bc.AddTransaction(tx)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	_ = store.SaveBlockchain(bc)

	json.NewEncoder(w).Encode(block)
}

/*
========================
 VOTE (mock for Phase 1)
========================
*/

type VoteRequest struct {
	Proof         string `json:"proof"`
	NullifierHash string `json:"nullifier_hash"`
	Vote          bool   `json:"vote"`
}

func handleVote(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	var req VoteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	tx, err := core.NewTransaction(core.TxVote, core.VotePayload{
		Proof:         req.Proof,
		NullifierHash: req.NullifierHash,
		Root:          "demo_root",
		Vote:          req.Vote,
		Depth:         2,
	})
	if err != nil {
		http.Error(w, "tx error", http.StatusInternalServerError)
		return
	}

	block, err := bc.AddTransaction(tx)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	_ = store.SaveBlockchain(bc)

	json.NewEncoder(w).Encode(block)
}