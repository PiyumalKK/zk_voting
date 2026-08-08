package consensus

import (
	"context"
	"crypto/ecdsa"
	"math/big"
	"sync"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethdb"

	"zk-blockchain/internal/chain"
	"zk-blockchain/internal/config"
	"zk-blockchain/internal/state"
	"zk-blockchain/internal/storage"
)

// The in-process four-validator harness.
//
// Every node here is a *real* chain.Sequencer over a *real* Pebble database in
// t.TempDir(), running the *production* Engine — the same choice
// internal/p2p/testutil_test.go makes, and for the same reason. The property
// under test is that four independently-verifying chains converge on the same
// blocks; a fake chain would prove only that the engine talks to itself
// consistently.
//
// Only the transport is substituted, and only to gain the two powers a test
// needs and a network does not: killing a node instantly, and making one
// misbehave. Both are implemented by wrapping delivery, never by branching
// inside the engine, so what these tests exercise is the code that ships.

// testRoundTimeout keeps round changes fast enough to test. Production
// defaults to 4s; the protocol is timing-independent, so shrinking it changes
// only how long the tests take.
const testRoundTimeout = 250 * time.Millisecond

type testNode struct {
	name   string
	key    *ecdsa.PrivateKey
	val    Validator
	seq    *chain.Sequencer
	db     ethdb.Database
	seals  *MemorySealStore
	engine *Engine
	cancel context.CancelFunc
}

// testNet wires N engines' transports to each other in memory.
type testNet struct {
	t     *testing.T
	vs    *ValidatorSet
	nodes map[string]*testNode
	order []string

	mu   sync.Mutex
	down map[string]bool
	// tamper, when set, may rewrite or suppress a message on its way from one
	// node to another. It is how a Byzantine validator is built without
	// forking the engine.
	tamper func(from, to string, msg *SignedMessage) *SignedMessage
}

// memTransport is one node's view of the network.
type memTransport struct {
	net  *testNet
	from string
}

func (tr *memTransport) Broadcast(msg *SignedMessage) {
	tr.net.deliver(tr.from, msg)
}

// deliver fans a message out to every other live node, applying the kill list
// and any tampering.
func (n *testNet) deliver(from string, msg *SignedMessage) {
	n.mu.Lock()
	if n.down[from] {
		// A killed node's messages never leave it, which is what makes Kill
		// model a stopped process rather than a silent one.
		n.mu.Unlock()
		return
	}
	targets := make([]string, 0, len(n.order))
	for _, name := range n.order {
		if name != from && !n.down[name] {
			targets = append(targets, name)
		}
	}
	tamper := n.tamper
	n.mu.Unlock()

	for _, to := range targets {
		out := msg
		if tamper != nil {
			out = tamper(from, to, msg)
			if out == nil {
				continue
			}
		}
		// Re-encode through the wire format so the tests exercise the same
		// serialisation the network uses, including the signature check that
		// binds a proposal's body to its hash.
		received, err := out.Wire().Decode()
		if err != nil {
			continue
		}
		n.nodes[to].engine.Deliver(received)
	}
}

func newTestNet(t *testing.T, names ...string) *testNet {
	t.Helper()
	if len(names) == 0 {
		names = testValidatorNames
	}

	entries := make([]config.ValidatorEntry, 0, len(names))
	keys := make(map[string]*ecdsa.PrivateKey, len(names))
	for i, name := range names {
		key := mustKey(t, testKeys[i])
		keys[name] = key
		entries = append(entries, config.ValidatorEntry{Name: name, Address: crypto.PubkeyToAddress(key.PublicKey)})
	}
	vs, err := NewValidatorSet(entries, 0)
	if err != nil {
		t.Fatalf("NewValidatorSet: %v", err)
	}

	net := &testNet{
		t:     t,
		vs:    vs,
		nodes: make(map[string]*testNode, len(names)),
		order: names,
		down:  make(map[string]bool),
	}

	for _, name := range names {
		v, _ := vs.ByName(name)
		node := &testNode{name: name, key: keys[name], val: v, seals: NewMemorySealStore()}
		node.seq, node.db = newConsensusChain(t)

		engine, err := NewEngine(Config{
			ChainID:       testChainID,
			Self:          v,
			Key:           node.key,
			Validators:    vs,
			RoundTimeout:  testRoundTimeout,
			SubmitTimeout: 20 * time.Second,
			Chain:         node.seq,
			Seals:         node.seals,
			Transport:     &memTransport{net: net, from: name},
			CatchUp:       func() { net.catchUp(name) },
		})
		if err != nil {
			t.Fatalf("NewEngine(%s): %v", name, err)
		}
		node.engine = engine
		net.nodes[name] = node
	}

	for _, name := range names {
		node := net.nodes[name]
		ctx, cancel := context.WithCancel(context.Background())
		node.cancel = cancel
		go node.engine.Run(ctx)
	}
	t.Cleanup(func() {
		for _, node := range net.nodes {
			node.cancel()
		}
	})

	return net
}

// newConsensusChain builds one validator's chain with the production options.
func newConsensusChain(t *testing.T) (*chain.Sequencer, ethdb.Database) {
	t.Helper()
	db, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	cfg := &config.Config{ChainID: testChainID, BlockGasLimit: 60_000_000}
	if _, err := state.EnsureGenesis(db, cfg); err != nil {
		t.Fatalf("EnsureGenesis: %v", err)
	}
	seq := chain.New(db, state.ChainConfig(cfg.ChainID), cfg.BlockGasLimit,
		chain.WithScratchDB(storage.NewReplayOverlay),
		chain.WithClockAdoption(true),
	)
	return seq, db
}

// catchUp stands in for p2p.Follower: it copies finalized blocks from the
// most advanced live peer, and — crucially — applies each one through
// ApplyExternalBlock, so a rejoining node re-executes and independently
// verifies everything it missed rather than trusting a peer's word.
func (n *testNet) catchUp(name string) {
	n.mu.Lock()
	if n.down[name] {
		n.mu.Unlock()
		return
	}
	n.mu.Unlock()

	me := n.nodes[name]
	local, _, err := me.seq.HeadInfo()
	if err != nil {
		return
	}

	var best *testNode
	bestHeight := local
	for _, other := range n.order {
		if other == name {
			continue
		}
		h, _, err := n.nodes[other].seq.HeadInfo()
		if err == nil && h > bestHeight {
			best, bestHeight = n.nodes[other], h
		}
	}
	if best == nil {
		return
	}

	for h := local + 1; h <= bestHeight; h++ {
		block, err := best.seq.BlockByNumber(h)
		if err != nil {
			return
		}
		if err := me.seq.ApplyExternalBlock(block); err != nil {
			return
		}
		// Seals follow the blocks, exactly as the real follower pulls
		// /p2p/commitseals after each catch-up page.
		if seals, err := best.seals.Get(h, block.Hash()); err == nil && seals != nil {
			_ = me.seals.Put(h, block.Hash(), seals)
		}
	}
}

// Kill stops a validator: it neither sends nor receives. The process keeps
// running, which models `systemctl stop zk-node` closely enough for what
// these tests assert — that the *others* carry on.
func (n *testNet) Kill(names ...string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, name := range names {
		n.down[name] = true
	}
}

// Revive puts a validator back on the network and asks it to catch up, the
// way a restarted node's follower loop would.
func (n *testNet) Revive(names ...string) {
	n.mu.Lock()
	for _, name := range names {
		delete(n.down, name)
	}
	n.mu.Unlock()

	for _, name := range names {
		n.catchUp(name)
	}
}

func (n *testNet) isDown(name string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.down[name]
}

// liveNodes lists validators currently on the network, in protocol order.
func (n *testNet) liveNodes() []string {
	var out []string
	for _, name := range n.order {
		if !n.isDown(name) {
			out = append(out, name)
		}
	}
	return out
}

// submitTarget picks where a write goes: the current proposer when it is
// reachable, otherwise any live validator.
//
// This mirrors what the deployed system does. rpc.NewDynamicForwarder sends a
// transaction to the current proposer and falls back to handling it locally
// when that node is unreachable — at which point the round-change machinery
// carries it, one round later. Both paths are exercised by the tests below.
func (n *testNet) submitTarget() string {
	live := n.liveNodes()
	if len(live) == 0 {
		n.t.Fatal("every validator is down")
	}
	// The *highest* live head, not the first node's: nodes commit
	// independently, so one can still be a block behind when another has
	// already returned a receipt, and aiming at its stale height would target
	// the wrong proposer.
	proposer := n.vs.ProposerAt(n.maxLiveHeight()+1, 0)
	if !n.isDown(proposer.Name) {
		return proposer.Name
	}
	return live[0]
}

// Submit sends a value transfer through consensus and returns its receipt.
func (n *testNet) Submit(nonce uint64) (*types.Receipt, error) {
	return n.SubmitTo(n.submitTarget(), nonce)
}

func (n *testNet) SubmitTo(name string, nonce uint64) (*types.Receipt, error) {
	tx := n.transfer(nonce)
	return n.nodes[name].engine.SubmitTx(tx)
}

var transferTo = common.HexToAddress("0x976EA74026E726554dB657fA54763abd0C3a0aa9")

// transfer builds a value transfer signed by a genesis-funded account.
func (n *testNet) transfer(nonce uint64) *types.Transaction {
	n.t.Helper()
	key := mustKey(n.t, testKeys[0])
	tx := types.NewTx(&types.LegacyTx{
		Nonce: nonce, To: &transferTo, Value: big.NewInt(1),
		Gas: 21_000, GasPrice: big.NewInt(0),
	})
	signed, err := types.SignTx(tx, types.LatestSignerForChainID(big.NewInt(testChainID)), key)
	if err != nil {
		n.t.Fatalf("SignTx: %v", err)
	}
	return signed
}

// heights reports every node's chain height, including killed ones.
func (n *testNet) heights() map[string]uint64 {
	out := make(map[string]uint64, len(n.order))
	for _, name := range n.order {
		h, _, err := n.nodes[name].seq.HeadInfo()
		if err != nil {
			n.t.Fatalf("HeadInfo(%s): %v", name, err)
		}
		out[name] = h
	}
	return out
}

func (n *testNet) height(name string) uint64 { return n.heights()[name] }

// maxLiveHeight is the highest chain height among reachable validators.
func (n *testNet) maxLiveHeight() uint64 {
	var max uint64
	for _, name := range n.liveNodes() {
		if h := n.height(name); h > max {
			max = h
		}
	}
	return max
}

// waitFor polls until cond holds or the deadline passes. Copied in spirit
// from internal/p2p/testutil_test.go so the two suites read the same way.
func (n *testNet) waitFor(timeout time.Duration, what string, cond func() bool) {
	n.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	n.t.Fatalf("timed out after %s waiting for %s (heights: %v)", timeout, what, n.heights())
}

// requireQuorumSeals asserts every block from 1..height on `name` carries at
// least Q commit signatures from distinct validators. This is acceptance
// criterion 1, and the safety half of criterion 3.
func (n *testNet) requireQuorumSeals(name string, height uint64) {
	n.t.Helper()
	node := n.nodes[name]

	for h := uint64(1); h <= height; h++ {
		block, err := node.seq.BlockByNumber(h)
		if err != nil {
			n.t.Fatalf("%s: BlockByNumber(%d): %v", name, h, err)
		}
		seals, err := node.seals.Get(h, block.Hash())
		if err != nil {
			n.t.Fatalf("%s: seals for block %d: %v", name, h, err)
		}
		if seals == nil {
			n.t.Fatalf("%s: block %d has no commit certificate", name, h)
		}

		signers, err := SealedBy(testChainID, n.vs, h, block.Hash(), seals)
		if err != nil {
			n.t.Fatalf("%s: block %d certificate does not verify: %v", name, h, err)
		}
		if len(signers) < n.vs.Quorum() {
			n.t.Fatalf("%s: block %d finalized with %d signatures, below the quorum of %d",
				name, h, len(signers), n.vs.Quorum())
		}
	}
}

// requireConverged asserts every live node holds an identical chain.
func (n *testNet) requireConverged() uint64 {
	n.t.Helper()
	live := n.liveNodes()
	if len(live) == 0 {
		n.t.Fatal("no live validators")
	}

	wantHeight, wantHash, err := n.nodes[live[0]].seq.HeadInfo()
	if err != nil {
		n.t.Fatalf("HeadInfo(%s): %v", live[0], err)
	}
	for _, name := range live[1:] {
		h, hash, err := n.nodes[name].seq.HeadInfo()
		if err != nil {
			n.t.Fatalf("HeadInfo(%s): %v", name, err)
		}
		if h != wantHeight || hash != wantHash {
			n.t.Fatalf("%s is at %d/%s but %s is at %d/%s — the validators disagree about the chain",
				name, h, hash, live[0], wantHeight, wantHash)
		}
	}
	return wantHeight
}
