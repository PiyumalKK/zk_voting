package evm

import (
	"testing"

	"zk-blockchain/internal/core"
)

// newTestBlockchain creates a fresh 4-block chain:
//   Block 0 (genesis, candidates ["Yes", "No"])
//   Block 1: ADD_VOTER          alice@example.com
//   Block 2: START_REGISTRATION (Setup → Registration; addVoters only works in Setup,
//                                register only works in Registration)
//   Block 3: REGISTER           alice@example.com with sampleCommitmentHex
func newTestBlockchain(t *testing.T) *core.Blockchain {
	t.Helper()
	bc := core.NewBlockchain("Test voting question", []string{"Yes", "No"})

	addTx, err := core.NewTransaction(core.TxAddVoter, core.AddVoterPayload{
		VoterID: "alice@example.com",
		Allowed: true,
	})
	if err != nil {
		t.Fatalf("NewTransaction ADD_VOTER: %v", err)
	}
	if _, err := bc.AddTransaction(addTx); err != nil {
		t.Fatalf("AddTransaction ADD_VOTER: %v", err)
	}

	startRegTx, err := core.NewTransaction(core.TxStartRegistration, core.StartRegistrationPayload{
		DurationSec: 3600,
	})
	if err != nil {
		t.Fatalf("NewTransaction START_REGISTRATION: %v", err)
	}
	if _, err := bc.AddTransaction(startRegTx); err != nil {
		t.Fatalf("AddTransaction START_REGISTRATION: %v", err)
	}

	regTx, err := core.NewTransaction(core.TxRegister, core.RegisterPayload{
		VoterID:    "alice@example.com",
		Commitment: sampleCommitmentHex,
		LeafIndex:  0,
	})
	if err != nil {
		t.Fatalf("NewTransaction REGISTER: %v", err)
	}
	if _, err := bc.AddTransaction(regTx); err != nil {
		t.Fatalf("AddTransaction REGISTER: %v", err)
	}

	return bc
}

func TestReplayBlockchain_GenesisOnly(t *testing.T) {
	bridge := newTestBridge(t)
	bc := core.NewBlockchain("Replay test", []string{"Yes", "No"})

	// Should complete without panicking or returning errors.
	ReplayBlockchain(bc, bridge)

	// EVM state: no registrations, no votes.
	data, err := bridge.GetVotingData()
	if err != nil {
		t.Fatalf("GetVotingData: %v", err)
	}
	if data.TreeSize.Sign() != 0 {
		t.Errorf("expected empty tree after genesis-only replay, got size %s", data.TreeSize)
	}
}

func TestReplayBlockchain_AddVoterAndRegister(t *testing.T) {
	bridge := newTestBridge(t)
	bc := newTestBlockchain(t)

	ReplayBlockchain(bc, bridge)

	// Voter should be allowed and registered after replay.
	voterData, err := bridge.GetVoterData("alice@example.com")
	if err != nil {
		t.Fatalf("GetVoterData: %v", err)
	}
	if !voterData.Allowed {
		t.Error("voter should be allowed after replaying ADD_VOTER block")
	}
	if !voterData.Registered {
		t.Error("voter should be registered after replaying REGISTER block")
	}

	// Merkle tree should have one leaf.
	votingData, err := bridge.GetVotingData()
	if err != nil {
		t.Fatalf("GetVotingData: %v", err)
	}
	if votingData.TreeSize.Sign() != 1 {
		t.Errorf("tree size should be 1 after one REGISTER, got %s", votingData.TreeSize)
	}
}

func TestReplayBlockchain_InvalidVoteIsSkipped(t *testing.T) {
	bridge := newTestBridge(t)

	// Build a chain that has a VOTE transaction with a fake proof.
	// In Stage 1/2, votes were committed without EVM verification.
	bc := core.NewBlockchain("Replay with invalid vote", []string{"Yes", "No"})

	// Add, open registration, and register a voter so the tree is non-empty.
	addTx, _ := core.NewTransaction(core.TxAddVoter, core.AddVoterPayload{VoterID: "alice@example.com", Allowed: true})
	bc.AddTransaction(addTx)
	startRegTx, _ := core.NewTransaction(core.TxStartRegistration, core.StartRegistrationPayload{DurationSec: 3600})
	bc.AddTransaction(startRegTx)
	regTx, _ := core.NewTransaction(core.TxRegister, core.RegisterPayload{
		VoterID: "alice@example.com", Commitment: sampleCommitmentHex, LeafIndex: 0,
	})
	bc.AddTransaction(regTx)

	// A VOTE transaction with a garbage proof (invalid ZK proof). Also submitted
	// before START_VOTING, so it would be rejected on phase grounds alone even if
	// the proof were valid — either way, it must be skipped, not applied.
	voteTx, _ := core.NewTransaction(core.TxVote, core.VotePayload{
		Proof:          "0xdeadbeef",
		NullifierHash:  "0x0000000000000000000000000000000000000000000000000000000000000001",
		Root:           "0x0000000000000000000000000000000000000000000000000000000000000001",
		CandidateIndex: 0,
		Depth:          1,
	})
	bc.AddTransaction(voteTx)

	// Replay must not panic. The invalid vote is logged as a warning and skipped.
	ReplayBlockchain(bc, bridge)

	// Vote counts should still be all zero since the vote was never applied.
	counts, err := bridge.GetVoteCounts()
	if err != nil {
		t.Fatalf("GetVoteCounts: %v", err)
	}
	for i, c := range counts {
		if c.Sign() != 0 {
			t.Errorf("invalid vote should not increment counters: candidate %d has %s votes", i, c)
		}
	}
}

func TestReplayTransaction_UnknownType(t *testing.T) {
	bridge := newTestBridge(t)

	// An unknown transaction type (e.g., future extension) must be silently ignored.
	tx, _ := core.NewTransaction("UNKNOWN_TYPE", map[string]string{"foo": "bar"})
	if err := bridge.ReplayTransaction(*tx, testNow()); err != nil {
		t.Errorf("unknown tx type should be silently ignored, got: %v", err)
	}
}
