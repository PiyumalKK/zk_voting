package consensus

import (
	"errors"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/rlp"
)

// These tests are the acceptance criteria, in process. Each names the
// criterion it discharges; the process-level versions live in
// e2e/bft-cluster-test.mjs and CONSENSUS.md's kill-node demonstration.

// --- Criterion 1: a block finalizes only with a quorum of distinct signers ---

func TestFourValidatorsFinalizeWithThreeDistinctSigners(t *testing.T) {
	net := newTestNet(t)

	for nonce := range uint64(3) {
		if _, err := net.Submit(nonce); err != nil {
			t.Fatalf("submit %d: %v", nonce, err)
		}
	}

	net.waitFor(10*time.Second, "all four validators to reach block 3", func() bool {
		h := net.heights()
		return h["authority"] == 3 && h["jvp"] == 3 && h["unp"] == 3 && h["sjb"] == 3
	})

	// Every validator must hold the identical chain — not merely the same
	// height. Two nodes can agree on a height and disagree on every block in
	// it, which is why HeadInfo reports the hash as well.
	if got := net.requireConverged(); got != 3 {
		t.Fatalf("converged at height %d, want 3", got)
	}

	// And every block on every node must carry a full certificate.
	for _, name := range net.order {
		net.requireQuorumSeals(name, 3)
	}
}

// TestEveryValidatorsCertificateIndependentlyProvesQuorum.
//
// Note what is deliberately *not* asserted here: that the four certificates
// are byte-identical. They need not be, and expecting them to be would be a
// misunderstanding of the protocol. A validator finalizes the instant it
// holds Q commits, so with N=4 and Q=3 one node may commit on the first three
// signatures it receives while another, a few milliseconds later, holds all
// four. Both certificates are complete and correct; they are simply different
// subsets of the same agreement.
//
// What must hold on every node is the property the certificate exists for:
// it verifies against the validator set, and it names at least Q *distinct*
// validators for that exact block. (Byte-level determinism is still worth
// having and is tested where it is actually guaranteed — for a fixed set of
// signatures — in TestStoredSealsAreOrderIndependent.)
func TestEveryValidatorsCertificateIndependentlyProvesQuorum(t *testing.T) {
	net := newTestNet(t)

	if _, err := net.Submit(0); err != nil {
		t.Fatalf("submit: %v", err)
	}
	net.waitFor(10*time.Second, "block 1 everywhere", func() bool {
		h := net.heights()
		return h["authority"] == 1 && h["jvp"] == 1 && h["unp"] == 1 && h["sjb"] == 1
	})

	block, err := net.nodes["authority"].seq.BlockByNumber(1)
	if err != nil {
		t.Fatalf("BlockByNumber: %v", err)
	}

	for _, name := range net.order {
		seals, err := net.nodes[name].seals.Get(1, block.Hash())
		if err != nil || seals == nil {
			t.Fatalf("%s has no certificate for block 1 (err %v)", name, err)
		}

		signers, err := SealedBy(testChainID, net.vs, 1, block.Hash(), seals)
		if err != nil {
			t.Fatalf("%s's certificate for block 1 does not verify: %v", name, err)
		}
		if len(signers) < net.vs.Quorum() {
			t.Errorf("%s's certificate names %d validators, below the quorum of %d", name, len(signers), net.vs.Quorum())
		}

		// Whatever subset it holds, it must be stored in the canonical sorted
		// order, so two nodes holding the same subset agree byte for byte.
		for i := 1; i < len(seals.Seals); i++ {
			if string(seals.Seals[i-1]) > string(seals.Seals[i]) {
				t.Errorf("%s stored its certificate unsorted at index %d", name, i)
			}
		}
	}
}

// --- Criterion 2: any one validator down, and the chain keeps advancing ---

// TestChainAdvancesWithAnyOneValidatorDown is the promise this whole feature
// exists to make: no single party can stop the election. It is run against
// every validator in turn, including `authority`, because "the authority
// cannot halt the vote" is precisely the property that distinguishes this
// from the single-sequencer design it replaces.
func TestChainAdvancesWithAnyOneValidatorDown(t *testing.T) {
	for _, victim := range testValidatorNames {
		t.Run("without "+victim, func(t *testing.T) {
			net := newTestNet(t)

			// Establish a baseline with everyone up, so the test proves the
			// chain *kept* going rather than that it started going.
			if _, err := net.Submit(0); err != nil {
				t.Fatalf("baseline submit: %v", err)
			}
			net.waitFor(10*time.Second, "block 1 everywhere", func() bool {
				return net.maxLiveHeight() >= 1
			})

			net.Kill(victim)

			before := net.maxLiveHeight()
			for nonce := uint64(1); nonce <= 3; nonce++ {
				if _, err := net.Submit(nonce); err != nil {
					t.Fatalf("submit %d with %s down: %v", nonce, victim, err)
				}
			}

			net.waitFor(20*time.Second, "the surviving three to advance three blocks", func() bool {
				return net.maxLiveHeight() >= before+3
			})

			// The three survivors must agree, and — the safety half — every
			// block they produced must still carry a full quorum. Liveness
			// must never have been bought by lowering the bar.
			net.requireConverged()
			for _, name := range net.liveNodes() {
				net.requireQuorumSeals(name, net.height(name))
			}
		})
	}
}

// --- Criterion 3: two down, and the chain halts rather than weakening ---

// TestTwoValidatorsDownHaltsWithoutEverFinalizingBelowQuorum is the safety
// counterpart to the test above, and the more important of the two. With two
// of four gone, only two remain — one short of the quorum of three. The
// correct behaviour is to stop.
//
// A system that "degraded gracefully" here by finalizing on two signatures
// would be worse than useless: it would mean two parties could agree an
// election result between themselves, which is the exact outcome Byzantine
// fault tolerance is purchased to prevent.
func TestTwoValidatorsDownHaltsWithoutEverFinalizingBelowQuorum(t *testing.T) {
	net := newTestNet(t)

	if _, err := net.Submit(0); err != nil {
		t.Fatalf("baseline submit: %v", err)
	}
	net.waitFor(10*time.Second, "block 1 everywhere", func() bool {
		return net.maxLiveHeight() >= 1
	})

	net.Kill("authority", "jvp")
	frozen := net.heights()

	// Submitting must fail rather than hang forever or, worse, succeed.
	survivor := net.liveNodes()[0]
	net.nodes[survivor].engine.cfg.SubmitTimeout = 2 * time.Second
	_, err := net.SubmitTo(survivor, 1)
	if err == nil {
		t.Fatal("a transaction was accepted while the cluster was below quorum")
	}
	if !errors.Is(err, ErrConsensusTimeout) {
		t.Errorf("error = %v, want ErrConsensusTimeout", err)
	}

	// Give the round timer several more chances to do the wrong thing.
	time.Sleep(2 * time.Second)

	for name, height := range net.heights() {
		if height != frozen[name] {
			t.Errorf("%s advanced from %d to %d with only two validators reachable", name, frozen[name], height)
		}
	}

	// The decisive assertion: nothing anywhere was ever finalized below
	// quorum, including on the nodes that kept running.
	for _, name := range net.order {
		net.requireQuorumSeals(name, net.height(name))
	}
}

// TestRestoringAValidatorResumesProgress completes criterion 3: the halt is a
// pause, not a failure. Bring one back and the election continues, including
// the transaction that could not be mined while quorum was lost.
func TestRestoringAValidatorResumesProgress(t *testing.T) {
	net := newTestNet(t)

	if _, err := net.Submit(0); err != nil {
		t.Fatalf("baseline submit: %v", err)
	}
	net.waitFor(10*time.Second, "block 1 everywhere", func() bool {
		return net.maxLiveHeight() >= 1
	})

	net.Kill("authority", "jvp")
	frozen := net.maxLiveHeight()

	survivor := net.liveNodes()[0]
	net.nodes[survivor].engine.cfg.SubmitTimeout = 2 * time.Second
	if _, err := net.SubmitTo(survivor, 1); err == nil {
		t.Fatal("a transaction was mined below quorum")
	}

	// One validator returns: three reachable, quorum restored.
	net.nodes[survivor].engine.cfg.SubmitTimeout = 20 * time.Second
	net.Revive("jvp")

	if _, err := net.Submit(1); err != nil {
		t.Fatalf("submit after restoring quorum: %v", err)
	}
	net.waitFor(20*time.Second, "the chain to advance once quorum is restored", func() bool {
		return net.maxLiveHeight() > frozen
	})

	net.requireConverged()
	for _, name := range net.liveNodes() {
		net.requireQuorumSeals(name, net.height(name))
	}
}

// --- Criterion 4: leader rotation ---

// TestRoundChangeRotatesPastADeadProposer isolates the liveness mechanism.
// The validator whose turn it is at the next height is killed while the other
// three stay up, so the *only* way the chain can advance is for a round
// change to rotate the proposership past the dead node.
func TestRoundChangeRotatesPastADeadProposer(t *testing.T) {
	net := newTestNet(t)

	if _, err := net.Submit(0); err != nil {
		t.Fatalf("baseline submit: %v", err)
	}
	net.waitFor(10*time.Second, "block 1 everywhere", func() bool {
		return net.maxLiveHeight() >= 1
	})

	// Whoever would propose block 2 in round 0 is removed.
	height := net.maxLiveHeight()
	doomed := net.vs.ProposerAt(height+1, 0)
	net.Kill(doomed.Name)

	if _, err := net.Submit(1); err != nil {
		t.Fatalf("submit with the round-0 proposer down: %v", err)
	}
	net.waitFor(20*time.Second, "a round change to carry the block past the dead proposer", func() bool {
		return net.maxLiveHeight() > height
	})

	// The block that landed must have been proposed by somebody else, and it
	// must still carry a full quorum.
	net.requireConverged()
	for _, name := range net.liveNodes() {
		net.requireQuorumSeals(name, net.height(name))
	}

	// The engine must actually have moved past round 0 to get here.
	var sawRoundChange bool
	for _, name := range net.liveNodes() {
		for h := uint64(1); h <= net.height(name); h++ {
			block, err := net.nodes[name].seq.BlockByNumber(h)
			if err != nil {
				continue
			}
			if seals, _ := net.nodes[name].seals.Get(h, block.Hash()); seals != nil && seals.Round > 0 {
				sawRoundChange = true
			}
		}
	}
	if !sawRoundChange {
		t.Error("no block finalized in a round above 0, so the dead proposer was never rotated past")
	}
}

// TestProposershipRotatesAcrossManyBlocks: with everyone healthy, the
// round-robin must actually spread proposing across the set. A schedule that
// silently favoured one node would reintroduce the single point of failure
// this design removes, and would still pass every other test here.
func TestProposershipRotatesAcrossManyBlocks(t *testing.T) {
	net := newTestNet(t)

	const blocks = 8
	for nonce := range uint64(blocks) {
		if _, err := net.Submit(nonce); err != nil {
			t.Fatalf("submit %d: %v", nonce, err)
		}
	}
	net.waitFor(30*time.Second, "eight blocks", func() bool {
		return net.maxLiveHeight() >= blocks
	})

	proposers := make(map[string]bool)
	for h := uint64(1); h <= blocks; h++ {
		block, err := net.nodes["authority"].seq.BlockByNumber(h)
		if err != nil {
			t.Fatalf("BlockByNumber(%d): %v", h, err)
		}
		seals, err := net.nodes["authority"].seals.Get(h, block.Hash())
		if err != nil || seals == nil {
			t.Fatalf("block %d has no certificate", h)
		}
		proposers[net.vs.ProposerAt(h, seals.Round).Name] = true
	}

	if len(proposers) < 3 {
		t.Errorf("eight blocks were proposed by only %d distinct validators (%v); the schedule is not rotating", len(proposers), proposers)
	}
}

// --- Criterion 5: a Byzantine proposer cannot equivocate its way to a fork ---

// TestEquivocatingProposerCannotFinalizeTwoBlocks is the Byzantine case.
//
// The engine under test is the production engine, unmodified. The attack is
// mounted by wrapping the *transport*: when the proposer broadcasts, half the
// validators receive block A and half receive a different block B, both
// correctly signed by the proposer for the same height and round. That is
// exactly what a malicious operator with a patched binary could do, and it is
// the canonical way to try to split a BFT cluster.
//
// The defences are three, and any one of them suffices: the (height, round,
// type, signer) dedup turns the second signature into recorded equivocation
// rather than a second vote; an honest validator that has already prepared A
// refuses to prepare B; and a validator that has locked A will not vote for
// anything else at that height in any later round. What must never happen is
// two blocks both reaching a quorum of three at the same height.
func TestEquivocatingProposerCannotFinalizeTwoBlocks(t *testing.T) {
	net := newTestNet(t)

	// Reach a known height first, so the equivocation targets a specific one.
	if _, err := net.Submit(0); err != nil {
		t.Fatalf("baseline submit: %v", err)
	}
	net.waitFor(10*time.Second, "block 1 everywhere", func() bool {
		return net.maxLiveHeight() >= 1
	})

	target := net.maxLiveHeight() + 1
	traitor := net.vs.ProposerAt(target, 0).Name

	// Half the network is told a different block for the target height. The
	// substitute is a validly-signed proposal for a block that differs only
	// in its timestamp, so it would verify on its own merits.
	var forged *types.Block
	net.mu.Lock()
	net.tamper = func(from, to string, msg *SignedMessage) *SignedMessage {
		if from != traitor || msg.Type != MsgProposal || msg.Height != target {
			return msg
		}
		// Only the second half of the set is lied to.
		if to != net.order[2] && to != net.order[3] {
			return msg
		}

		original, err := msg.Block()
		if err != nil {
			return msg
		}
		if forged == nil {
			header := original.Header()
			header.Time = original.Time() + 1 // a different, still-plausible block
			forged = original.WithSeal(header)
		}
		encoded, err := rlp.EncodeToBytes(forged)
		if err != nil {
			return msg
		}
		// Signed by the traitor's own key: this is equivocation, not forgery.
		lie, err := Sign(testChainID, net.nodes[traitor].key, Message{
			Type: MsgProposal, Height: msg.Height, Round: msg.Round,
			BlockHash: forged.Hash(), BlockRLP: encoded,
		})
		if err != nil {
			return msg
		}
		return lie
	}
	net.mu.Unlock()

	// The write goes to the traitor, because only the proposer can propose
	// and the attack has to actually happen for the test to mean anything.
	// The submission may well fail — a network split so that neither block
	// can reach quorum is the *safe* outcome, not a failure — so its error is
	// deliberately ignored. What matters is what is on disk afterwards.
	net.nodes[traitor].engine.cfg.SubmitTimeout = 3 * time.Second
	_, _ = net.SubmitTo(traitor, 1)
	time.Sleep(2 * time.Second)

	if forged == nil {
		t.Fatal("the traitor never equivocated, so this test proved nothing")
	}

	// The assertion: no two validators may hold different blocks at the same
	// height. This is the fork the attack was trying to create.
	seen := make(map[uint64]string)
	for _, name := range net.order {
		height := net.height(name)
		for h := uint64(1); h <= height; h++ {
			block, err := net.nodes[name].seq.BlockByNumber(h)
			if err != nil {
				t.Fatalf("%s: BlockByNumber(%d): %v", name, h, err)
			}
			hash := block.Hash().Hex()
			if previous, ok := seen[h]; ok && previous != hash {
				t.Fatalf("FORK at height %d: one validator has %s, another has %s", h, previous, hash)
			}
			seen[h] = hash
		}
		// And nothing anywhere was finalized without a full quorum.
		net.requireQuorumSeals(name, height)
	}

	// The forged block must not be anywhere: it was validly signed by the
	// proposer and would have re-executed cleanly, so the only thing that
	// stopped it was honest validators refusing to vote twice at one height.
	for _, name := range net.order {
		height := net.height(name)
		for h := uint64(1); h <= height; h++ {
			block, err := net.nodes[name].seq.BlockByNumber(h)
			if err != nil {
				continue
			}
			if block.Hash() == forged.Hash() {
				// Not automatically wrong — if *every* honest node took the
				// forged block and none took the original, that is still a
				// single consistent chain. The fork check above is the real
				// assertion; this only reports which side won, for the log.
				t.Logf("the cluster settled on the equivocated block at height %d (still fork-free)", h)
			}
		}
	}
}

// TestAValidatorRefusesAProposalItCannotReExecute: a vote means "I ran this
// block myself", so a proposal whose header does not follow from its contents
// must never gather a prepare — however well-signed it is. Without this a
// proposer could wedge the chain at a height nobody can commit, or worse,
// have a bad state root accepted.
func TestAValidatorRefusesAProposalItCannotReExecute(t *testing.T) {
	net := newTestNet(t)

	if _, err := net.Submit(0); err != nil {
		t.Fatalf("baseline submit: %v", err)
	}
	net.waitFor(10*time.Second, "block 1 everywhere", func() bool {
		return net.maxLiveHeight() >= 1
	})

	target := net.maxLiveHeight() + 1
	traitor := net.vs.ProposerAt(target, 0).Name

	// Every peer is sent a block whose state root has been rewritten.
	net.mu.Lock()
	net.tamper = func(from, to string, msg *SignedMessage) *SignedMessage {
		if from != traitor || msg.Type != MsgProposal || msg.Height != target {
			return msg
		}
		original, err := msg.Block()
		if err != nil {
			return msg
		}
		header := original.Header()
		header.Root = testBlockHash // a state root nothing produces
		corrupt := original.WithSeal(header)

		encoded, err := rlp.EncodeToBytes(corrupt)
		if err != nil {
			return msg
		}
		lie, err := Sign(testChainID, net.nodes[traitor].key, Message{
			Type: MsgProposal, Height: msg.Height, Round: msg.Round,
			BlockHash: corrupt.Hash(), BlockRLP: encoded,
		})
		if err != nil {
			return msg
		}
		return lie
	}
	net.mu.Unlock()

	net.nodes[net.order[0]].engine.cfg.SubmitTimeout = 3 * time.Second
	_, _ = net.SubmitTo(net.order[0], 1)
	time.Sleep(1500 * time.Millisecond)

	// No node may have adopted a block with the forged root.
	for _, name := range net.order {
		height := net.height(name)
		for h := uint64(1); h <= height; h++ {
			block, err := net.nodes[name].seq.BlockByNumber(h)
			if err != nil {
				t.Fatalf("%s: BlockByNumber(%d): %v", name, h, err)
			}
			if block.Root() == testBlockHash {
				t.Fatalf("%s adopted block %d with a state root that no execution produces", name, h)
			}
		}
	}
}

// --- Catch-up and rejoin ---

// TestARejoiningValidatorCatchesUpAndVotesAgain covers the operational story
// behind criteria 2 and 3: a validator that was down must be able to come
// back, verify everything it missed, and resume voting — with no handshake
// and no manual step.
//
// The gate on voting is the height window rather than a flag: a node at H-5
// buffers every message for H and tallies none of them, so it cannot vote at
// a height it has not evaluated. It starts participating the moment catch-up
// drags it forward.
func TestARejoiningValidatorCatchesUpAndVotesAgain(t *testing.T) {
	net := newTestNet(t)

	net.Kill("sjb")

	for nonce := range uint64(3) {
		if _, err := net.Submit(nonce); err != nil {
			t.Fatalf("submit %d: %v", nonce, err)
		}
	}
	net.waitFor(20*time.Second, "three blocks without sjb", func() bool {
		return net.maxLiveHeight() >= 3
	})

	if got := net.height("sjb"); got != 0 {
		t.Fatalf("sjb is at height %d while killed, want 0", got)
	}

	net.Revive("sjb")
	net.waitFor(20*time.Second, "sjb to catch up", func() bool {
		return net.height("sjb") == net.maxLiveHeight()
	})

	// It must hold the identical chain, having re-executed every block it
	// missed rather than trusting a peer's word for any of them.
	net.requireConverged()
	net.requireQuorumSeals("sjb", net.height("sjb"))

	// And it must be voting again: kill a different validator so the cluster
	// depends on sjb to make quorum at all.
	net.Kill("authority")
	before := net.maxLiveHeight()
	if _, err := net.Submit(3); err != nil {
		t.Fatalf("submit relying on the rejoined validator: %v", err)
	}
	net.waitFor(20*time.Second, "a block that needed sjb's vote", func() bool {
		return net.maxLiveHeight() > before
	})
	net.requireConverged()
}

// --- Quiescence ---

// TestAnIdleClusterProducesNoBlocks: the round timer arms only when there is
// something to propose. Without that rule an idle cluster would round-change
// forever, and criterion 3's "the height freezes" would be untestable —
// "frozen" could not be distinguished from "was never going to move".
//
// It also preserves the property MASTER §3 has always specified: blocks exist
// because someone wrote, not because time passed.
func TestAnIdleClusterProducesNoBlocks(t *testing.T) {
	net := newTestNet(t)

	if _, err := net.Submit(0); err != nil {
		t.Fatalf("submit: %v", err)
	}
	net.waitFor(10*time.Second, "block 1", func() bool { return net.maxLiveHeight() >= 1 })

	settled := net.heights()
	// Several round timeouts' worth of doing nothing.
	time.Sleep(10 * testRoundTimeout)

	for name, height := range net.heights() {
		if height != settled[name] {
			t.Errorf("%s produced blocks while idle: %d -> %d", name, settled[name], height)
		}
	}
}

// --- Solo-equivalence of the write surface ---

// TestARevertingTransactionIsRejectedBeforeAnyVote keeps the client contract
// identical between modes. MASTER §10 pitfall 2: a revert is reported at
// submission time with its raw data and mines nothing, because mobile and web
// both decode custom Solidity errors from it. Under consensus the proposer
// must therefore discover the revert while the caller is still waiting,
// rather than three phases later with nowhere to report it.
func TestARevertingTransactionIsRejectedBeforeAnyVote(t *testing.T) {
	net := newTestNet(t)

	// A transfer from an account with no balance: it fails validation, which
	// is the same class of early rejection a revert takes.
	tx := net.transfer(99) // a nonce far in the future
	before := net.heights()

	_, err := net.nodes["authority"].engine.SubmitTx(tx)
	if err == nil {
		t.Fatal("a transaction that cannot execute was accepted into consensus")
	}

	time.Sleep(3 * testRoundTimeout)
	for name, height := range net.heights() {
		if height != before[name] {
			t.Errorf("%s mined a block for a transaction that could not execute", name)
		}
	}
}

// TestEngineRefusesAConfigurationItCannotHonour: a node that is not in the
// set it was handed cannot vote, and starting anyway would leave it silently
// inert.
func TestEngineRefusesAConfigurationItCannotHonour(t *testing.T) {
	vs, keys := testSet(t)
	seq, _ := newConsensusChain(t)
	outsider := mustKey(t, outsiderKey)

	base := func() Config {
		v, _ := vs.ByName("authority")
		return Config{
			ChainID: testChainID, Self: v, Key: keys["authority"], Validators: vs,
			Chain: seq, Seals: NewMemorySealStore(), Transport: &memTransport{},
		}
	}

	tests := []struct {
		name   string
		mutate func(c *Config)
	}{
		{name: "no validator set", mutate: func(c *Config) { c.Validators = nil }},
		{name: "no signing key", mutate: func(c *Config) { c.Key = nil }},
		{name: "no chain", mutate: func(c *Config) { c.Chain = nil }},
		{name: "no seal store", mutate: func(c *Config) { c.Seals = nil }},
		{name: "no transport", mutate: func(c *Config) { c.Transport = nil }},
		{
			name: "this node is not in the set",
			mutate: func(c *Config) {
				c.Key = outsider
				c.Self = Validator{Name: "stranger"}
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := base()
			tc.mutate(&cfg)
			if _, err := NewEngine(cfg); err == nil {
				t.Error("NewEngine accepted a configuration it cannot honour")
			}
		})
	}
}
