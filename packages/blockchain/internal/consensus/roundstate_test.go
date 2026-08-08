package consensus

import (
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

// signedFor is a verified vote from one validator, built directly so these
// tests can exercise roundState without standing up four engines.
func signedFor(t *testing.T, name string, typ MsgType, height uint64, round uint32, hash common.Hash) *SignedMessage {
	t.Helper()
	_, keys := testSet(t)
	sm, err := Sign(testChainID, keys[name], Message{Type: typ, Height: height, Round: round, BlockHash: hash})
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	return sm
}

var (
	blockA = common.HexToHash("0xaaaa")
	blockB = common.HexToHash("0xbbbb")
)

func newTestRoundState(t *testing.T, height uint64) *roundState {
	t.Helper()
	vs, _ := testSet(t)
	proposer := vs.ProposerAt(height, 0)
	return newRoundState(height, 0, proposer, false)
}

// TestARepeatedVoteIsNotASecondVote: the transport is at-least-once by
// design, so the same validator's message arriving twice is routine. It must
// count once — otherwise a peer with an eager retry loop could single-
// handedly manufacture a quorum.
func TestARepeatedVoteIsNotASecondVote(t *testing.T) {
	rs := newTestRoundState(t, 5)
	vote := signedFor(t, "authority", MsgPrepare, 5, 0, blockA)

	if accepted, equivocated := rs.record(vote); !accepted || equivocated {
		t.Fatalf("first record: accepted=%v equivocated=%v, want true/false", accepted, equivocated)
	}
	for range 5 {
		if accepted, equivocated := rs.record(vote); accepted || equivocated {
			t.Errorf("a duplicate was counted: accepted=%v equivocated=%v", accepted, equivocated)
		}
	}
	if got := rs.prepareCount(blockA); got != 1 {
		t.Errorf("prepareCount = %d after six deliveries of one vote, want 1", got)
	}
}

// TestEquivocationDiscardsBothVotes is the local Byzantine defence, and the
// reason both votes go rather than just the second.
//
// Keeping the first would let a Byzantine validator choose which honest
// node's tally it contributes to purely by controlling arrival order — send A
// first to one peer and B first to another, and it has cast a decisive vote
// on both sides of a split. That is exactly the power the quorum-intersection
// argument assumes it does not have. Discarding both costs at most liveness:
// with N=4 the three honest validators still make quorum without it.
func TestEquivocationDiscardsBothVotes(t *testing.T) {
	rs := newTestRoundState(t, 5)

	first := signedFor(t, "jvp", MsgPrepare, 5, 0, blockA)
	if accepted, _ := rs.record(first); !accepted {
		t.Fatal("the first vote was not counted")
	}
	if got := rs.prepareCount(blockA); got != 1 {
		t.Fatalf("prepareCount(A) = %d, want 1", got)
	}

	second := signedFor(t, "jvp", MsgPrepare, 5, 0, blockB)
	accepted, equivocated := rs.record(second)
	if accepted {
		t.Error("the contradictory second vote was counted")
	}
	if !equivocated {
		t.Fatal("a validator voting for two different blocks at one height and round was not flagged")
	}

	if got := rs.prepareCount(blockA); got != 0 {
		t.Errorf("prepareCount(A) = %d after equivocation, want 0 — the first vote must be withdrawn too", got)
	}
	if got := rs.prepareCount(blockB); got != 0 {
		t.Errorf("prepareCount(B) = %d, want 0", got)
	}

	faulty := rs.faultyAddresses()
	if len(faulty) != 1 {
		t.Fatalf("faultyAddresses() = %v, want exactly the equivocating validator", faulty)
	}
	vs, _ := testSet(t)
	if v, ok := vs.Lookup(faulty[0]); !ok || v.Name != "jvp" {
		t.Errorf("flagged %v, want jvp", faulty)
	}
}

// TestAnHonestValidatorsVotesAreUnaffectedByAnothersEquivocation: excluding a
// Byzantine validator must not cost the honest ones their votes, or one
// faulty node could stall every height by poisoning the tally.
func TestAnHonestValidatorsVotesAreUnaffectedByAnothersEquivocation(t *testing.T) {
	rs := newTestRoundState(t, 5)

	for _, name := range []string{"authority", "unp", "sjb"} {
		if accepted, _ := rs.record(signedFor(t, name, MsgPrepare, 5, 0, blockA)); !accepted {
			t.Fatalf("%s's vote was not counted", name)
		}
	}
	rs.record(signedFor(t, "jvp", MsgPrepare, 5, 0, blockA))
	rs.record(signedFor(t, "jvp", MsgPrepare, 5, 0, blockB))

	if got := rs.prepareCount(blockA); got != 3 {
		t.Errorf("prepareCount(A) = %d, want the 3 honest votes to survive", got)
	}
}

// TestCommitsAggregateAcrossRounds is the liveness payoff of zeroing the
// round in a commit's signing pre-image: a commit cast in round 0 and one
// cast in round 2 for the same block count toward the same quorum, so a slow
// validator's late vote is not wasted when a round change races it.
func TestCommitsAggregateAcrossRounds(t *testing.T) {
	rs := newTestRoundState(t, 5)

	rs.record(signedFor(t, "authority", MsgCommit, 5, 0, blockA))
	rs.record(signedFor(t, "jvp", MsgCommit, 5, 1, blockA))
	rs.record(signedFor(t, "unp", MsgCommit, 5, 2, blockA))

	if got := rs.commitCount(blockA); got != 3 {
		t.Errorf("commitCount = %d across three rounds, want 3 — commits must be round-independent", got)
	}
	if got := len(rs.commitSignatures(blockA)); got != 3 {
		t.Errorf("commitSignatures returned %d seals, want 3", got)
	}
}

// TestOneValidatorCannotCommitTwiceByChangingRound: the other side of
// round-independence. Because the round is zeroed, a validator repeating its
// commit in a later round is the *same* vote, not a second one — otherwise
// one node could reach quorum alone simply by re-sending.
func TestOneValidatorCannotCommitTwiceByChangingRound(t *testing.T) {
	rs := newTestRoundState(t, 5)

	for round := uint32(0); round < 5; round++ {
		rs.record(signedFor(t, "authority", MsgCommit, 5, round, blockA))
	}
	if got := rs.commitCount(blockA); got != 1 {
		t.Errorf("commitCount = %d after one validator committed in five rounds, want 1", got)
	}
}

// TestTheLockSurvivesARoundChange is the safety invariant in isolation. Once
// a validator has committed to a block at a height, no later round may make
// it vote for a different one — that single fact is what makes two blocks
// unable to both reach quorum at one height.
func TestTheLockSurvivesARoundChange(t *testing.T) {
	vs, _ := testSet(t)
	rs := newTestRoundState(t, 5)

	rs.lockedHash, rs.lockedRound, rs.locked = blockA, 0, true

	if !rs.acceptableProposal(blockA) {
		t.Error("a locked validator refused its own locked block")
	}
	if rs.acceptableProposal(blockB) {
		t.Error("a locked validator would accept a different block")
	}

	rs.enterRound(3, vs.ProposerAt(5, 3), false)

	if !rs.locked || rs.lockedHash != blockA {
		t.Fatal("the lock was cleared by a round change")
	}
	if rs.acceptableProposal(blockB) {
		t.Error("after a round change a locked validator would accept a different block")
	}
	if rs.ph != phaseIdle || rs.proposal != nil {
		t.Error("a round change did not reset the per-round proposal state")
	}
}

// TestCommitsSurviveARoundChangeButPreparesDoNot: prepares are bound to their
// round by their signature, so carrying them forward would be counting votes
// nobody cast in the new round. Commits are not, and must survive.
func TestCommitsSurviveARoundChangeButPreparesDoNot(t *testing.T) {
	vs, _ := testSet(t)
	rs := newTestRoundState(t, 5)

	rs.record(signedFor(t, "authority", MsgPrepare, 5, 0, blockA))
	rs.record(signedFor(t, "jvp", MsgPrepare, 5, 0, blockA))
	rs.record(signedFor(t, "authority", MsgCommit, 5, 0, blockA))

	rs.enterRound(1, vs.ProposerAt(5, 1), false)

	if got := rs.prepareCount(blockA); got != 0 {
		t.Errorf("prepareCount = %d after a round change, want 0", got)
	}
	if got := rs.commitCount(blockA); got != 1 {
		t.Errorf("commitCount = %d after a round change, want the commit to survive", got)
	}
}

// TestHighestLockWins: when validators report different locks in their
// round-change messages, the new proposer must re-propose the one locked in
// the highest round. Choosing any other could orphan a block that a validator
// has already committed, leaving it refusing to prepare anything else and the
// height deadlocked.
func TestHighestLockWins(t *testing.T) {
	rs := newTestRoundState(t, 5)

	older, err := Sign(testChainID, mustKey(t, testKeys[0]), Message{
		Type: MsgRoundChange, Height: 5, Round: 3, LockedRound: 0, LockedHash: blockA,
		BlockRLP: []byte{0x01},
	})
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	newer, err := Sign(testChainID, mustKey(t, testKeys[1]), Message{
		Type: MsgRoundChange, Height: 5, Round: 3, LockedRound: 2, LockedHash: blockB,
		BlockRLP: []byte{0x02},
	})
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	unlocked, err := Sign(testChainID, mustKey(t, testKeys[2]), Message{
		Type: MsgRoundChange, Height: 5, Round: 3,
	})
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	rs.record(older)
	rs.record(newer)
	rs.record(unlocked)

	hash, payload, found := rs.highestLock(3)
	if !found {
		t.Fatal("highestLock found nothing despite two reported locks")
	}
	if hash != blockB {
		t.Errorf("highestLock = %s, want %s (locked in the higher round)", hash, blockB)
	}
	if len(payload) != 1 || payload[0] != 0x02 {
		t.Errorf("highestLock returned the wrong block payload: %x", payload)
	}
	if got := rs.changeCount(3); got != 3 {
		t.Errorf("changeCount(3) = %d, want 3", got)
	}
}

// TestHighestLockIgnoresValidatorsWithNoLock: a round-change from an unlocked
// validator must not be read as a lock on the zero hash.
func TestHighestLockIgnoresValidatorsWithNoLock(t *testing.T) {
	rs := newTestRoundState(t, 5)

	for i, name := range []string{"authority", "jvp", "unp"} {
		sm, err := Sign(testChainID, mustKey(t, testKeys[i]), Message{Type: MsgRoundChange, Height: 5, Round: 2})
		if err != nil {
			t.Fatalf("Sign: %v", err)
		}
		_ = name
		rs.record(sm)
	}

	if _, _, found := rs.highestLock(2); found {
		t.Error("highestLock reported a lock when no validator had one")
	}
}

// TestAnUnverifiedMessageIsNeverTallied: record refuses a message that has
// not been through Verify, so an unauthenticated vote can never reach a
// quorum count whatever a future caller does.
func TestAnUnverifiedMessageIsNeverTallied(t *testing.T) {
	rs := newTestRoundState(t, 5)

	forged := &SignedMessage{Message: Message{Type: MsgPrepare, Height: 5, BlockHash: blockA}}
	if accepted, _ := rs.record(forged); accepted {
		t.Error("an unverified message was tallied")
	}
	if got := rs.prepareCount(blockA); got != 0 {
		t.Errorf("prepareCount = %d, want 0", got)
	}
}
