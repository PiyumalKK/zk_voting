package consensus

import (
	"testing"

	"github.com/ethereum/go-ethereum/common"

	"zk-blockchain/internal/config"
)

// TestQuorumAndFaultToleranceForTheDeployedSet states the whole promise of
// this feature in numbers: four validators, three signatures needed, one
// failure survived.
func TestQuorumAndFaultToleranceForTheDeployedSet(t *testing.T) {
	vs, _ := testSet(t)

	if got := vs.Size(); got != 4 {
		t.Errorf("Size() = %d, want 4", got)
	}
	if got := vs.Quorum(); got != 3 {
		t.Errorf("Quorum() = %d, want 3", got)
	}
	if got := vs.FaultTolerance(); got != 1 {
		t.Errorf("FaultTolerance() = %d, want 1 — the election must survive losing one validator", got)
	}
}

// TestProposerRotatesWithHeight walks a full cycle. The schedule is a pure
// function of (height, round), so every validator and every later auditor
// computes the same answer without communicating.
func TestProposerRotatesWithHeight(t *testing.T) {
	vs, _ := testSet(t)

	// members[(height + round) % 4], so height 1 round 0 is members[1] = jvp.
	want := []string{"authority", "jvp", "unp", "sjb", "authority", "jvp"}
	for height, name := range want {
		got := vs.ProposerAt(uint64(height), 0)
		if got.Name != name {
			t.Errorf("ProposerAt(%d, 0) = %q, want %q", height, got.Name, name)
		}
	}
}

// TestRoundChangeRotatesTheProposer is the property acceptance criterion 4
// rests on, at the arithmetic level: adding round to height is precisely what
// makes a failed proposer give way.
//
// If the schedule depended on height alone, a dead proposer would be
// re-elected in every round and the chain would never recover from losing one
// machine — which is the failure this whole package exists to prevent.
func TestRoundChangeRotatesTheProposer(t *testing.T) {
	vs, _ := testSet(t)

	const height = 10
	seen := make(map[string]bool)
	for round := uint32(0); round < 4; round++ {
		p := vs.ProposerAt(height, round)
		if seen[p.Name] {
			t.Errorf("round %d re-elected %q, which had already proposed at this height", round, p.Name)
		}
		seen[p.Name] = true
	}
	if len(seen) != 4 {
		t.Errorf("four rounds produced %d distinct proposers, want 4", len(seen))
	}

	// And it wraps: round N returns to the round-0 proposer.
	if a, b := vs.ProposerAt(height, 0), vs.ProposerAt(height, 4); a.Name != b.Name {
		t.Errorf("round 4 proposer %q, want it back at round 0's %q", b.Name, a.Name)
	}
}

// TestProposerScheduleDoesNotOverflowOnLargeRounds: a cluster partitioned for
// a long time can reach a high round number, and the schedule must stay
// well-defined rather than wrapping into a panic.
func TestProposerScheduleDoesNotOverflowOnLargeRounds(t *testing.T) {
	vs, _ := testSet(t)

	for _, tc := range []struct {
		height uint64
		round  uint32
	}{
		{height: 0, round: 0},
		{height: ^uint64(0), round: ^uint32(0)},
		{height: ^uint64(0) - 3, round: 7},
		{height: 1 << 62, round: 1 << 30},
	} {
		p := vs.ProposerAt(tc.height, tc.round)
		if p.Index < 0 || p.Index >= vs.Size() {
			t.Errorf("ProposerAt(%d, %d) returned index %d, outside the set", tc.height, tc.round, p.Index)
		}
	}
}

// TestIsProposerAtAgreesWithProposerAt: the two are used in different places
// (the engine asks "is it me?", the guard asks "is it them?") and must not be
// able to disagree.
func TestIsProposerAtAgreesWithProposerAt(t *testing.T) {
	vs, _ := testSet(t)

	for height := uint64(0); height < 8; height++ {
		for round := uint32(0); round < 3; round++ {
			want := vs.ProposerAt(height, round)
			for _, v := range vs.Members() {
				got := vs.IsProposerAt(v.Address, height, round)
				if got != (v.Address == want.Address) {
					t.Errorf("IsProposerAt(%s, %d, %d) = %v, but ProposerAt says %s", v.Name, height, round, got, want.Name)
				}
			}
		}
	}
}

// TestMembersReturnsACopy: the returned slice is handed to status reporting
// and to tests, and a caller that sorted it in place would silently rewrite
// the proposer schedule for the whole node.
func TestMembersReturnsACopy(t *testing.T) {
	vs, _ := testSet(t)

	members := vs.Members()
	members[0], members[3] = members[3], members[0]

	if vs.ProposerAt(0, 0).Name != "authority" {
		t.Error("reordering the slice from Members() changed the proposer schedule")
	}
}

func TestNewValidatorSetRejectsBadRegistries(t *testing.T) {
	addr := func(h string) common.Address { return common.HexToAddress(h) }

	tests := []struct {
		name    string
		entries []config.ValidatorEntry
		quorum  int
	}{
		{name: "empty", entries: nil},
		{
			name: "duplicate address is one vote pretending to be two",
			entries: []config.ValidatorEntry{
				{Name: "a", Address: addr("0x01")},
				{Name: "b", Address: addr("0x01")},
			},
		},
		{
			name: "duplicate name",
			entries: []config.ValidatorEntry{
				{Name: "a", Address: addr("0x01")},
				{Name: "a", Address: addr("0x02")},
			},
		},
		{
			name: "quorum larger than the set can never be reached",
			entries: []config.ValidatorEntry{
				{Name: "a", Address: addr("0x01")},
				{Name: "b", Address: addr("0x02")},
			},
			quorum: 3,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := NewValidatorSet(tc.entries, tc.quorum); err == nil {
				t.Error("NewValidatorSet accepted an unusable registry")
			}
		})
	}
}

// TestLookupResolvesOnlyMembers: Verify's membership check is exactly this
// lookup, so an address outside the set must not resolve.
func TestLookupResolvesOnlyMembers(t *testing.T) {
	vs, keys := testSet(t)

	for _, name := range testValidatorNames {
		v, ok := vs.ByName(name)
		if !ok {
			t.Fatalf("ByName(%q) not found", name)
		}
		if back, ok := vs.Lookup(v.Address); !ok || back.Name != name {
			t.Errorf("Lookup(%s) = %v,%v; want %q", v.Address, back.Name, ok, name)
		}
		_ = keys[name]
	}

	if _, ok := vs.Lookup(common.HexToAddress("0xdeadbeef")); ok {
		t.Error("Lookup resolved an address outside the set")
	}
	if vs.Contains(common.HexToAddress("0xdeadbeef")) {
		t.Error("Contains reported a stranger as a validator")
	}
}
