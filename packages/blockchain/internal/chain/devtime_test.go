package chain

import (
	"errors"
	"math/big"
	"testing"
	"time"
)

// The tests in this file cover M07's time-control surface on the Sequencer:
// IncreaseTime (evm_increaseTime), SetNextBlockTimestamp
// (evm_setNextBlockTimestamp) and their interaction with sealing.
//
// They assert on *header timestamps of sealed blocks*, never on the
// sequencer's internal offset alone, because the header is the only thing
// replicas and the audit tool ever see (MASTER §10 pitfall 7). An
// implementation that moved the offset but failed to reach the header would
// pass a field-inspecting test and break replication.

// mineAndTime seals an empty block and returns its timestamp.
func mineAndTime(t *testing.T, seq *Sequencer) uint64 {
	t.Helper()
	block, err := seq.MineEmptyBlock()
	if err != nil {
		t.Fatalf("MineEmptyBlock: %v", err)
	}
	return block.Time()
}

func TestIncreaseTimeAccumulatesAndShiftsSealedBlocks(t *testing.T) {
	seq, _ := newTestSequencer(t)

	base := mineAndTime(t, seq)

	total, err := seq.IncreaseTime(3600)
	if err != nil {
		t.Fatalf("IncreaseTime(3600): %v", err)
	}
	if total != 3600 {
		t.Errorf("IncreaseTime(3600) = %d, want 3600", total)
	}

	// A second increment must accumulate onto the first, not replace it —
	// the hardhat test suite calls evm_increaseTime once per phase and
	// depends on the jumps compounding.
	total, err = seq.IncreaseTime(1800)
	if err != nil {
		t.Fatalf("IncreaseTime(1800): %v", err)
	}
	if total != 5400 {
		t.Errorf("second IncreaseTime returned %d, want 5400 (accumulated)", total)
	}
	if got := seq.DevOffsetSeconds(); got != 5400 {
		t.Errorf("DevOffsetSeconds() = %d, want 5400", got)
	}

	after := mineAndTime(t, seq)

	// Wall clock advances during the test too, so the assertion is a range:
	// at least the requested jump, and not wildly more. A few seconds of
	// slack absorbs a slow CI machine without letting a broken
	// implementation through.
	const slack = 60
	delta := int64(after) - int64(base)
	if delta < 5400 || delta > 5400+slack {
		t.Errorf("timestamp delta across a 5400s accumulated increase = %ds, want between 5400 and %d", delta, 5400+slack)
	}
}

// TestIncreaseTimeReturnsASignedTotalAfterAPinBelowWallClock is a
// regression test for a real bug: IncreaseTime used to return uint64, and
// the dev offset goes *negative* whenever a block is pinned below wall
// clock. Because this chain's genesis is timestamped 0, pinning a small
// timestamp on a fresh chain is legal, so the bug was reachable — it made
// evm_increaseTime report 18446744071924556216 instead of -1784995400.
func TestIncreaseTimeReturnsASignedTotalAfterAPinBelowWallClock(t *testing.T) {
	seq, _ := newTestSequencer(t)

	// Legal on a fresh chain: genesis.Time is 0, so any positive timestamp
	// is strictly increasing, even one decades in the past.
	const pin = uint64(1000)
	if err := seq.SetNextBlockTimestamp(pin); err != nil {
		t.Fatalf("SetNextBlockTimestamp(%d): %v", pin, err)
	}
	if got := mineAndTime(t, seq); got != pin {
		t.Fatalf("pinned block timestamp = %d, want %d", got, pin)
	}

	offset := seq.DevOffsetSeconds()
	if offset >= 0 {
		t.Fatalf("precondition failed: offset = %d, expected it to be negative after pinning below wall clock", offset)
	}

	total, err := seq.IncreaseTime(3600)
	if err != nil {
		t.Fatalf("IncreaseTime: %v", err)
	}
	if want := offset + 3600; total != want {
		t.Errorf("IncreaseTime returned %d, want %d", total, want)
	}
	if total >= 0 {
		t.Errorf("IncreaseTime returned %d; a total that is still negative must be reported as negative, not wrapped", total)
	}
}

// TestIncreaseTimeIsEffectiveWhenTheHeadIsAheadOfWallClock is the
// regression test for the failure `make diff-dev` reported as
// "our delta=1s hardhat delta=86400s".
//
// On a persistent chain the head routinely sits ahead of wall clock: a
// previous run jumped the clock forward, those blocks are on disk, and a
// restart resets the in-memory offset to zero while leaving them there.
// nextTimestamp's monotonicity floor (parent+1) then absorbs the entire
// requested jump unless IncreaseTime accounts for the head. Hardhat never
// hits this because its chain is in-memory and always fresh.
func TestIncreaseTimeIsEffectiveWhenTheHeadIsAheadOfWallClock(t *testing.T) {
	seq, _ := newTestSequencer(t)

	// Put the head a day ahead of wall clock, the way a previous run would
	// have, then drop the offset back to zero as a restart does.
	future := uint64(time.Now().Unix()) + 86_400
	if err := seq.SetNextBlockTimestamp(future); err != nil {
		t.Fatalf("SetNextBlockTimestamp: %v", err)
	}
	if got := mineAndTime(t, seq); got != future {
		t.Fatalf("setup: head timestamp = %d, want %d", got, future)
	}
	seq.SetDevOffset(0)

	const jump = 3600
	if _, err := seq.IncreaseTime(jump); err != nil {
		t.Fatalf("IncreaseTime: %v", err)
	}

	after := mineAndTime(t, seq)
	delta := int64(after) - int64(future)
	const slack = 60
	if delta < jump || delta > jump+slack {
		t.Errorf("timestamp moved %ds past a head that was ahead of wall clock, want %d..%d — the jump was swallowed by the parent+1 monotonicity floor",
			delta, jump, jump+slack)
	}
}

func TestIncreaseTimeRejectsOutOfRangeJump(t *testing.T) {
	seq, _ := newTestSequencer(t)

	if _, err := seq.IncreaseTime(uint64(maxDevOffsetSeconds) + 1); !errors.Is(err, ErrDevOffsetOutOfRange) {
		t.Errorf("IncreaseTime(oversized) error = %v, want ErrDevOffsetOutOfRange", err)
	}
	// The uint64 parameter cannot express a negative increment, so the
	// largest possible input is the one most likely to wrap if the bounds
	// arithmetic is ever rewritten carelessly.
	if _, err := seq.IncreaseTime(^uint64(0)); !errors.Is(err, ErrDevOffsetOutOfRange) {
		t.Errorf("IncreaseTime(max uint64) error = %v, want ErrDevOffsetOutOfRange", err)
	}
	if got := seq.DevOffsetSeconds(); got != 0 {
		t.Errorf("a rejected IncreaseTime still moved the offset to %d, want 0", got)
	}

	// Rejected in the accumulating direction too: two individually-legal
	// increments that together overflow the bound must not be applied.
	if _, err := seq.IncreaseTime(uint64(maxDevOffsetSeconds)); err != nil {
		t.Fatalf("IncreaseTime(max): %v", err)
	}
	if _, err := seq.IncreaseTime(1); !errors.Is(err, ErrDevOffsetOutOfRange) {
		t.Errorf("accumulating past the bound error = %v, want ErrDevOffsetOutOfRange", err)
	}
	if got := seq.DevOffsetSeconds(); got != maxDevOffsetSeconds {
		t.Errorf("DevOffsetSeconds() = %d, want the offset left at %d", got, maxDevOffsetSeconds)
	}
}

func TestSetNextBlockTimestampPinsExactlyThatBlock(t *testing.T) {
	seq, _ := newTestSequencer(t)

	want := uint64(time.Now().Unix()) + 100_000
	if err := seq.SetNextBlockTimestamp(want); err != nil {
		t.Fatalf("SetNextBlockTimestamp: %v", err)
	}

	if got := mineAndTime(t, seq); got != want {
		t.Fatalf("pinned block timestamp = %d, want exactly %d", got, want)
	}

	// The pin applies to one block only; the block after it is chosen by the
	// ordinary rule again.
	next := mineAndTime(t, seq)
	if next == want {
		t.Error("the block after a pinned block reused the pinned timestamp; the pin was not consumed")
	}

	// …and, per the Hardhat-compatible choice recorded in
	// Sequencer.SetNextBlockTimestamp's doc comment, the clock continues
	// forward *from* the pin rather than snapping back to wall clock.
	if next <= want {
		t.Errorf("block after the pin has timestamp %d, want > %d (clock should continue from the pinned time)", next, want)
	}
	if next > want+60 {
		t.Errorf("block after the pin jumped to %d, more than a minute past the pin at %d", next, want)
	}
}

func TestSetNextBlockTimestampRejectsNonIncreasing(t *testing.T) {
	seq, _ := newTestSequencer(t)
	current := mineAndTime(t, seq)

	for _, ts := range []uint64{current, current - 1, 0} {
		if err := seq.SetNextBlockTimestamp(ts); !errors.Is(err, ErrTimestampNotIncreasing) {
			t.Errorf("SetNextBlockTimestamp(%d) error = %v, want ErrTimestampNotIncreasing", ts, err)
		}
	}

	// A rejected pin must leave no pin behind: the next block is chosen
	// normally and is still strictly after the current head.
	if got := mineAndTime(t, seq); got <= current {
		t.Errorf("timestamp after rejected pins = %d, want > %d", got, current)
	}
}

// TestPinnedTimestampSurvivesRevertedTransaction is the reason
// peekTimestamp and commitTimestamp are separate functions. A reverting
// transaction mines no block at all (MASTER §10 pitfall 2), so it must not
// silently swallow the pin the caller set — Hardhat leaves the pin in place
// for the next attempt, and a test that sets a timestamp, hits a revert and
// then mines would otherwise get an unexpected time.
func TestPinnedTimestampSurvivesRevertedTransaction(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)

	_, reverter := deploy(t, seq, key, chainID, 0, revertRuntime())

	want := uint64(time.Now().Unix()) + 50_000
	if err := seq.SetNextBlockTimestamp(want); err != nil {
		t.Fatalf("SetNextBlockTimestamp: %v", err)
	}

	tx := mustSignTx(t, key, chainID, 1, &reverter, big.NewInt(0), 100_000, nil)
	if _, err := seq.SubmitTx(tx); err == nil {
		t.Fatal("expected the reverting transaction to be rejected")
	}

	if got := mineAndTime(t, seq); got != want {
		t.Errorf("timestamp after a reverted tx = %d, want the pin at %d to have survived", got, want)
	}
}

// TestPinAppliesToTransactionBlocksToo guards the other half of the same
// wiring: the pin must reach SubmitTx's header, not only MineEmptyBlock's.
func TestPinAppliesToTransactionBlocksToo(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)
	to := testSysOpAddr

	want := uint64(time.Now().Unix()) + 12_345
	if err := seq.SetNextBlockTimestamp(want); err != nil {
		t.Fatalf("SetNextBlockTimestamp: %v", err)
	}

	receipt, err := seq.SubmitTx(mustSignTx(t, key, chainID, 0, &to, big.NewInt(1), 21_000, nil))
	if err != nil {
		t.Fatalf("SubmitTx: %v", err)
	}

	header, err := seq.HeaderByNumber(receipt.BlockNumber.Uint64())
	if err != nil {
		t.Fatalf("HeaderByNumber: %v", err)
	}
	if header.Time != want {
		t.Errorf("transaction block timestamp = %d, want the pinned %d", header.Time, want)
	}
}

// TestSysOpBlockRespectsPinnedTimestamp closes the last sealing path:
// hardhat_setBalance's system-op block goes through the same timestamp
// resolution as everything else.
func TestSysOpBlockRespectsPinnedTimestamp(t *testing.T) {
	seq, _ := newTestSequencer(t)

	want := uint64(time.Now().Unix()) + 777
	if err := seq.SetNextBlockTimestamp(want); err != nil {
		t.Fatalf("SetNextBlockTimestamp: %v", err)
	}

	block, err := seq.SetBalance(testSysOpAddr, big.NewInt(1))
	if err != nil {
		t.Fatalf("SetBalance: %v", err)
	}
	if block.Time() != want {
		t.Errorf("sysop block timestamp = %d, want the pinned %d", block.Time(), want)
	}
}

// TestTimestampsRemainStrictlyIncreasingUnderRapidMining is the chain
// invariant MASTER §10 pitfall 7 depends on: Voting.sol's phase deadlines
// compare block.timestamp values, so two blocks sealed inside the same
// wall-clock second must still differ.
func TestTimestampsRemainStrictlyIncreasingUnderRapidMining(t *testing.T) {
	seq, _ := newTestSequencer(t)

	prev := uint64(0)
	for i := 0; i < 5; i++ {
		got := mineAndTime(t, seq)
		if got <= prev {
			t.Fatalf("block %d timestamp %d is not greater than the previous %d", i+1, got, prev)
		}
		prev = got
	}
}
