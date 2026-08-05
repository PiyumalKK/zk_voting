package chain

import (
	"crypto/ecdsa"
	"errors"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	gethrpc "github.com/ethereum/go-ethereum/rpc"
)

// ---------------------------------------------------------------------------
// Fixture

// unrelatedAddress is a well-formed address no fixture contract is ever
// deployed to — used for "this filter must match nothing" cases.
var unrelatedAddress = common.HexToAddress("0x00000000000000000000000000000000deadbeef")

// Topic bytes for the two emitters. Distinct per position so that a filter
// constraining position 1 cannot accidentally pass because it also matches
// position 0.
const (
	emitterXTopic0 byte = 0x11
	emitterXTopic1 byte = 0x21
	emitterXTopic2 byte = 0x31
	emitterXData   byte = 0xa1

	emitterYTopic0 byte = 0x12
	emitterYTopic1 byte = 0x22
	emitterYTopic2 byte = 0x32
	emitterYData   byte = 0xa2
)

// logFixture is the shared chain layout every filter test below reasons
// about:
//
//	block 0  genesis                (no logs)
//	block 1  deploy emitter X       (no logs — the init code emits nothing)
//	block 2  deploy emitter Y       (no logs)
//	block 3  call X                 -> 1 log
//	block 4  call Y                 -> 1 log
//	block 5  call X                 -> 1 log
//	block 6  call Y                 -> 1 log
//
// Four logs total, alternating emitters, so range subsets and address
// filters select genuinely different subsets rather than prefixes of one
// another.
type logFixture struct {
	seq *Sequencer
	x   common.Address
	y   common.Address
	// xBlocks/yBlocks are the block numbers in which each emitter logged.
	xBlocks []uint64
	yBlocks []uint64
}

func newLogFixture(t *testing.T) *logFixture {
	t.Helper()

	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)

	_, x := deploy(t, seq, key, chainID, 0, logThreeRuntime(emitterXTopic0, emitterXTopic1, emitterXTopic2, emitterXData))
	_, y := deploy(t, seq, key, chainID, 1, logThreeRuntime(emitterYTopic0, emitterYTopic1, emitterYTopic2, emitterYData))

	f := &logFixture{seq: seq, x: x, y: y}
	nonce := uint64(2)
	for _, target := range []struct {
		addr   common.Address
		blocks *[]uint64
	}{
		{x, &f.xBlocks}, {y, &f.yBlocks}, {x, &f.xBlocks}, {y, &f.yBlocks},
	} {
		receipt := mustCall(t, seq, key, chainID, nonce, target.addr)
		*target.blocks = append(*target.blocks, receipt.BlockNumber.Uint64())
		nonce++
	}
	return f
}

// mustCall sends an empty-calldata transaction to to, which makes the
// emitter contracts run their fallback path (they ignore calldata entirely)
// and log. Fails the test unless the call succeeds.
func mustCall(t *testing.T, seq *Sequencer, key *ecdsa.PrivateKey, chainID *big.Int, nonce uint64, to common.Address) *types.Receipt {
	t.Helper()
	tx := mustSignTx(t, key, chainID, nonce, &to, big.NewInt(0), 200_000, nil)
	receipt, err := seq.SubmitTx(tx)
	if err != nil {
		t.Fatalf("SubmitTx to %s (nonce %d): %v", to, nonce, err)
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		t.Fatalf("call to %s failed, status = %d", to, receipt.Status)
	}
	return receipt
}

// bnPtr wraps a concrete block number as the *gethrpc.BlockNumber
// LogFilter's bounds use.
func bnPtr(n int64) *gethrpc.BlockNumber {
	v := gethrpc.BlockNumber(n)
	return &v
}

func tagPtr(tag gethrpc.BlockNumber) *gethrpc.BlockNumber { return &tag }

// topicOf mirrors logThreeRuntime's encoding: a single PUSH1 byte becomes
// that byte right-aligned in an otherwise-zero 32-byte word.
func topicOf(b byte) common.Hash {
	var h common.Hash
	h[len(h)-1] = b
	return h
}

// blockNumbersOf reduces a log slice to the block numbers it spans, which
// is what most assertions below actually care about.
func blockNumbersOf(logs []*types.Log) []uint64 {
	out := make([]uint64, 0, len(logs))
	for _, l := range logs {
		out = append(out, l.BlockNumber)
	}
	return out
}

func equalUint64s(a, b []uint64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// mustFilter runs a filter with the range cap disabled and fails on error.
func mustFilter(t *testing.T, seq *Sequencer, f LogFilter) []*types.Log {
	t.Helper()
	logs, err := seq.FilterLogs(f, 0)
	if err != nil {
		t.Fatalf("FilterLogs(%+v): %v", f, err)
	}
	return logs
}

// wholeChain is the filter bound every test starts from: genesis to head.
func wholeChain() LogFilter {
	return LogFilter{
		FromBlock: tagPtr(gethrpc.EarliestBlockNumber),
		ToBlock:   tagPtr(gethrpc.LatestBlockNumber),
	}
}

// ---------------------------------------------------------------------------
// Tests

func TestFilterLogsUnfilteredReturnsEveryLogInBlockOrder(t *testing.T) {
	f := newLogFixture(t)

	logs := mustFilter(t, f.seq, wholeChain())

	want := []uint64{f.xBlocks[0], f.yBlocks[0], f.xBlocks[1], f.yBlocks[1]}
	if got := blockNumbersOf(logs); !equalUint64s(got, want) {
		t.Fatalf("block numbers = %v, want %v (ascending, one log per block)", got, want)
	}
}

func TestFilterLogsByAddress(t *testing.T) {
	f := newLogFixture(t)

	tests := []struct {
		name      string
		addresses []common.Address
		want      []uint64
	}{
		{"emitter X only", []common.Address{f.x}, f.xBlocks},
		{"emitter Y only", []common.Address{f.y}, f.yBlocks},
		{"both, OR-list", []common.Address{f.x, f.y}, []uint64{f.xBlocks[0], f.yBlocks[0], f.xBlocks[1], f.yBlocks[1]}},
		{"unrelated address", []common.Address{unrelatedAddress}, nil},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			filter := wholeChain()
			filter.Addresses = tc.addresses
			got := blockNumbersOf(mustFilter(t, f.seq, filter))
			if !equalUint64s(got, tc.want) {
				t.Fatalf("block numbers = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestFilterLogsByTopics(t *testing.T) {
	f := newLogFixture(t)
	all := []uint64{f.xBlocks[0], f.yBlocks[0], f.xBlocks[1], f.yBlocks[1]}

	tests := []struct {
		name   string
		topics [][]common.Hash
		want   []uint64
	}{
		{
			name:   "topic0 selects one emitter",
			topics: [][]common.Hash{{topicOf(emitterXTopic0)}},
			want:   f.xBlocks,
		},
		{
			name:   "topic0 OR-list selects both",
			topics: [][]common.Hash{{topicOf(emitterXTopic0), topicOf(emitterYTopic0)}},
			want:   all,
		},
		{
			name:   "topic0 wildcard, topic1 constrained",
			topics: [][]common.Hash{nil, {topicOf(emitterYTopic1)}},
			want:   f.yBlocks,
		},
		{
			name:   "empty inner slice is a wildcard, same as nil",
			topics: [][]common.Hash{{}, {topicOf(emitterXTopic1)}},
			want:   f.xBlocks,
		},
		{
			name:   "all three positions constrained",
			topics: [][]common.Hash{{topicOf(emitterXTopic0)}, {topicOf(emitterXTopic1)}, {topicOf(emitterXTopic2)}},
			want:   f.xBlocks,
		},
		{
			name:   "mismatched topic1 excludes an otherwise-matching topic0",
			topics: [][]common.Hash{{topicOf(emitterXTopic0)}, {topicOf(emitterYTopic1)}},
			want:   nil,
		},
		{
			// The shape /api/verify-vote actually sends: viem pads the topics
			// array out to the event's full indexed-argument count with
			// trailing nulls. Padding to exactly the log's topic count must
			// still match — the length check is `>`, not `>=`.
			name:   "trailing null positions padding to the log's exact topic count",
			topics: [][]common.Hash{{topicOf(emitterXTopic0)}, nil, nil},
			want:   f.xBlocks,
		},
		{
			name:   "constraining a fourth position never matches a three-topic log",
			topics: [][]common.Hash{nil, nil, nil, {topicOf(emitterXTopic0)}},
			want:   nil,
		},
		{
			// *** The one genuinely ambiguous case in the whole filter spec.
			// A filter with MORE positions than the log has topics, where the
			// surplus positions are all wildcards. Two defensible readings:
			//
			//   A) reject on length alone — go-ethereum's eth/filters checks
			//      `len(topics) > len(log.Topics)` before looking at any rule,
			//      so a wildcard past the end still rejects;
			//   B) skip wildcards first, and only reject when a *real*
			//      constraint sits beyond the log's topics.
			//
			// This chain implements (A), because Hardhat-identical behavior is
			// this project's whole point and Hardhat follows go-ethereum here.
			// That is an empirical claim, so it is not left to this comment:
			// e2e/diff/logs.mjs's check (n) puts exactly this filter to a live
			// hardhat node and fails the gate if the two disagree. If it ever
			// does, change matchLog to (B) and invert this case — do not
			// "fix" one without the other.
			//
			// Nothing in the app produces this shape today (viem pads a topics
			// array to exactly the event's indexed-argument count, never past
			// it — verified by capturing viem's real wire output), so this is
			// a correctness-of-record case, not a load-bearing one.
			name:   "over-padding past the log's topic count rejects, even when the surplus is wildcards",
			topics: [][]common.Hash{{topicOf(emitterXTopic0)}, nil, nil, nil},
			want:   nil,
		},
		{
			name:   "empty topics list constrains nothing",
			topics: [][]common.Hash{},
			want:   all,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			filter := wholeChain()
			filter.Topics = tc.topics
			got := blockNumbersOf(mustFilter(t, f.seq, filter))
			if !equalUint64s(got, tc.want) {
				t.Fatalf("block numbers = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestFilterLogsAddressAndTopicsCombine(t *testing.T) {
	f := newLogFixture(t)

	filter := wholeChain()
	filter.Addresses = []common.Address{f.x, f.y}
	filter.Topics = [][]common.Hash{{topicOf(emitterYTopic0)}}

	// The address list admits both emitters; the topic narrows it to Y —
	// the two constraints must AND together, not OR.
	if got := blockNumbersOf(mustFilter(t, f.seq, filter)); !equalUint64s(got, f.yBlocks) {
		t.Fatalf("block numbers = %v, want %v", got, f.yBlocks)
	}
}

func TestFilterLogsBlockRangeSubsets(t *testing.T) {
	f := newLogFixture(t)
	head, err := f.seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}

	tests := []struct {
		name     string
		from, to *gethrpc.BlockNumber
		want     []uint64
	}{
		{"exactly the first logging block", bnPtr(int64(f.xBlocks[0])), bnPtr(int64(f.xBlocks[0])), []uint64{f.xBlocks[0]}},
		{"first two logging blocks", bnPtr(int64(f.xBlocks[0])), bnPtr(int64(f.yBlocks[0])), []uint64{f.xBlocks[0], f.yBlocks[0]}},
		{"from the second half", bnPtr(int64(f.xBlocks[1])), tagPtr(gethrpc.LatestBlockNumber), []uint64{f.xBlocks[1], f.yBlocks[1]}},
		{"deployment blocks only, no logs there", bnPtr(1), bnPtr(2), nil},
		{"toBlock beyond head is clamped", bnPtr(0), bnPtr(int64(head) + 1000), []uint64{f.xBlocks[0], f.yBlocks[0], f.xBlocks[1], f.yBlocks[1]}},
		{"fromBlock past the head is an empty range, not an error", bnPtr(int64(head) + 1), tagPtr(gethrpc.LatestBlockNumber), nil},
		{"from > to is an empty range, not an error", bnPtr(int64(head)), bnPtr(1), nil},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			filter := LogFilter{FromBlock: tc.from, ToBlock: tc.to}
			got := blockNumbersOf(mustFilter(t, f.seq, filter))
			if !equalUint64s(got, tc.want) {
				t.Fatalf("block numbers = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestFilterLogsDefaultBoundsAreLatestOnly(t *testing.T) {
	f := newLogFixture(t)

	// Both bounds omitted default to latest, so an unfiltered query returns
	// only the head block's logs — the last emitter's single log — not the
	// whole chain. This is the JSON-RPC spec's default and go-ethereum's;
	// getting it wrong would silently make every unbounded query a full scan.
	logs := mustFilter(t, f.seq, LogFilter{})
	want := []uint64{f.yBlocks[len(f.yBlocks)-1]}
	if got := blockNumbersOf(logs); !equalUint64s(got, want) {
		t.Fatalf("block numbers = %v, want %v", got, want)
	}
}

func TestFilterLogsByBlockHash(t *testing.T) {
	f := newLogFixture(t)

	header, err := f.seq.HeaderByNumber(f.xBlocks[0])
	if err != nil {
		t.Fatalf("HeaderByNumber: %v", err)
	}
	hash := header.Hash()

	logs := mustFilter(t, f.seq, LogFilter{BlockHash: &hash})
	if got := blockNumbersOf(logs); !equalUint64s(got, []uint64{f.xBlocks[0]}) {
		t.Fatalf("block numbers = %v, want [%d]", got, f.xBlocks[0])
	}
	if logs[0].Address != f.x {
		t.Errorf("address = %s, want %s", logs[0].Address, f.x)
	}
}

func TestFilterLogsByBlockHashAppliesTopicFilterToo(t *testing.T) {
	f := newLogFixture(t)

	header, err := f.seq.HeaderByNumber(f.xBlocks[0])
	if err != nil {
		t.Fatalf("HeaderByNumber: %v", err)
	}
	hash := header.Hash()

	// blockHash pins *which* block is scanned; it must not disable the
	// address/topic matching within it.
	logs := mustFilter(t, f.seq, LogFilter{
		BlockHash: &hash,
		Topics:    [][]common.Hash{{topicOf(emitterYTopic0)}},
	})
	if len(logs) != 0 {
		t.Fatalf("got %d logs, want 0 (topic belongs to the other emitter)", len(logs))
	}
}

func TestFilterLogsBlockHashWithRangeIsConflict(t *testing.T) {
	f := newLogFixture(t)
	hash := common.HexToHash("0xabc")

	for _, tc := range []struct {
		name   string
		filter LogFilter
	}{
		{"with fromBlock", LogFilter{BlockHash: &hash, FromBlock: bnPtr(0)}},
		{"with toBlock", LogFilter{BlockHash: &hash, ToBlock: bnPtr(1)}},
		{"with both", LogFilter{BlockHash: &hash, FromBlock: bnPtr(0), ToBlock: bnPtr(1)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := f.seq.FilterLogs(tc.filter, 0); !errors.Is(err, ErrFilterConflict) {
				t.Fatalf("err = %v, want ErrFilterConflict", err)
			}
		})
	}
}

func TestFilterLogsUnknownBlockHashIsBlockNotFound(t *testing.T) {
	f := newLogFixture(t)
	hash := common.HexToHash("0xdeadbeef")

	if _, err := f.seq.FilterLogs(LogFilter{BlockHash: &hash}, 0); !errors.Is(err, ErrBlockNotFound) {
		t.Fatalf("err = %v, want ErrBlockNotFound", err)
	}
}

func TestFilterLogsEmptyResultIsNonNilSlice(t *testing.T) {
	f := newLogFixture(t)

	filter := wholeChain()
	filter.Addresses = []common.Address{unrelatedAddress}

	logs, err := f.seq.FilterLogs(filter, 0)
	if err != nil {
		t.Fatalf("FilterLogs: %v", err)
	}
	if logs == nil {
		t.Fatal("FilterLogs returned a nil slice; internal/rpc would marshal it as JSON null instead of []")
	}
	if len(logs) != 0 {
		t.Fatalf("got %d logs, want 0", len(logs))
	}
}

func TestFilterLogsRangeCap(t *testing.T) {
	f := newLogFixture(t)
	head, err := f.seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}
	span := head + 1 // genesis..head inclusive

	t.Run("exactly at the limit is allowed", func(t *testing.T) {
		if _, err := f.seq.FilterLogs(wholeChain(), span); err != nil {
			t.Fatalf("FilterLogs with limit == span: %v", err)
		}
	})

	t.Run("one block over the limit is rejected", func(t *testing.T) {
		_, err := f.seq.FilterLogs(wholeChain(), span-1)
		var rangeErr *LogRangeError
		if !errors.As(err, &rangeErr) {
			t.Fatalf("err = %v, want *LogRangeError", err)
		}
		if rangeErr.From != 0 || rangeErr.To != head || rangeErr.Limit != span-1 {
			t.Errorf("LogRangeError = %+v, want From=0 To=%d Limit=%d", rangeErr, head, span-1)
		}
	})

	t.Run("zero disables the cap", func(t *testing.T) {
		if _, err := f.seq.FilterLogs(wholeChain(), 0); err != nil {
			t.Fatalf("FilterLogs with limit 0: %v", err)
		}
	})

	t.Run("cap is measured after clamping toBlock to the head", func(t *testing.T) {
		// A deliberately enormous toBlock is the common "give me everything"
		// client idiom. It must not trip the cap, because the range it
		// really covers is bounded by the chain's own height.
		filter := LogFilter{FromBlock: bnPtr(0), ToBlock: bnPtr(1_000_000_000)}
		if _, err := f.seq.FilterLogs(filter, span); err != nil {
			t.Fatalf("FilterLogs with huge toBlock and limit == chain height: %v", err)
		}
	})
}

func TestFilterLogsDerivedFieldsArePopulated(t *testing.T) {
	f := newLogFixture(t)

	logs := mustFilter(t, f.seq, wholeChain())
	if len(logs) == 0 {
		t.Fatal("fixture produced no logs")
	}

	for i, l := range logs {
		header, err := f.seq.HeaderByNumber(l.BlockNumber)
		if err != nil {
			t.Fatalf("log %d: HeaderByNumber(%d): %v", i, l.BlockNumber, err)
		}
		if l.BlockHash != header.Hash() {
			t.Errorf("log %d: BlockHash = %s, want %s", i, l.BlockHash, header.Hash())
		}
		if l.BlockHash == (common.Hash{}) {
			t.Errorf("log %d: BlockHash is zero", i)
		}
		if l.TxHash == (common.Hash{}) {
			t.Errorf("log %d: TxHash is zero", i)
		}
		if l.TxIndex != 0 {
			t.Errorf("log %d: TxIndex = %d, want 0 (one tx per block)", i, l.TxIndex)
		}
		if l.Index != 0 {
			t.Errorf("log %d: Index = %d, want 0 (one log per block in this fixture)", i, l.Index)
		}
		if l.Removed {
			t.Errorf("log %d: Removed = true; this chain never reorgs", i)
		}
		if len(l.Topics) != 3 {
			t.Errorf("log %d: %d topics, want 3", i, len(l.Topics))
		}
		if len(l.Data) != 32 {
			t.Errorf("log %d: %d data bytes, want 32", i, len(l.Data))
		}
	}
}

func TestFilterLogsIndexIsBlockScopedAcrossMultipleLogs(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	chainID := big.NewInt(testChainID)

	// logRuntime emits three LOG1s in one transaction, so this exercises the
	// per-block (not per-transaction, not per-query) logIndex counter that
	// deriveReceiptFields maintains.
	_, addr := deploy(t, seq, key, chainID, 0, logRuntime())
	tx := mustSignTx(t, key, chainID, 1, &addr, big.NewInt(0), 200_000, nil)
	if _, err := seq.SubmitTx(tx); err != nil {
		t.Fatalf("SubmitTx: %v", err)
	}

	logs := mustFilter(t, seq, wholeChain())
	if len(logs) != 3 {
		t.Fatalf("got %d logs, want 3", len(logs))
	}
	for i, l := range logs {
		if l.Index != uint(i) {
			t.Errorf("logs[%d].Index = %d, want %d", i, l.Index, i)
		}
		if l.TxIndex != 0 {
			t.Errorf("logs[%d].TxIndex = %d, want 0", i, l.TxIndex)
		}
	}
}

// TestFilterLogsBloomSkipIsOnlyAnOptimisation is the safety net for the
// header-bloom fast path: a bloom match is probabilistic (false positives
// are possible, false negatives are not), so skipping a block on a bloom
// miss is only correct if the result is identical to a brute-force scan
// that never consults the bloom at all. This test asserts exactly that
// equivalence over every filter shape the suite uses, so a future change to
// bloomMatches that is too aggressive fails here rather than by silently
// dropping events from the audit page.
func TestFilterLogsBloomSkipIsOnlyAnOptimisation(t *testing.T) {
	f := newLogFixture(t)
	head, err := f.seq.BlockNumber()
	if err != nil {
		t.Fatalf("BlockNumber: %v", err)
	}

	filters := []LogFilter{
		wholeChain(),
		{FromBlock: bnPtr(0), ToBlock: tagPtr(gethrpc.LatestBlockNumber), Addresses: []common.Address{f.x}},
		{FromBlock: bnPtr(0), ToBlock: tagPtr(gethrpc.LatestBlockNumber), Addresses: []common.Address{f.x, f.y}},
		{FromBlock: bnPtr(0), ToBlock: tagPtr(gethrpc.LatestBlockNumber), Topics: [][]common.Hash{{topicOf(emitterXTopic0)}}},
		{FromBlock: bnPtr(0), ToBlock: tagPtr(gethrpc.LatestBlockNumber), Topics: [][]common.Hash{nil, {topicOf(emitterYTopic1)}}},
		{FromBlock: bnPtr(0), ToBlock: tagPtr(gethrpc.LatestBlockNumber), Addresses: []common.Address{f.y}, Topics: [][]common.Hash{{topicOf(emitterYTopic0)}}},
		{FromBlock: bnPtr(0), ToBlock: tagPtr(gethrpc.LatestBlockNumber), Addresses: []common.Address{unrelatedAddress}},
	}

	for i, filter := range filters {
		fast := mustFilter(t, f.seq, filter)
		slow := bruteForceLogs(t, f.seq, head, filter)

		if len(fast) != len(slow) {
			t.Fatalf("filter %d: bloom path returned %d logs, brute force %d", i, len(fast), len(slow))
		}
		for j := range fast {
			if fast[j].BlockHash != slow[j].BlockHash || fast[j].Index != slow[j].Index {
				t.Errorf("filter %d, log %d: bloom path %s#%d != brute force %s#%d",
					i, j, fast[j].BlockHash, fast[j].Index, slow[j].BlockHash, slow[j].Index)
			}
		}
	}
}

// bruteForceLogs scans every block from 0 to head, ignoring the header
// bloom entirely, and applies only the exact matcher.
func bruteForceLogs(t *testing.T, seq *Sequencer, head uint64, filter LogFilter) []*types.Log {
	t.Helper()
	out := make([]*types.Log, 0)
	for n := uint64(0); n <= head; n++ {
		header, err := seq.HeaderByNumber(n)
		if err != nil {
			t.Fatalf("HeaderByNumber(%d): %v", n, err)
		}
		block, err := seq.blockByHeader(header)
		if err != nil {
			t.Fatalf("blockByHeader(%d): %v", n, err)
		}
		// Reuse the production per-block collector, which does not consult
		// the bloom — the bloom check lives in FilterLogs' loop.
		out, err = seq.appendBlockLogs(out, block, filter)
		if err != nil {
			t.Fatalf("appendBlockLogs(%d): %v", n, err)
		}
	}
	return out
}

func TestBloomMatchesRejectsOnlyImpossibleBlocks(t *testing.T) {
	f := newLogFixture(t)

	header, err := f.seq.HeaderByNumber(f.xBlocks[0])
	if err != nil {
		t.Fatalf("HeaderByNumber: %v", err)
	}

	tests := []struct {
		name      string
		addresses []common.Address
		topics    [][]common.Hash
		want      bool
	}{
		{"no constraints", nil, nil, true},
		{"emitting address", []common.Address{f.x}, nil, true},
		{"other emitter's address", []common.Address{f.y}, nil, false},
		{"address OR-list containing the emitter", []common.Address{f.y, f.x}, nil, true},
		{"emitted topic0", nil, [][]common.Hash{{topicOf(emitterXTopic0)}}, true},
		{"absent topic0", nil, [][]common.Hash{{topicOf(emitterYTopic0)}}, false},
		{"wildcard position is ignored", nil, [][]common.Hash{nil, {topicOf(emitterXTopic1)}}, true},
		{"address matches but topic doesn't", []common.Address{f.x}, [][]common.Hash{{topicOf(emitterYTopic0)}}, false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := bloomMatches(header.Bloom, tc.addresses, tc.topics); got != tc.want {
				t.Fatalf("bloomMatches = %v, want %v", got, tc.want)
			}
		})
	}
}
