package chain

import (
	"errors"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core"
	"github.com/ethereum/go-ethereum/core/rawdb"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/core/vm"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethdb"
	"github.com/ethereum/go-ethereum/params"
	gethrpc "github.com/ethereum/go-ethereum/rpc"

	"zk-blockchain/internal/state"
	"zk-blockchain/internal/storage"
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

// TestChainWithSysOpBlocksReplaysToIdenticalRoot is M07's determinism gate
// and the precursor to M09's `cmd/audit`: it builds a chain mixing ordinary
// transaction blocks, empty blocks and system-op blocks, then rebuilds the
// entire state from genesis using nothing but the stored block list — no
// sequencer, no in-memory dev offset, no wall clock — and asserts every
// intermediate state root matches.
//
// If this test fails, replicas (M10) will reject the primary's blocks and
// the audit tool (M09) will report the chain as unverifiable, so it is worth
// far more than its size suggests.
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

	replayFinalRoot := replayChain(t, db, seq.chainCfg, head)

	headHeader, err := seq.HeaderByNumber(head)
	if err != nil {
		t.Fatalf("HeaderByNumber(%d): %v", head, err)
	}
	if replayFinalRoot != headHeader.Root {
		t.Errorf("replayed final state root = %s, sealed chain's head root = %s", replayFinalRoot, headHeader.Root)
	}
}

// replayChain rebuilds state from genesis over a *fresh* database by
// re-executing every block 1..head from src, and fails the test at the first
// block whose recomputed root differs from the one stored in its header. It
// returns the final root.
//
// This is deliberately written the way M09's audit tool will have to be
// written — driven only by what is durably stored in the block (its
// transactions, its ExtraData, its header timestamp/gas limit) — so that if
// anything in the sealing path ever starts depending on sequencer-local
// state that isn't in the header, this test is what catches it.
func replayChain(t *testing.T, src ethdb.Database, chainCfg *params.ChainConfig, head uint64) common.Hash {
	t.Helper()

	dst, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatalf("storage.Open(replay): %v", err)
	}
	t.Cleanup(func() { _ = dst.Close() })

	genesis, err := state.EnsureGenesis(dst, testConfig(testChainID, 60_000_000))
	if err != nil {
		t.Fatalf("EnsureGenesis(replay): %v", err)
	}
	parentRoot := genesis.Root()

	for n := uint64(1); n <= head; n++ {
		hash := rawdb.ReadCanonicalHash(src, n)
		if hash == (common.Hash{}) {
			t.Fatalf("block %d has no canonical hash in the source chain", n)
		}
		block := rawdb.ReadBlock(src, hash, n)
		if block == nil {
			t.Fatalf("block %d (%s) could not be read back", n, hash)
		}
		header := block.Header()

		ws, err := state.Writable(dst, parentRoot)
		if err != nil {
			t.Fatalf("block %d: state.Writable at %s: %v", n, parentRoot, err)
		}

		// The sysop-or-transactions fork is the entire replay rule. Note the
		// deliberate use of src for the applyMessage db argument: it is only
		// consulted for the BLOCKHASH opcode's canonical-hash lookups, and
		// the replay database has no blocks written into it. A real M09
		// audit tool, which walks its own copy of the chain, would pass its
		// own handle here.
		op, parseErr := ParseSysOp(header.Extra)
		switch {
		case parseErr == nil:
			if err := ApplySysOp(ws.StateDB, op); err != nil {
				_ = ws.TrieDB.Close()
				t.Fatalf("block %d: ApplySysOp: %v", n, err)
			}
		case errors.Is(parseErr, ErrNotSysOp):
			for i, tx := range block.Transactions() {
				msg, err := core.TransactionToMessage(tx, types.LatestSignerForChainID(chainCfg.ChainID), header.BaseFee)
				if err != nil {
					_ = ws.TrieDB.Close()
					t.Fatalf("block %d tx %d: TransactionToMessage: %v", n, i, err)
				}
				ws.StateDB.SetTxContext(tx.Hash(), i)
				if _, err := applyMessage(vm.Config{}, src, chainCfg, ws.StateDB, header, msg); err != nil {
					_ = ws.TrieDB.Close()
					t.Fatalf("block %d tx %d: applyMessage: %v", n, i, err)
				}
			}
		default:
			_ = ws.TrieDB.Close()
			t.Fatalf("block %d: undecodable extra data %q: %v", n, header.Extra, parseErr)
		}

		root, err := ws.Commit(n, true, false)
		if err != nil {
			_ = ws.TrieDB.Close()
			t.Fatalf("block %d: commit state: %v", n, err)
		}
		if err := ws.TrieDB.Commit(root, false); err != nil {
			_ = ws.TrieDB.Close()
			t.Fatalf("block %d: commit trie: %v", n, err)
		}
		if err := ws.TrieDB.Close(); err != nil {
			t.Fatalf("block %d: close trie db: %v", n, err)
		}

		if root != header.Root {
			t.Fatalf("block %d: replayed state root %s != stored root %s", n, root, header.Root)
		}
		parentRoot = root
	}

	return parentRoot
}
