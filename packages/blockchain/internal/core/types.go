package core

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"
)

// TxType represents the type of blockchain transaction.
type TxType string

const (
	// TxAddVoter is used by the admin to add/remove voters from the allowlist.
	// Only effective during Phase.Setup (see Voting.sol).
	TxAddVoter TxType = "ADD_VOTER"

	// TxRegister is used by a voter to register their Poseidon commitment
	// into the on-chain Merkle tree. Only effective during Phase.Registration.
	TxRegister TxType = "REGISTER"

	// TxVote is used to submit an anonymous vote with a ZK proof.
	// This transaction requires NO identity — the ZK proof IS the authentication.
	// Only effective during Phase.Voting.
	TxVote TxType = "VOTE"

	// TxSetQuestion updates the ballot question. Only effective during Phase.Setup.
	TxSetQuestion TxType = "SET_QUESTION"

	// TxSetCandidates replaces the candidate list. Only effective during Phase.Setup.
	TxSetCandidates TxType = "SET_CANDIDATES"

	// TxStartRegistration moves Setup → Registration and opens a registration window.
	TxStartRegistration TxType = "START_REGISTRATION"

	// TxStartVoting moves Registration → Voting and opens a voting window.
	TxStartVoting TxType = "START_VOTING"

	// TxEndElection ends the election early (Registration or Voting → Ended).
	TxEndElection TxType = "END_ELECTION"

	// TxResetElection clears all election state (voters, registrations, votes,
	// question, candidates) and returns to Phase.Setup, starting a new election.
	TxResetElection TxType = "RESET_ELECTION"
)

// Transaction represents a single operation on the voting blockchain.
// Each transaction is hashed for tamper detection and linked into a block.
type Transaction struct {
	ID        string          `json:"id"`        // Short identifier (first 16 chars of hash)
	Type      TxType          `json:"type"`      // Transaction type
	Timestamp int64           `json:"timestamp"` // Unix milliseconds
	Payload   json.RawMessage `json:"payload"`   // Type-specific data
	Hash      string          `json:"hash"`      // SHA-256 of transaction content
}

// NewTransaction creates a new transaction with a computed SHA-256 hash.
// The payload is marshaled to JSON and included in the hash computation.
func NewTransaction(txType TxType, payload interface{}) (*Transaction, error) {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal payload: %w", err)
	}

	tx := &Transaction{
		Type:      txType,
		Timestamp: time.Now().UnixMilli(),
		Payload:   payloadBytes,
	}

	tx.Hash = tx.computeHash()
	tx.ID = tx.Hash[:16] // Short ID from hash prefix

	return tx, nil
}

// computeHash generates a SHA-256 hash of the transaction's content.
// Hash covers: type, timestamp, and payload — ensuring any change is detected.
// The payload is compacted (whitespace removed) before hashing to ensure
// deterministic hashes after JSON serialization round-trips.
func (tx *Transaction) computeHash() string {
	// Compact the payload to normalize whitespace
	var buf bytes.Buffer
	if err := json.Compact(&buf, tx.Payload); err != nil {
		// Fallback: use raw payload if compaction fails
		buf.Reset()
		buf.Write(tx.Payload)
	}

	data := fmt.Sprintf("%s:%d:%s", tx.Type, tx.Timestamp, buf.String())
	hash := sha256.Sum256([]byte(data))
	return hex.EncodeToString(hash[:])
}

// VerifyHash checks whether the stored hash matches the recomputed hash.
// Returns false if the transaction data has been tampered with.
func (tx *Transaction) VerifyHash() bool {
	return tx.Hash == tx.computeHash()
}

// --- Payload types for each transaction type ---

// AddVoterPayload is the data for TxAddVoter transactions.
// The admin can add or revoke a voter's eligibility.
type AddVoterPayload struct {
	VoterID string `json:"voter_id"` // Unique voter identifier
	Allowed bool   `json:"allowed"`  // true = add to allowlist, false = revoke
}

// RegisterPayload is the data for TxRegister transactions.
// Contains the voter's Poseidon commitment to be inserted into the Merkle tree.
type RegisterPayload struct {
	VoterID    string `json:"voter_id"`    // Voter who is registering
	Commitment string `json:"commitment"`  // Hex-encoded Poseidon2([nullifier, secret])
	LeafIndex  uint64 `json:"leaf_index"`  // Position in Merkle tree (assigned by state)
}

// VotePayload is the data for TxVote transactions.
// Contains the ZK proof and public inputs — NO voter identity.
type VotePayload struct {
	Proof          string `json:"proof"`           // Hex-encoded ZK proof bytes
	NullifierHash  string `json:"nullifier_hash"`  // Hex-encoded nullifier hash (prevents double-vote)
	Root           string `json:"root"`            // Hex-encoded Merkle root (proof was generated against)
	CandidateIndex uint64 `json:"candidate_index"` // Index into the candidate list (0-based)
	Depth          uint32 `json:"depth"`           // Merkle tree depth at proof generation time
}

// GenesisPayload is the data embedded in the genesis block.
// It records the voting question and initial configuration.
type GenesisPayload struct {
	Action     string   `json:"action"`     // Always "GENESIS"
	Question   string   `json:"question"`   // The voting question
	Candidates []string `json:"candidates"` // Initial candidate list (may be empty; set later via SET_CANDIDATES)
	Version    string   `json:"version"`    // Protocol version
}

// SetQuestionPayload is the data for TxSetQuestion transactions.
type SetQuestionPayload struct {
	Question string `json:"question"`
}

// SetCandidatesPayload is the data for TxSetCandidates transactions.
type SetCandidatesPayload struct {
	Candidates []string `json:"candidates"`
}

// StartRegistrationPayload is the data for TxStartRegistration transactions.
type StartRegistrationPayload struct {
	DurationSec uint64 `json:"duration_sec"` // Length of the registration window
}

// StartVotingPayload is the data for TxStartVoting transactions.
type StartVotingPayload struct {
	DurationSec uint64 `json:"duration_sec"` // Length of the voting window
}

// ParsePayload unmarshals the transaction's JSON payload into the given struct.
func (tx *Transaction) ParsePayload(target interface{}) error {
	return json.Unmarshal(tx.Payload, target)
}
