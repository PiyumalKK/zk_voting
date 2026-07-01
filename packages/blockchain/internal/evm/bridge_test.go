package evm

import (
	"fmt"
	"math/big"
	"path/filepath"
	"runtime"
	"sync"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

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
// contracts. It skips the test if the artifact files are not present.
func newTestBridge(t *testing.T) *ContractBridge {
	t.Helper()
	assets := assetsDir(t)

	sm, err := NewStateManager()
	if err != nil {
		t.Fatalf("NewStateManager: %v", err)
	}
	evmInst := CreateStatelessEVM(sm.GetStateDB())
	caller := NewContractCaller(evmInst)

	bridge, err := NewContractBridge(caller, assets, "Should we proceed?")
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

	_, err := NewContractBridge(caller, "/nonexistent/path", "question")
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

	if err := bridge.AddVoter("alice@example.com", true); err != nil {
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
	if err := bridge.AddVoter("alice@example.com", true); err != nil {
		t.Fatalf("AddVoter(true): %v", err)
	}
	if err := bridge.AddVoter("alice@example.com", false); err != nil {
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

	// Must add voter first.
	if err := bridge.AddVoter("alice@example.com", true); err != nil {
		t.Fatalf("AddVoter: %v", err)
	}

	leafIndex, err := bridge.Register("alice@example.com", sampleCommitmentHex)
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

	// Attempt registration without adding voter first.
	_, err := bridge.Register("bob@example.com", sampleCommitmentHex)
	if err == nil {
		t.Error("expected error for unallowlisted voter, got nil")
	}
}

func TestRegister_DuplicateCommitment(t *testing.T) {
	bridge := newTestBridge(t)

	if err := bridge.AddVoter("alice@example.com", true); err != nil {
		t.Fatalf("AddVoter alice: %v", err)
	}
	if err := bridge.AddVoter("bob@example.com", true); err != nil {
		t.Fatalf("AddVoter bob: %v", err)
	}

	// Register alice with the commitment.
	if _, err := bridge.Register("alice@example.com", sampleCommitmentHex); err != nil {
		t.Fatalf("Register alice: %v", err)
	}

	// Bob tries to register with the same commitment — must be rejected.
	_, err := bridge.Register("bob@example.com", sampleCommitmentHex)
	if err == nil {
		t.Error("expected error for duplicate commitment, got nil")
	}
}

func TestRegister_AlreadyRegistered(t *testing.T) {
	bridge := newTestBridge(t)

	if err := bridge.AddVoter("alice@example.com", true); err != nil {
		t.Fatalf("AddVoter: %v", err)
	}
	if _, err := bridge.Register("alice@example.com", sampleCommitmentHex); err != nil {
		t.Fatalf("Register first time: %v", err)
	}

	// Second registration for the same voter must be rejected.
	differentCommitment := "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	_, err := bridge.Register("alice@example.com", differentCommitment)
	if err == nil {
		t.Error("expected error for already-registered voter, got nil")
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

	for i, voter := range voters {
		if err := bridge.AddVoter(voter, true); err != nil {
			t.Fatalf("AddVoter(%s): %v", voter, err)
		}
		leafIndex, err := bridge.Register(voter, commitments[i])
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
			_ = bridge.AddVoter(voter, true)
		}(voter)
		go func() {
			defer wg.Done()
			_, _ = bridge.GetVotingData()
		}()
	}
	wg.Wait()

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
			idx, err := bridge.Register(voter, commitment)
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
	if data.YesVotes.Cmp(big.NewInt(0)) != 0 {
		t.Errorf("initial yes votes should be 0, got %s", data.YesVotes)
	}
	if data.NoVotes.Cmp(big.NewInt(0)) != 0 {
		t.Errorf("initial no votes should be 0, got %s", data.NoVotes)
	}
	if data.TreeSize.Cmp(big.NewInt(0)) != 0 {
		t.Errorf("initial tree size should be 0, got %s", data.TreeSize)
	}
}

func TestGetVotingData_AfterRegistration(t *testing.T) {
	bridge := newTestBridge(t)

	if err := bridge.AddVoter("alice@example.com", true); err != nil {
		t.Fatalf("AddVoter: %v", err)
	}
	if _, err := bridge.Register("alice@example.com", sampleCommitmentHex); err != nil {
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
