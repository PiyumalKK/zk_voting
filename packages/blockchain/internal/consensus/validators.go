package consensus

import (
	"fmt"

	"github.com/ethereum/go-ethereum/common"

	"zk-blockchain/internal/config"
)

// Validator is one member of the consensus set.
type Validator struct {
	// Name is the operator-facing identity ("authority", "jvp", …). It never
	// appears in a signature pre-image — only the address does — so a
	// disagreement about names between nodes is cosmetic, whereas a
	// disagreement about addresses or ordering is not.
	Name string
	// Address is what a valid signature from this validator recovers to.
	Address common.Address
	// Index is its position in the set, which is what the round-robin
	// proposer schedule is defined over.
	Index int
}

func (v Validator) String() string { return fmt.Sprintf("%s(%s)", v.Name, v.Address.Hex()) }

// ValidatorSet is the fixed, ordered registry every validator holds a copy
// of. It is immutable after construction: this chain has no on-chain
// validator management, and adding one would mean deciding at which block the
// set changes — a question with real consequences for the commit seals of
// blocks either side of the change. The set is configuration, and changing it
// is a coordinated restart. That is documented in CONSENSUS.md as a
// limitation, deliberately.
type ValidatorSet struct {
	members []Validator
	byAddr  map[common.Address]Validator
	byName  map[string]Validator
	quorum  int
}

// NewValidatorSet builds the registry from configuration.
//
// Order is preserved and load-bearing: ProposerAt indexes into it, so two
// validators given the same members in a different order would disagree about
// whose turn it is at every height and the cluster would never make progress.
// That is why config parses VALIDATOR_SET into a slice rather than a map.
func NewValidatorSet(entries []config.ValidatorEntry, quorum int) (*ValidatorSet, error) {
	if len(entries) == 0 {
		return nil, fmt.Errorf("validator set is empty")
	}

	vs := &ValidatorSet{
		members: make([]Validator, 0, len(entries)),
		byAddr:  make(map[common.Address]Validator, len(entries)),
		byName:  make(map[string]Validator, len(entries)),
	}

	for i, e := range entries {
		v := Validator{Name: e.Name, Address: e.Address, Index: i}
		if _, dup := vs.byAddr[v.Address]; dup {
			return nil, fmt.Errorf("validator address %s appears twice", v.Address)
		}
		if _, dup := vs.byName[v.Name]; dup {
			return nil, fmt.Errorf("validator name %q appears twice", v.Name)
		}
		vs.members = append(vs.members, v)
		vs.byAddr[v.Address] = v
		vs.byName[v.Name] = v
	}

	vs.quorum = quorum
	if vs.quorum <= 0 {
		vs.quorum = config.DeriveQuorum(len(vs.members))
	}
	if vs.quorum > len(vs.members) {
		return nil, fmt.Errorf("quorum %d exceeds the %d validators in the set", vs.quorum, len(vs.members))
	}
	return vs, nil
}

// Size is N.
func (vs *ValidatorSet) Size() int { return len(vs.members) }

// Quorum is Q — the number of distinct COMMIT signatures a block needs.
func (vs *ValidatorSet) Quorum() int { return vs.quorum }

// FaultTolerance is f = N - Q: how many validators may be down or Byzantine
// while the chain still finalizes blocks. For the deployed set (N=4, Q=3) it
// is 1, which is exactly the promise this whole package exists to make.
func (vs *ValidatorSet) FaultTolerance() int { return len(vs.members) - vs.quorum }

// Members returns the set in protocol order. The slice is a copy; callers
// that sorted or reordered the internal one would silently change the
// proposer schedule.
func (vs *ValidatorSet) Members() []Validator {
	out := make([]Validator, len(vs.members))
	copy(out, vs.members)
	return out
}

// Lookup resolves a recovered signer address to its validator.
func (vs *ValidatorSet) Lookup(addr common.Address) (Validator, bool) {
	v, ok := vs.byAddr[addr]
	return v, ok
}

// ByName resolves an operator-facing name, for configuration and for
// zk_consensusStatus.
func (vs *ValidatorSet) ByName(name string) (Validator, bool) {
	v, ok := vs.byName[name]
	return v, ok
}

// Contains reports whether addr may vote.
func (vs *ValidatorSet) Contains(addr common.Address) bool {
	_, ok := vs.byAddr[addr]
	return ok
}

// ProposerAt returns whose turn it is to propose block `height` in round
// `round`: members[(height + round) % N].
//
// Two properties matter, and both come from it being this simple:
//
//   - It is a pure function of (height, round), so every validator — and any
//     auditor reading the chain afterwards — computes the same answer with no
//     communication. There is no leader election to go wrong.
//   - Adding round to height is what makes round changes rotate the
//     proposer. If the schedule depended on height alone, a dead proposer
//     would be re-elected every round and the chain would never recover from
//     losing one machine, which is the failure this design exists to prevent.
//
// Height is used rather than a free-running counter so that a validator
// rejoining after a restart derives the schedule from the chain itself.
func (vs *ValidatorSet) ProposerAt(height uint64, round uint32) Validator {
	n := uint64(len(vs.members))
	// Both operands are reduced before adding so that a very large round
	// cannot overflow the sum. Rounds are bounded by the round-change timer
	// in practice, but the arithmetic should not depend on that.
	idx := (height%n + uint64(round)%n) % n
	return vs.members[idx]
}

// IsProposerAt reports whether addr proposes at (height, round).
func (vs *ValidatorSet) IsProposerAt(addr common.Address, height uint64, round uint32) bool {
	return vs.ProposerAt(height, round).Address == addr
}
