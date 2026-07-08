package evm

import (
	"fmt"
	"math/big"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"zk-blockchain/internal/core"
)

// testNow returns the current wall clock as the unix-seconds blockTime that
// every bridge write method now requires (see ContractCaller.SetTime).
func testNow() uint64 {
	return uint64(time.Now().Unix())
}

// assetsDir returns the path to the compiled contract artifacts.
// Tests are run from the package directory, so we navigate up to find assets/.
func assetsDir(t *testing.T) string {
	t.Helper()
	// __file__ is the absolute path to this test file.
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not determine test file path")
	}
	// internal/evm/bridge_test.go → ../../assets
	dir := filepath.Join(filepath.Dir(file), "..", "..", "assets")
	return filepath.Clean(dir)
}

// newTestBridge creates a fresh in-memory EVM and deploys the Voting + HonkVerifier
// contracts with two default candidates ["Yes", "No"] (mirroring
// packages/hardhat/deploy/00_deploy_your_contract.ts). It skips the test if the
// artifact files are not present. The returned bridge starts in Phase.Setup —
// tests that need Phase.Registration must call bridge.StartRegistration(...)
// themselves (typically after any AddVoter calls, which only work in Setup).
func newTestBridge(t *testing.T) *ContractBridge {
	t.Helper()
	assets := assetsDir(t)

	sm, err := NewStateManager()
	if err != nil {
		t.Fatalf("NewStateManager: %v", err)
	}
	evmInst := CreateStatelessEVM(sm.GetStateDB())
	caller := NewContractCaller(evmInst)

	bridge, err := NewContractBridge(caller, assets, "Should we proceed?", []string{"Yes", "No"})
	if err != nil {
		// If the artifact files are missing, skip rather than fail.
		t.Skipf("skipping bridge tests — artifacts unavailable (%v)", err)
	}
	return bridge
}

// ─── Deployment ───────────────────────────────────────────────────────────────

func TestNewContractBridge_Deploy(t *testing.T) {
	bridge := newTestBridge(t)

	if bridge.VotingAddress() == (common.Address{}) {
		t.Error("VotingAddress is zero — deployment failed")
	}
}

func TestNewContractBridge_MissingArtifacts(t *testing.T) {
	sm, _ := NewStateManager()
	caller := NewContractCaller(CreateStatelessEVM(sm.GetStateDB()))

	_, err := NewContractBridge(caller, "/nonexistent/path", "question", []string{"Yes", "No"})
	if err == nil {
		t.Error("expected error for missing artifacts, got nil")
	}
}

// ─── VoterIDToAddress ─────────────────────────────────────────────────────────

func TestVoterIDToAddress_Deterministic(t *testing.T) {
	a1 := VoterIDToAddress("alice@example.com")
	a2 := VoterIDToAddress("alice@example.com")
	if a1 != a2 {
		t.Errorf("expected same address for same voter ID, got %s vs %s", a1.Hex(), a2.Hex())
	}
}

func TestVoterIDToAddress_Unique(t *testing.T) {
	a := VoterIDToAddress("alice@example.com")
	b := VoterIDToAddress("bob@example.com")
	if a == b {
		t.Error("different voter IDs produced the same Ethereum address")
	}
}

func TestVoterIDToAddress_NonZero(t *testing.T) {
	addr := VoterIDToAddress("voter@test.com")
	if addr == (common.Address{}) {
		t.Error("VoterIDToAddress returned zero address")
	}
}

// ─── AddVoter ─────────────────────────────────────────────────────────────────

func TestAddVoter_Success(t *testing.T) {
	bridge := newTestBridge(t)

	if err := bridge.AddVoter("alice@example.com", true, testNow()); err != nil {
		t.Fatalf("AddVoter failed: %v", err)
	}

	// Verify: getVoterData should show voter as allowed.
	data, err := bridge.GetVoterData("alice@example.com")
	if err != nil {
		t.Fatalf("GetVoterData failed: %v", err)
	}
	if !data.Allowed {
		t.Error("voter should be allowed after AddVoter(true)")
	}
	if data.Registered {
		t.Error("voter should not be registered before Register()")
	}
}

func TestAddVoter_Revoke(t *testing.T) {
	bridge := newTestBridge(t)

	// Add then revoke.
	if err := bridge.AddVoter("alice@example.com", true, testNow()); err != nil {
		t.Fatalf("AddVoter(true): %v", err)
	}
	if err := bridge.AddVoter("alice@example.com", false, testNow()); err != nil {
		t.Fatalf("AddVoter(false): %v", err)
	}

	data, err := bridge.GetVoterData("alice@example.com")
	if err != nil {
		t.Fatalf("GetVoterData: %v", err)
	}
	if data.Allowed {
		t.Error("voter should not be allowed after AddVoter(false)")
	}
}

// ─── Register ────────────────────────────────────────────────────────────────

// sampleCommitmentHex is a valid field element (< BN254 scalar field modulus).
const sampleCommitmentHex = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"

func TestRegister_Success(t *testing.T) {
	bridge := newTestBridge(t)

	// Must add voter first (Setup phase), then open registration.
	if err := bridge.AddVoter("alice@example.com", true, testNow()); err != nil {
		t.Fatalf("AddVoter: %v", err)
	}
	if err := bridge.StartRegistration(3600, testNow()); err != nil {
		t.Fatalf("StartRegistration: %v", err)
	}

	leafIndex, err := bridge.Register("alice@example.com", sampleCommitmentHex, testNow())
	if err != nil {
		t.Fatalf("Register failed: %v", err)
	}
	if leafIndex != 0 {
		t.Errorf("expected leaf index 0 for first registration, got %d", leafIndex)
	}

	// Verify: voter should now be marked as registered.
	data, err := bridge.GetVoterData("alice@example.com")
	if err != nil {
		t.Fatalf("GetVoterData: %v", err)
	}
	if !data.Registered {
		t.Error("voter should be registered after Register()")
	}
}

func TestRegister_NotAllowed(t *testing.T) {
	bridge := newTestBridge(t)

	if err := bridge.StartRegistration(3600, testNow()); err != nil {
		t.Fatalf("StartRegistration: %v", err)
	}

	// Attempt registration without adding voter first.
	_, err := bridge.Register("bob@example.com", sampleCommitmentHex, testNow())
	if err == nil {
		t.Error("expected error for unallowlisted voter, got nil")
	}
}

func TestRegister_DuplicateCommitment(t *testing.T) {
	bridge := newTestBridge(t)

	if err := bridge.AddVoter("alice@example.com", true, testNow()); err != nil {
		t.Fatalf("AddVoter alice: %v", err)
	}
	if err := bridge.AddVoter("bob@example.com", true, testNow()); err != nil {
		t.Fatalf("AddVoter bob: %v", err)
	}
	if err := bridge.StartRegistration(3600, testNow()); err != nil {
		t.Fatalf("StartRegistration: %v", err)
	}

	// Register alice with the commitment.
	if _, err := bridge.Register("alice@example.com", sampleCommitmentHex, testNow()); err != nil {
		t.Fatalf("Register alice: %v", err)
	}

	// Bob tries to register with the same commitment — must be rejected.
	_, err := bridge.Register("bob@example.com", sampleCommitmentHex, testNow())
	if err == nil {
		t.Error("expected error for duplicate commitment, got nil")
	}
}

func TestRegister_AlreadyRegistered(t *testing.T) {
	bridge := newTestBridge(t)

	if err := bridge.AddVoter("alice@example.com", true, testNow()); err != nil {
		t.Fatalf("AddVoter: %v", err)
	}
	if err := bridge.StartRegistration(3600, testNow()); err != nil {
		t.Fatalf("StartRegistration: %v", err)
	}
	if _, err := bridge.Register("alice@example.com", sampleCommitmentHex, testNow()); err != nil {
		t.Fatalf("Register first time: %v", err)
	}

	// Second registration for the same voter must be rejected.
	differentCommitment := "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	_, err := bridge.Register("alice@example.com", differentCommitment, testNow())
	if err == nil {
		t.Error("expected error for already-registered voter, got nil")
	}
}

// ─── Phase gating & election lifecycle ──────────────────────────────────────────

// TestRegister_WrongPhase verifies that register() is rejected while still in
// Phase.Setup (StartRegistration was never called), mirroring Voting.sol's
// inPhase(Phase.Registration) modifier.
func TestRegister_WrongPhase(t *testing.T) {
	bridge := newTestBridge(t)

	if err := bridge.AddVoter("alice@example.com", true, testNow()); err != nil {
		t.Fatalf("AddVoter: %v", err)
	}
	// No StartRegistration call — still in Phase.Setup.

	_, err := bridge.Register("alice@example.com", sampleCommitmentHex, testNow())
	if err == nil {
		t.Fatal("expected Register to be rejected outside Phase.Registration, got nil")
	}
}

// TestVote_WrongPhase verifies that vote() is rejected while in Phase.Registration
// (StartVoting was never called), mirroring Voting.sol's inPhase(Phase.Voting)
// modifier. Uses a garbage proof — the point is that the phase check fires before
// the proof is ever verified, so any error is expected regardless of proof validity.
func TestVote_WrongPhase(t *testing.T) {
	bridge := newTestBridge(t)

	if err := bridge.StartRegistration(3600, testNow()); err != nil {
		t.Fatalf("StartRegistration: %v", err)
	}
	// No StartVoting call — still in Phase.Registration.

	err := bridge.Vote(
		"0xdeadbeef",
		"0x0000000000000000000000000000000000000000000000000000000000000001",
		"0x0000000000000000000000000000000000000000000000000000000000000001",
		0, 1, testNow(),
	)
	if err == nil {
		t.Fatal("expected Vote to be rejected outside Phase.Voting, got nil")
	}
}

// TestResetElection_ClearsVoterCache verifies that ResetElection wipes the ENTIRE
// voterDataCache (not just one key), because the contract's electionId bump means
// every previously cached voter's allowed/registered flags belong to a dead
// election. Without this, a voter added before a reset would incorrectly keep
// reading back as allowed after the reset, even though the contract itself
// correctly reports them as not-allowed in the new election.
func TestResetElection_ClearsVoterCache(t *testing.T) {
	bridge := newTestBridge(t)

	if err := bridge.AddVoter("alice@example.com", true, testNow()); err != nil {
		t.Fatalf("AddVoter: %v", err)
	}
	before, err := bridge.GetVoterData("alice@example.com")
	if err != nil {
		t.Fatalf("GetVoterData (before): %v", err)
	}
	if !before.Allowed {
		t.Fatal("expected voter to be allowed before reset")
	}

	if err := bridge.ResetElection(testNow()); err != nil {
		t.Fatalf("ResetElection: %v", err)
	}

	after, err := bridge.GetVoterData("alice@example.com")
	if err != nil {
		t.Fatalf("GetVoterData (after): %v", err)
	}
	if after.Allowed {
		t.Error("expected voter to read back as not-allowed after ResetElection — cache was not cleared")
	}

	// The contract itself should also be back in Phase.Setup with zero candidates.
	data, err := bridge.GetVotingData()
	if err != nil {
		t.Fatalf("GetVotingData: %v", err)
	}
	if data.Phase != PhaseSetup {
		t.Errorf("expected Phase.Setup after reset, got %s", data.PhaseLabel)
	}
	if data.CandidateCount.Sign() != 0 {
		t.Errorf("expected 0 candidates after reset, got %s", data.CandidateCount)
	}
}

// TestElectionLifecycle_FullCycle drives one full election through every phase
// via the bridge's admin methods, mirroring packages/nextjs/app/voting/admin/page.tsx's
// button sequence: setCandidates → addVoters → startRegistration → startVoting →
// endElection. Verifies phase and candidate/vote-count reads at each step.
func TestElectionLifecycle_FullCycle(t *testing.T) {
	bridge := newTestBridge(t)

	if err := bridge.SetCandidates([]string{"Alice", "Bob", "Carol"}, testNow()); err != nil {
		t.Fatalf("SetCandidates: %v", err)
	}
	candidates, err := bridge.GetCandidates()
	if err != nil {
		t.Fatalf("GetCandidates: %v", err)
	}
	if len(candidates) != 3 || candidates[0] != "Alice" {
		t.Fatalf("expected [Alice Bob Carol], got %v", candidates)
	}

	if err := bridge.AddVoter("alice@example.com", true, testNow()); err != nil {
		t.Fatalf("AddVoter: %v", err)
	}

	if err := bridge.StartRegistration(3600, testNow()); err != nil {
		t.Fatalf("StartRegistration: %v", err)
	}
	data, err := bridge.GetVotingData()
	if err != nil {
		t.Fatalf("GetVotingData: %v", err)
	}
	if data.Phase != PhaseRegistration {
		t.Fatalf("expected Phase.Registration, got %s", data.PhaseLabel)
	}

	if _, err := bridge.Register("alice@example.com", sampleCommitmentHex, testNow()); err != nil {
		t.Fatalf("Register: %v", err)
	}

	if err := bridge.StartVoting(3600, testNow()); err != nil {
		t.Fatalf("StartVoting: %v", err)
	}
	data, err = bridge.GetVotingData()
	if err != nil {
		t.Fatalf("GetVotingData: %v", err)
	}
	if data.Phase != PhaseVoting {
		t.Fatalf("expected Phase.Voting, got %s", data.PhaseLabel)
	}

	if err := bridge.EndElection(testNow()); err != nil {
		t.Fatalf("EndElection: %v", err)
	}
	data, err = bridge.GetVotingData()
	if err != nil {
		t.Fatalf("GetVotingData: %v", err)
	}
	if data.Phase != PhaseEnded {
		t.Fatalf("expected Phase.Ended, got %s", data.PhaseLabel)
	}

	counts, err := bridge.GetVoteCounts()
	if err != nil {
		t.Fatalf("GetVoteCounts: %v", err)
	}
	if len(counts) != 3 {
		t.Fatalf("expected 3 vote counts (one per candidate), got %d", len(counts))
	}
}

// ─── Time-based phase expiry ────────────────────────────────────────────────────

// TestPhaseAutoExpires verifies the EVM clock actually advances: a registration
// window opened in the past (blockTime backdated) must read back as Ended when
// queried at the current wall clock — behavior a frozen BlockContext.Time (the
// pre-fix state, hardcoded Time: 1) could never produce.
func TestPhaseAutoExpires(t *testing.T) {
	bridge := newTestBridge(t)

	// Open a 5-second registration window as if it happened 60 seconds ago.
	past := testNow() - 60
	if err := bridge.StartRegistration(5, past); err != nil {
		t.Fatalf("StartRegistration: %v", err)
	}

	// GetVotingData stamps the EVM clock with the current wall time, so the
	// contract's view logic must report the window as expired.
	data, err := bridge.GetVotingData()
	if err != nil {
		t.Fatalf("GetVotingData: %v", err)
	}
	if data.Phase != PhaseEnded {
		t.Errorf("expected Phase.Ended for an expired registration window, got %s", data.PhaseLabel)
	}
}

// TestPhaseStillOpenWithinWindow is the control for TestPhaseAutoExpires: a
// window opened just now must still read back as Registration.
func TestPhaseStillOpenWithinWindow(t *testing.T) {
	bridge := newTestBridge(t)

	if err := bridge.StartRegistration(3600, testNow()); err != nil {
		t.Fatalf("StartRegistration: %v", err)
	}
	data, err := bridge.GetVotingData()
	if err != nil {
		t.Fatalf("GetVotingData: %v", err)
	}
	if data.Phase != PhaseRegistration {
		t.Errorf("expected Phase.Registration inside an open window, got %s", data.PhaseLabel)
	}
}

// TestGetVotingData_InvalidatedByRegister verifies that a read after Register()
// reflects the new tree size (VotingData is never cached — see the
// voterDataCache comment in bridge.go for why).
func TestGetVotingData_InvalidatedByRegister(t *testing.T) {
	bridge := newTestBridge(t)

	if err := bridge.AddVoter("alice@example.com", true, testNow()); err != nil {
		t.Fatalf("AddVoter: %v", err)
	}
	before, err := bridge.GetVotingData()
	if err != nil {
		t.Fatalf("GetVotingData (before): %v", err)
	}
	if before.TreeSize.Sign() != 0 {
		t.Fatalf("expected empty tree before registration, got %s", before.TreeSize)
	}

	if err := bridge.StartRegistration(3600, testNow()); err != nil {
		t.Fatalf("StartRegistration: %v", err)
	}
	if _, err := bridge.Register("alice@example.com", sampleCommitmentHex, testNow()); err != nil {
		t.Fatalf("Register: %v", err)
	}

	after, err := bridge.GetVotingData()
	if err != nil {
		t.Fatalf("GetVotingData (after): %v", err)
	}
	if before == after {
		t.Error("expected a freshly fetched VotingData after Register invalidated the cache")
	}
	if after.TreeSize.Cmp(big.NewInt(1)) != 0 {
		t.Errorf("expected tree size 1 after registration, got %s", after.TreeSize)
	}
}

// TestGetVoterData_Cached mirrors TestGetVotingData_Cached for the per-voter cache.
func TestGetVoterData_Cached(t *testing.T) {
	bridge := newTestBridge(t)

	if err := bridge.AddVoter("alice@example.com", true, testNow()); err != nil {
		t.Fatalf("AddVoter: %v", err)
	}
	first, err := bridge.GetVoterData("alice@example.com")
	if err != nil {
		t.Fatalf("GetVoterData (1st): %v", err)
	}
	second, err := bridge.GetVoterData("alice@example.com")
	if err != nil {
		t.Fatalf("GetVoterData (2nd): %v", err)
	}
	if first != second {
		t.Error("expected cached VoterData pointer to be reused when nothing changed")
	}
}

// TestGetVoterData_InvalidatedByAddVoter verifies that AddVoter() invalidates
// only the affected voter's cache entry, so a subsequent read reflects the new
// Allowed status instead of a stale cached value.
func TestGetVoterData_InvalidatedByAddVoter(t *testing.T) {
	bridge := newTestBridge(t)

	before, err := bridge.GetVoterData("alice@example.com")
	if err != nil {
		t.Fatalf("GetVoterData (before): %v", err)
	}
	if before.Allowed {
		t.Fatal("expected voter to not be allowed before AddVoter")
	}

	if err := bridge.AddVoter("alice@example.com", true, testNow()); err != nil {
		t.Fatalf("AddVoter: %v", err)
	}

	after, err := bridge.GetVoterData("alice@example.com")
	if err != nil {
		t.Fatalf("GetVoterData (after): %v", err)
	}
	if before == after {
		t.Error("expected a freshly fetched VoterData after AddVoter invalidated the cache")
	}
	if !after.Allowed {
		t.Error("expected voter to be allowed after AddVoter(true)")
	}
}

// TestRegister_LeafIndexIsSequential verifies that the leaf index returned by
// Register is the EVM's own tree size (not a blockchain transaction count),
// so it stays accurate regardless of how the caller tracks history.
func TestRegister_LeafIndexIsSequential(t *testing.T) {
	bridge := newTestBridge(t)

	// Small values well under the BN254 scalar field modulus — LeanIMT reverts if
	// a leaf is >= the field prime, and sampleCommitmentHex-style large hex strings
	// are not guaranteed to be under it depending on their leading byte.
	voters := []string{"alice@example.com", "bob@example.com", "carol@example.com"}
	commitments := []string{"0x1", "0x2", "0x3"}

	for _, voter := range voters {
		if err := bridge.AddVoter(voter, true, testNow()); err != nil {
			t.Fatalf("AddVoter(%s): %v", voter, err)
		}
	}
	if err := bridge.StartRegistration(3600, testNow()); err != nil {
		t.Fatalf("StartRegistration: %v", err)
	}

	for i, voter := range voters {
		leafIndex, err := bridge.Register(voter, commitments[i], testNow())
		if err != nil {
			t.Fatalf("Register(%s): %v", voter, err)
		}
		if leafIndex != uint64(i) {
			t.Errorf("voter %s: expected leaf index %d, got %d", voter, i, leafIndex)
		}
	}
}

// TestBridge_ConcurrentAccess exercises AddVoter/Register/Vote/GetVotingData from
// many goroutines at once. It must be run with `go test -race` to be meaningful:
// before the ContractBridge gained an internal mutex, this reliably tripped the
// race detector (and could corrupt/panic the underlying, non-concurrency-safe
// go-ethereum StateDB) because handlers like /vote and /add-voter shared one EVM
// instance with no synchronization.
func TestBridge_ConcurrentAccess(t *testing.T) {
	bridge := newTestBridge(t)

	const n = 20
	var wg sync.WaitGroup
	wg.Add(n * 2)

	for i := 0; i < n; i++ {
		voter := fmt.Sprintf("voter-%d@example.com", i)
		go func(voter string) {
			defer wg.Done()
			_ = bridge.AddVoter(voter, true, testNow())
		}(voter)
		go func() {
			defer wg.Done()
			_, _ = bridge.GetVotingData()
		}()
	}
	wg.Wait()

	// addVoters only works during Phase.Setup; open registration now that every
	// concurrent AddVoter call above has completed.
	if err := bridge.StartRegistration(3600, testNow()); err != nil {
		t.Fatalf("StartRegistration: %v", err)
	}

	// Now register everyone concurrently and make sure every leaf index is unique
	// (proves the internal lock actually serializes the read-modify-read sequence).
	indexes := make([]uint64, n)
	errs := make([]error, n)
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			voter := fmt.Sprintf("voter-%d@example.com", i)
			commitment := fmt.Sprintf("0x%063x1", i+1) // distinct per-voter commitment
			idx, err := bridge.Register(voter, commitment, testNow())
			indexes[i] = idx
			errs[i] = err
		}(i)
	}
	wg.Wait()

	seen := make(map[uint64]bool, n)
	for i, err := range errs {
		if err != nil {
			t.Errorf("Register(voter-%d): %v", i, err)
			continue
		}
		if seen[indexes[i]] {
			t.Errorf("duplicate leaf index %d assigned to voter-%d", indexes[i], i)
		}
		seen[indexes[i]] = true
	}
}

// ─── GetVotingData ────────────────────────────────────────────────────────────

func TestGetVotingData_InitialState(t *testing.T) {
	bridge := newTestBridge(t)

	data, err := bridge.GetVotingData()
	if err != nil {
		t.Fatalf("GetVotingData: %v", err)
	}

	if data.Question != "Should we proceed?" {
		t.Errorf("unexpected question: %q", data.Question)
	}
	if data.Phase != PhaseSetup {
		t.Errorf("freshly deployed contract should be in Phase.Setup, got %s", data.PhaseLabel)
	}
	if data.CandidateCount.Cmp(big.NewInt(2)) != 0 {
		t.Errorf("expected 2 candidates (Yes/No default), got %s", data.CandidateCount)
	}
	if data.TreeSize.Cmp(big.NewInt(0)) != 0 {
		t.Errorf("initial tree size should be 0, got %s", data.TreeSize)
	}
}

func TestGetVotingData_AfterRegistration(t *testing.T) {
	bridge := newTestBridge(t)

	if err := bridge.AddVoter("alice@example.com", true, testNow()); err != nil {
		t.Fatalf("AddVoter: %v", err)
	}
	if err := bridge.StartRegistration(3600, testNow()); err != nil {
		t.Fatalf("StartRegistration: %v", err)
	}
	if _, err := bridge.Register("alice@example.com", sampleCommitmentHex, testNow()); err != nil {
		t.Fatalf("Register: %v", err)
	}

	data, err := bridge.GetVotingData()
	if err != nil {
		t.Fatalf("GetVotingData: %v", err)
	}

	if data.TreeSize.Cmp(big.NewInt(1)) != 0 {
		t.Errorf("tree size should be 1 after one registration, got %s", data.TreeSize)
	}
	// Root must be non-zero after a leaf is inserted.
	if data.Root.Cmp(big.NewInt(0)) == 0 {
		t.Error("Merkle root should be non-zero after registration")
	}
}

// ─── Hex helpers ──────────────────────────────────────────────────────────────

func TestHexToBigInt(t *testing.T) {
	cases := []struct {
		input    string
		wantHex  string
	}{
		{"0x01", "1"},
		{"01", "1"},
		{"0xff", "255"},
		{"ff", "255"},
		{"0x0", "0"},
	}
	for _, tc := range cases {
		got, err := hexToBigInt(tc.input)
		if err != nil {
			t.Errorf("hexToBigInt(%q): %v", tc.input, err)
			continue
		}
		want, _ := new(big.Int).SetString(tc.wantHex, 10)
		if got.Cmp(want) != 0 {
			t.Errorf("hexToBigInt(%q) = %s, want %s", tc.input, got, want)
		}
	}
}

func TestHexToBytes32(t *testing.T) {
	// A 32-byte value should round-trip correctly.
	input := "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
	b32, err := hexToBytes32(input)
	if err != nil {
		t.Fatalf("hexToBytes32: %v", err)
	}
	if len(b32) != 32 {
		t.Errorf("expected 32 bytes, got %d", len(b32))
	}

	// Short input: right-aligned.
	b32short, err := hexToBytes32("0x01")
	if err != nil {
		t.Fatalf("hexToBytes32(short): %v", err)
	}
	if b32short[31] != 0x01 {
		t.Errorf("short value should be right-aligned: last byte = %02x", b32short[31])
	}
	for i := 0; i < 31; i++ {
		if b32short[i] != 0x00 {
			t.Errorf("leading bytes should be zero, got %02x at index %d", b32short[i], i)
		}
	}

	// Too long: must error (33 bytes = 66 hex chars).
	_, err = hexToBytes32("0x" + "ff" + "ff" + "ff" + "ff" + "ff" + "ff" + "ff" + "ff" +
		"ff" + "ff" + "ff" + "ff" + "ff" + "ff" + "ff" + "ff" +
		"ff" + "ff" + "ff" + "ff" + "ff" + "ff" + "ff" + "ff" +
		"ff" + "ff" + "ff" + "ff" + "ff" + "ff" + "ff" + "ff" + "ff")
	if err == nil {
		t.Error("expected error for input > 32 bytes, got nil")
	}
}

// TestResyncFromChain_RebuildsState verifies the periodic-sync EVM rebuild:
// ResyncFromChain deploys a fresh EVM and replays a whole chain into it, so the
// resulting state must match what the chain describes (voter allowed + registered,
// tree size 1) rather than whatever the old EVM happened to hold.
func TestResyncFromChain_RebuildsState(t *testing.T) {
	bridge := newTestBridge(t)

	// Build a chain the fresh EVM will replay: add a voter (Setup), open
	// registration, then register a commitment.
	bc := core.NewBlockchain("Should we proceed?", []string{"Yes", "No"})
	addTx := func(txType core.TxType, payload interface{}) {
		tx, err := core.NewTransaction(txType, payload)
		if err != nil {
			t.Fatalf("NewTransaction(%s): %v", txType, err)
		}
		if _, err := bc.AddTransaction(tx); err != nil {
			t.Fatalf("AddTransaction(%s): %v", txType, err)
		}
	}
	addTx(core.TxAddVoter, core.AddVoterPayload{VoterID: "alice", Allowed: true})
	addTx(core.TxStartRegistration, core.StartRegistrationPayload{DurationSec: 3600})
	addTx(core.TxRegister, core.RegisterPayload{VoterID: "alice", Commitment: "0x123", LeafIndex: 0})

	if err := bridge.ResyncFromChain(bc); err != nil {
		t.Fatalf("ResyncFromChain: %v", err)
	}

	vd, err := bridge.GetVotingData()
	if err != nil {
		t.Fatalf("GetVotingData: %v", err)
	}
	if vd.TreeSize.Uint64() != 1 {
		t.Errorf("expected tree_size 1 after resync, got %s", vd.TreeSize)
	}

	voter, err := bridge.GetVoterData("alice")
	if err != nil {
		t.Fatalf("GetVoterData: %v", err)
	}
	if !voter.Allowed || !voter.Registered {
		t.Errorf("expected alice allowed+registered after resync, got %+v", voter)
	}
}
