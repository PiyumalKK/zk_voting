package chain

import (
	"errors"
	"math/big"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethdb"

	"zk-blockchain/internal/state"
	"zk-blockchain/internal/storage"
)

// newCandidateSequencer is newTestSequencer with the production options a BFT
// node gets: the copy-on-write scratch overlay, so speculative execution
// leaves nothing on disk, and clock adoption. Tests that want the pre-
// consensus construction keep using newTestSequencer.
func newCandidateSequencer(t *testing.T) (*Sequencer, ethdb.Database) {
	t.Helper()
	db, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	cfg := testConfig(testChainID, 60_000_000)
	if _, err := state.EnsureGenesis(db, cfg); err != nil {
		t.Fatalf("EnsureGenesis: %v", err)
	}

	seq := New(db, state.ChainConfig(cfg.ChainID), cfg.BlockGasLimit,
		WithScratchDB(storage.NewReplayOverlay),
		WithClockAdoption(true),
	)
	return seq, db
}

// countKeys walks the whole key/value store. Used to prove BuildCandidate
// wrote nothing, which "the head did not move" alone would not: a candidate
// that committed its trie nodes to the real database would leave the head
// untouched and still have written megabytes.
func countKeys(t *testing.T, db ethdb.Database) int {
	t.Helper()
	it := db.NewIterator(nil, nil)
	defer it.Release()

	n := 0
	for it.Next() {
		n++
	}
	if err := it.Error(); err != nil {
		t.Fatalf("iterate database: %v", err)
	}
	return n
}

// TestCandidateBlockHashMatchesTheSealedBlock is the property the whole
// consensus mode rests on, and the reason assembleBlock was split out of
// finalizeBlock rather than duplicated.
//
// A proposer builds a block with BuildCandidate, its peers vote on that
// block's hash, and it is committed with ApplyExternalBlock. If BuildCandidate
// produced anything other than exactly what SubmitTx would have sealed, then
// solo mode and BFT mode would be executing the same transaction into
// different chains — and the difference would surface only as a state-root
// mismatch on a peer, long after the divergence was introduced.
//
// Two chains are built from identical genesis and driven with the identical
// transaction; one seals, the other only builds. Timestamps are pinned so the
// wall clock cannot make them differ for an uninteresting reason.
func TestCandidateBlockHashMatchesTheSealedBlock(t *testing.T) {
	sealer, _ := newTestSequencer(t)
	builder, _ := newCandidateSequencer(t)

	key := mustHardhatAccount0(t)
	to := common.HexToAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")

	// Pin both chains to the same timestamp: nextTimestamp reads the wall
	// clock, and a test that straddles a second boundary would otherwise fail
	// for a reason that has nothing to do with block assembly.
	const pinned = 1_800_000_000
	if err := sealer.SetNextBlockTimestamp(pinned); err != nil {
		t.Fatalf("pin sealer timestamp: %v", err)
	}
	if err := builder.SetNextBlockTimestamp(pinned); err != nil {
		t.Fatalf("pin builder timestamp: %v", err)
	}

	tx := mustSignTx(t, key, big.NewInt(testChainID), 0, &to, big.NewInt(1), 21_000, nil)

	receipt, err := sealer.SubmitTx(tx)
	if err != nil {
		t.Fatalf("SubmitTx: %v", err)
	}
	sealed, err := sealer.BlockByNumber(1)
	if err != nil {
		t.Fatalf("BlockByNumber(1): %v", err)
	}

	candidate, err := builder.BuildCandidate(tx)
	if err != nil {
		t.Fatalf("BuildCandidate: %v", err)
	}

	if candidate.Block.Hash() != sealed.Hash() {
		t.Errorf("candidate hash = %s, sealed hash = %s", candidate.Block.Hash(), sealed.Hash())
	}
	if candidate.Block.Root() != sealed.Root() {
		t.Errorf("candidate state root = %s, sealed = %s", candidate.Block.Root(), sealed.Root())
	}
	if candidate.Block.ReceiptHash() != sealed.ReceiptHash() {
		t.Errorf("candidate receipts root = %s, sealed = %s", candidate.Block.ReceiptHash(), sealed.ReceiptHash())
	}
	if candidate.Block.GasUsed() != sealed.GasUsed() {
		t.Errorf("candidate gasUsed = %d, sealed = %d", candidate.Block.GasUsed(), sealed.GasUsed())
	}
	if candidate.Receipt.GasUsed != receipt.GasUsed {
		t.Errorf("candidate receipt gasUsed = %d, sealed receipt = %d", candidate.Receipt.GasUsed, receipt.GasUsed)
	}
	if candidate.Parent != sealed.ParentHash() {
		t.Errorf("candidate parent = %s, want %s", candidate.Parent, sealed.ParentHash())
	}
}

// TestBuildCandidateLeavesTheChainUntouched is the other half of the
// contract: a proposer whose round times out, or whose block loses the
// height, must be indistinguishable from one that never proposed. If
// speculation left state behind, a validator that lost many rounds would
// accumulate trie nodes for blocks that never existed — and, worse, a
// candidate committed to the real database would let a subsequent audit walk
// into state no block accounts for.
func TestBuildCandidateLeavesTheChainUntouched(t *testing.T) {
	seq, db := newCandidateSequencer(t)

	key := mustHardhatAccount0(t)
	to := common.HexToAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")

	beforeHeight, beforeHash, err := seq.HeadInfo()
	if err != nil {
		t.Fatalf("HeadInfo: %v", err)
	}
	beforeKeys := countKeys(t, db)

	// Nonce 0 every time, deliberately: because no candidate is ever
	// committed, the account nonce never advances, so the *same* transaction
	// stays valid. That a third build succeeds where a third SubmitTx would
	// have failed with "nonce too high" is itself the proof that nothing was
	// committed.
	tx := mustSignTx(t, key, big.NewInt(testChainID), 0, &to, big.NewInt(1), 21_000, nil)
	for i := range 3 {
		if _, err := seq.BuildCandidate(tx); err != nil {
			t.Fatalf("BuildCandidate #%d: %v", i+1, err)
		}
	}

	afterHeight, afterHash, err := seq.HeadInfo()
	if err != nil {
		t.Fatalf("HeadInfo after: %v", err)
	}
	if afterHeight != beforeHeight || afterHash != beforeHash {
		t.Errorf("head moved: %d/%s -> %d/%s", beforeHeight, beforeHash, afterHeight, afterHash)
	}
	if afterKeys := countKeys(t, db); afterKeys != beforeKeys {
		t.Errorf("BuildCandidate wrote to the chain database: %d keys before, %d after", beforeKeys, afterKeys)
	}
}

// TestBuildCandidateRejectsARevertBeforeAnyoneVotes keeps the client contract
// intact under consensus. MASTER §10 pitfall 2: a reverting transaction is
// never mined and the caller gets the revert data at submission time — mobile
// and web both decode custom Solidity errors from it. Discovering the revert
// during consensus instead would mean either mining a failed transaction or
// having no channel to report it on, so the proposer must find out while the
// caller is still waiting.
func TestBuildCandidateRejectsARevertBeforeAnyoneVotes(t *testing.T) {
	seq, db := newCandidateSequencer(t)

	key := mustHardhatAccount0(t)
	// revertRuntime is the shared fixture from testcontracts_test.go: a
	// contract that always reverts with a 4-byte custom-error selector.
	_, addr := deploy(t, seq, key, big.NewInt(testChainID), 0, revertRuntime())

	beforeKeys := countKeys(t, db)
	tx := mustSignTx(t, key, big.NewInt(testChainID), 1, &addr, big.NewInt(0), 200_000, nil)

	_, err := seq.BuildCandidate(tx)
	if err == nil {
		t.Fatal("BuildCandidate accepted a transaction that reverts")
	}
	var revertErr *RevertError
	if !errors.As(err, &revertErr) {
		t.Fatalf("BuildCandidate error = %T (%v), want *RevertError — the same type SubmitTx returns", err, err)
	}
	if afterKeys := countKeys(t, db); afterKeys != beforeKeys {
		t.Errorf("a reverting candidate wrote to the database: %d keys before, %d after", beforeKeys, afterKeys)
	}
}

// TestVerifyCandidateAcceptsAPeersBlockAndRejectsATamperedOne is the check a
// validator runs before it PREPAREs. Two independent chains execute the same
// transaction; one proposes, the other verifies. The verification must reuse
// replay.go — which is why the tampered case asserts on *ReplayMismatch, the
// same structured error cmd/audit prints.
func TestVerifyCandidateAcceptsAPeersBlockAndRejectsATamperedOne(t *testing.T) {
	proposer, _ := newCandidateSequencer(t)
	validator, _ := newCandidateSequencer(t)

	key := mustHardhatAccount0(t)
	to := common.HexToAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")

	// No pinned timestamp here, unlike the hash-equality test: this block has
	// to pass VerifyCandidate's MaxFutureDrift bound, so it must be dated
	// around now rather than at a fixed constant.
	tx := mustSignTx(t, key, big.NewInt(testChainID), 0, &to, big.NewInt(1), 21_000, nil)
	candidate, err := proposer.BuildCandidate(tx)
	if err != nil {
		t.Fatalf("BuildCandidate: %v", err)
	}

	if err := validator.VerifyCandidate(candidate.Block); err != nil {
		t.Fatalf("VerifyCandidate rejected an honest block: %v", err)
	}
	// Verification must not adopt: the block becomes this node's only through
	// ApplyExternalBlock, after consensus.
	if height, _, err := validator.HeadInfo(); err != nil || height != 0 {
		t.Errorf("VerifyCandidate moved the head to %d (err %v), want it left at genesis", height, err)
	}

	// Tamper with the state root. Re-execution must disagree.
	header := candidate.Block.Header()
	header.Root = common.HexToHash("0xdeadbeef")
	tampered := candidate.Block.WithSeal(header)

	err = validator.VerifyCandidate(tampered)
	if err == nil {
		t.Fatal("VerifyCandidate accepted a block whose state root was rewritten")
	}
	var mismatch *ReplayMismatch
	if !errors.As(err, &mismatch) {
		t.Fatalf("VerifyCandidate error = %T (%v), want *ReplayMismatch", err, err)
	}
	if mismatch.Field != "stateRoot" {
		t.Errorf("mismatch field = %q, want %q", mismatch.Field, "stateRoot")
	}
}

// TestVerifyCandidateRejectsAFarFutureTimestamp covers MaxFutureDrift. The
// chain itself does not care — replay uses the stored timestamp, so the block
// would verify — but Voting.sol's phase deadlines are block.timestamp
// comparisons, and timestamps must strictly increase, so a single block dated
// years ahead would expire every deadline in the election irreversibly.
func TestVerifyCandidateRejectsAFarFutureTimestamp(t *testing.T) {
	proposer, _ := newCandidateSequencer(t)
	validator, _ := newCandidateSequencer(t)

	// Push the proposer's clock past what a validator will tolerate. It
	// builds a perfectly well-formed block; only its date is unacceptable.
	future := uint64(time.Now().Add(MaxFutureDrift + time.Hour).Unix())
	if err := proposer.SetNextBlockTimestamp(future); err != nil {
		t.Fatalf("SetNextBlockTimestamp: %v", err)
	}

	key := mustHardhatAccount0(t)
	to := common.HexToAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")
	tx := mustSignTx(t, key, big.NewInt(testChainID), 0, &to, big.NewInt(1), 21_000, nil)

	candidate, err := proposer.BuildCandidate(tx)
	if err != nil {
		t.Fatalf("BuildCandidate: %v", err)
	}
	if candidate.Block.Time() != future {
		t.Fatalf("candidate timestamp = %d, want the pinned %d", candidate.Block.Time(), future)
	}

	err = validator.VerifyCandidate(candidate.Block)
	if err == nil {
		t.Fatal("VerifyCandidate accepted a block dated an hour past the drift bound")
	}
	var mismatch *ReplayMismatch
	if !errors.As(err, &mismatch) {
		t.Fatalf("VerifyCandidate error = %T (%v), want *ReplayMismatch", err, err)
	}
	if mismatch.Field != "timestamp" {
		t.Errorf("mismatch field = %q, want %q", mismatch.Field, "timestamp")
	}

	// The same block a few seconds ahead is fine — the bound is drift, not a
	// ban on being slightly ahead.
	if err := proposer.SetNextBlockTimestamp(uint64(time.Now().Add(2 * time.Second).Unix())); err != nil {
		t.Fatalf("SetNextBlockTimestamp (near): %v", err)
	}
	near, err := proposer.BuildCandidate(tx)
	if err != nil {
		t.Fatalf("BuildCandidate (near): %v", err)
	}
	if err := validator.VerifyCandidate(near.Block); err != nil {
		t.Errorf("VerifyCandidate rejected a block two seconds ahead: %v", err)
	}
}

// TestClockAdoptionIsGatedByTheOption pins the one behaviour difference
// ApplyExternalBlock has between the two modes.
//
// Under consensus every validator must inherit the proposer's clock, or a
// time jump the cluster agreed on is undone the moment the proposership
// rotates and the chain advances one second per block thereafter. In solo
// mode a replica's clock is never consulted, so adopting would be a change
// with no purpose — and this file's whole premise is that solo behaviour is
// untouched.
func TestClockAdoptionIsGatedByTheOption(t *testing.T) {
	// A block dated a day ahead, produced by some other node.
	proposer, _ := newCandidateSequencer(t)
	ahead := uint64(time.Now().Add(24 * time.Hour).Unix())
	if err := proposer.SetNextBlockTimestamp(ahead); err != nil {
		t.Fatalf("SetNextBlockTimestamp: %v", err)
	}
	block, err := proposer.MineEmptyBlock()
	if err != nil {
		t.Fatalf("MineEmptyBlock: %v", err)
	}

	tests := []struct {
		name       string
		adopt      bool
		wantOffset bool
	}{
		{name: "bft mode adopts the proposer's clock", adopt: true, wantOffset: true},
		{name: "solo mode leaves the local clock alone", adopt: false, wantOffset: false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			db, err := storage.Open(t.TempDir())
			if err != nil {
				t.Fatalf("storage.Open: %v", err)
			}
			t.Cleanup(func() { _ = db.Close() })

			cfg := testConfig(testChainID, 60_000_000)
			if _, err := state.EnsureGenesis(db, cfg); err != nil {
				t.Fatalf("EnsureGenesis: %v", err)
			}
			follower := New(db, state.ChainConfig(cfg.ChainID), cfg.BlockGasLimit,
				WithClockAdoption(tc.adopt))

			if err := follower.ApplyExternalBlock(block); err != nil {
				t.Fatalf("ApplyExternalBlock: %v", err)
			}

			// A day is 86,400s; anything above an hour is unambiguously the
			// adopted jump rather than test-execution jitter.
			gotOffset := follower.DevOffsetSeconds() > 3600
			if gotOffset != tc.wantOffset {
				t.Errorf("dev offset after applying a block dated a day ahead = %ds (adopted=%v), want adopted=%v",
					follower.DevOffsetSeconds(), gotOffset, tc.wantOffset)
			}
		})
	}
}

// TestBuildEmptyAndSysOpCandidatesMatchTheirSealedForm covers the other two
// build paths. They exist because a validator may not seal outside the
// protocol even for a dev method: a node that mined its own empty block would
// occupy a height its peers were voting on and fork the cluster immediately.
func TestBuildEmptyAndSysOpCandidatesMatchTheirSealedForm(t *testing.T) {
	const pinned = 1_800_000_000
	target := common.HexToAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")

	tests := []struct {
		name  string
		seal  func(s *Sequencer) (*types.Block, error)
		build func(s *Sequencer) (*Candidate, error)
	}{
		{
			name: "empty block",
			seal: func(s *Sequencer) (*types.Block, error) { return s.MineEmptyBlockAt(pinned) },
			build: func(s *Sequencer) (*Candidate, error) {
				at := uint64(pinned)
				return s.BuildEmptyCandidate(&at)
			},
		},
		{
			name: "system-op block",
			seal: func(s *Sequencer) (*types.Block, error) {
				if err := s.SetNextBlockTimestamp(pinned); err != nil {
					return nil, err
				}
				return s.SetBalance(target, big.NewInt(12345))
			},
			build: func(s *Sequencer) (*Candidate, error) {
				if err := s.SetNextBlockTimestamp(pinned); err != nil {
					return nil, err
				}
				return s.BuildSysOpCandidate(&SysOp{
					Kind: SysOpSetBalance, Address: target, Value: big.NewInt(12345),
				})
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			sealer, _ := newTestSequencer(t)
			builder, _ := newCandidateSequencer(t)

			sealed, err := tc.seal(sealer)
			if err != nil {
				t.Fatalf("seal: %v", err)
			}
			candidate, err := tc.build(builder)
			if err != nil {
				t.Fatalf("build: %v", err)
			}
			if candidate.Block.Hash() != sealed.Hash() {
				t.Errorf("candidate hash = %s, sealed hash = %s", candidate.Block.Hash(), sealed.Hash())
			}
		})
	}
}
