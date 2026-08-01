package chain

import (
	"errors"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	gethrpc "github.com/ethereum/go-ethereum/rpc"
)

var testSysOpAddr = common.HexToAddress("0x000000000000000000000000000000000000dEaD")

// latest is shorthand for the block tag every read in this file uses.
const latest = gethrpc.LatestBlockNumber

func TestSysOpEncodeParseRoundTrip(t *testing.T) {
	tests := []struct {
		name     string
		op       *SysOp
		wantText string
	}{
		{
			name:     "one ether",
			op:       &SysOp{Kind: SysOpSetBalance, Address: testSysOpAddr, Value: big.NewInt(1_000_000_000_000_000_000)},
			wantText: "sysop:setBalance:0x000000000000000000000000000000000000dEaD:0xde0b6b3a7640000",
		},
		{
			name:     "zero balance encodes as 0x0, not 0x",
			op:       &SysOp{Kind: SysOpSetBalance, Address: testSysOpAddr, Value: big.NewInt(0)},
			wantText: "sysop:setBalance:0x000000000000000000000000000000000000dEaD:0x0",
		},
		{
			name: "value wider than 64 bits survives",
			op: &SysOp{
				Kind:    SysOpSetBalance,
				Address: common.HexToAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"),
				Value:   new(big.Int).Lsh(big.NewInt(1), 200),
			},
			wantText: "sysop:setBalance:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266:0x100000000000000000000000000000000000000000000000000",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			encoded := tt.op.Encode()
			if string(encoded) != tt.wantText {
				t.Fatalf("Encode() = %q, want %q", encoded, tt.wantText)
			}

			got, err := ParseSysOp(encoded)
			if err != nil {
				t.Fatalf("ParseSysOp(%q): %v", encoded, err)
			}
			if got.Kind != tt.op.Kind {
				t.Errorf("Kind = %q, want %q", got.Kind, tt.op.Kind)
			}
			if got.Address != tt.op.Address {
				t.Errorf("Address = %s, want %s", got.Address, tt.op.Address)
			}
			if got.Value.Cmp(tt.op.Value) != 0 {
				t.Errorf("Value = %s, want %s", got.Value, tt.op.Value)
			}
		})
	}
}

func TestParseSysOpRejectsNonSysOpAndCorruption(t *testing.T) {
	tests := []struct {
		name     string
		extra    string
		wantErr  error
		wantText string // substring the message must carry, "" to skip
	}{
		{"empty extra data (every ordinary block)", "", ErrNotSysOp, ""},
		{"genesis extra data", "zkchain-genesis", ErrNotSysOp, ""},
		{"prefix only", "sysop:", ErrMalformedSysOp, "colon-separated fields"},
		{"too few fields", "sysop:setBalance:0x000000000000000000000000000000000000dEaD", ErrMalformedSysOp, "colon-separated fields"},
		{"too many fields", "sysop:setBalance:0x000000000000000000000000000000000000dEaD:0x1:extra", ErrMalformedSysOp, "colon-separated fields"},
		{"unknown kind", "sysop:setNonce:0x000000000000000000000000000000000000dEaD:0x1", ErrUnknownSysOp, "setNonce"},
		{"truncated address", "sysop:setBalance:0xdEaD:0x1", ErrMalformedSysOp, "not a hex address"},
		{"non-hex balance", "sysop:setBalance:0x000000000000000000000000000000000000dEaD:beef", ErrMalformedSysOp, "balance"},
		{"balance missing 0x prefix", "sysop:setBalance:0x000000000000000000000000000000000000dEaD:1", ErrMalformedSysOp, "balance"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			op, err := ParseSysOp([]byte(tt.extra))
			if op != nil {
				t.Fatalf("ParseSysOp(%q) returned op %+v, want nil", tt.extra, op)
			}
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("ParseSysOp(%q) error = %v, want %v", tt.extra, err, tt.wantErr)
			}
			if tt.wantText != "" && !strings.Contains(err.Error(), tt.wantText) {
				t.Errorf("error %q does not mention %q", err, tt.wantText)
			}
		})
	}
}

// TestParseSysOpAcceptsLowercaseAddress guards the one asymmetry in the
// codec: Encode always emits an EIP-55 checksummed address, but a chain
// written by some future encoder (or a hand-edited fixture) may not be
// checksummed, and refusing to replay such a block would be a hard failure
// for M09's audit tool.
func TestParseSysOpAcceptsLowercaseAddress(t *testing.T) {
	op, err := ParseSysOp([]byte("sysop:setBalance:0x000000000000000000000000000000000000dead:0x1"))
	if err != nil {
		t.Fatalf("ParseSysOp: %v", err)
	}
	if op.Address != testSysOpAddr {
		t.Errorf("Address = %s, want %s", op.Address, testSysOpAddr)
	}
}

func TestSetBalanceSealsSysOpBlockAndOverwritesBalance(t *testing.T) {
	seq, _ := newTestSequencer(t)

	want := big.NewInt(1_000_000_000_000_000_000) // 1 ETH
	block, err := seq.SetBalance(testSysOpAddr, want)
	if err != nil {
		t.Fatalf("SetBalance: %v", err)
	}

	if block.NumberU64() != 1 {
		t.Errorf("block number = %d, want 1", block.NumberU64())
	}
	if len(block.Transactions()) != 0 {
		t.Errorf("sysop block has %d transactions, want 0", len(block.Transactions()))
	}

	op, err := ParseSysOp(block.Extra())
	if err != nil {
		t.Fatalf("ParseSysOp(block.Extra() = %q): %v", block.Extra(), err)
	}
	if op.Kind != SysOpSetBalance || op.Address != testSysOpAddr || op.Value.Cmp(want) != 0 {
		t.Errorf("decoded op = %+v, want setBalance %s -> %s", op, testSysOpAddr, want)
	}

	got, err := seq.Balance(testSysOpAddr, latest)
	if err != nil {
		t.Fatalf("Balance: %v", err)
	}
	if got.Cmp(want) != 0 {
		t.Errorf("balance = %s, want %s", got, want)
	}

	// A sysop block must move the state root — otherwise the mutation is not
	// actually captured by the block, which is the whole point of the design.
	parent, err := seq.HeaderByNumber(0)
	if err != nil {
		t.Fatalf("HeaderByNumber(0): %v", err)
	}
	if block.Root() == parent.Root {
		t.Error("sysop block reused the parent state root; the balance change was not committed into the block")
	}
}

// TestSetBalanceOverwritesRatherThanAdds pins the "set", not "add",
// semantics against a genesis-prefunded account, where an additive
// implementation would silently look like it worked.
func TestSetBalanceOverwritesRatherThanAdds(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	funded := crypto.PubkeyToAddress(key.PublicKey)

	before, err := seq.Balance(funded, latest)
	if err != nil {
		t.Fatalf("Balance: %v", err)
	}
	if before.Sign() == 0 {
		t.Fatal("precondition failed: account 0 should be prefunded at genesis")
	}

	want := big.NewInt(7)
	if _, err := seq.SetBalance(funded, want); err != nil {
		t.Fatalf("SetBalance: %v", err)
	}

	got, err := seq.Balance(funded, latest)
	if err != nil {
		t.Fatalf("Balance: %v", err)
	}
	if got.Cmp(want) != 0 {
		t.Errorf("balance = %s, want exactly %s (set, not add)", got, want)
	}
}

func TestSetBalanceRejectsNegative(t *testing.T) {
	seq, _ := newTestSequencer(t)

	if _, err := seq.SetBalance(testSysOpAddr, big.NewInt(-1)); !errors.Is(err, ErrMalformedSysOp) {
		t.Errorf("SetBalance(-1) error = %v, want ErrMalformedSysOp", err)
	}
	if _, err := seq.SetBalance(testSysOpAddr, nil); !errors.Is(err, ErrMalformedSysOp) {
		t.Errorf("SetBalance(nil) error = %v, want ErrMalformedSysOp", err)
	}

	height, err := seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}
	if height != 0 {
		t.Errorf("rejected SetBalance still moved the head to %d, want 0", height)
	}
}

// TestChainWithSysOpBlocksReplaysToIdenticalRoot is M07's determinism gate:
// it builds a chain mixing ordinary transaction blocks, empty blocks and
// system-op blocks, then rebuilds the entire state from genesis using
// nothing but the stored block list — no sequencer, no in-memory dev offset,
// no wall clock — and asserts the result matches.
//
// It carried its own replay loop through M07, as the prototype for M09's
// audit tool. That loop is now replay.go, so this test drives the real
// implementation: a second copy would only be able to drift away from the
// one that ships.
//
// If this test fails, replicas (M10) will reject the primary's blocks and
// the audit tool will report the chain as unverifiable, so it is worth far
// more than its size suggests.
func TestChainWithSysOpBlocksReplaysToIdenticalRoot(t *testing.T) {
	seq, db := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	from := crypto.PubkeyToAddress(key.PublicKey)
	chainID := big.NewInt(testChainID)

	// 1: contract creation.
	_, counter := deploy(t, seq, key, chainID, 0, counterRuntime())
	// 2: a storage-mutating call.
	if _, err := seq.SubmitTx(mustSignTx(t, key, chainID, 1, &counter, big.NewInt(0), 100_000, []byte{0x01})); err != nil {
		t.Fatalf("counter increment: %v", err)
	}
	// 3: a system-op block in the middle of the chain, targeting a fresh
	// account (creates it) …
	if _, err := seq.SetBalance(testSysOpAddr, big.NewInt(1_000_000_000_000_000_000)); err != nil {
		t.Fatalf("SetBalance(dead): %v", err)
	}
	// 4: … and one targeting the account that is also sending transactions,
	// so replay has to apply the ops in the right order relative to them.
	if _, err := seq.SetBalance(from, big.NewInt(500)); err != nil {
		t.Fatalf("SetBalance(from): %v", err)
	}
	// 5: an empty block (evm_mine) — no state change at all.
	if _, err := seq.MineEmptyBlock(); err != nil {
		t.Fatalf("MineEmptyBlock: %v", err)
	}
	// 6: another value-free call after the balance was overwritten, proving
	// replay carries the sysop's effect forward rather than recomputing from
	// genesis alloc.
	if _, err := seq.SubmitTx(mustSignTx(t, key, chainID, 2, &counter, big.NewInt(0), 100_000, []byte{0x01})); err != nil {
		t.Fatalf("second counter increment: %v", err)
	}

	head, err := seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}
	if head != 6 {
		t.Fatalf("built %d blocks, want 6 — the test's own setup drifted", head)
	}

	result, err := newTestReplayer(t, seq, db).Replay(1, head)
	if err != nil {
		t.Fatalf("replaying the chain: %v", err)
	}
	if result.Blocks != head {
		t.Errorf("replayed %d blocks, want %d", result.Blocks, head)
	}

	headHeader, err := seq.HeaderByNumber(head)
	if err != nil {
		t.Fatalf("HeaderByNumber(%d): %v", head, err)
	}
	if result.StateRoot != headHeader.Root {
		t.Errorf("replayed final state root = %s, sealed chain's head root = %s", result.StateRoot, headHeader.Root)
	}
}
