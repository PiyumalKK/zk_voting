// Command audit re-derives a chain's entire state from its stored block
// list and verifies every block against its own header (M09).
//
// It is deliberately a separate binary from the node, sharing only the
// execution primitives in internal/chain. The node is the party whose
// honesty is in question; an auditor that ran inside it, or that could write
// to the data directory it is checking, would prove nothing. This one opens
// DATA_DIR read-only, keeps every trie node it computes in memory, and exits
// non-zero at the first block that does not verify.
//
// Usage:
//
//	audit                      # verify the whole chain in $DATA_DIR
//	audit -data-dir ./data     # or an explicit directory
//	audit -from 1200           # incremental: verify from block 1200 up
//	audit -json                # machine-readable summary on stdout
//
// The node must not be running against the same directory — Pebble holds an
// exclusive lock. Stop it, or audit a copy.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/joho/godotenv"

	"zk-blockchain/internal/chain"
	"zk-blockchain/internal/config"
	"zk-blockchain/internal/state"
	"zk-blockchain/internal/storage"
)

func main() {
	if err := run(); err != nil {
		os.Exit(1)
	}
}

// summary is the --json payload. Field names are lowerCamelCase to match the
// JSON-RPC shapes the rest of this project emits.
type summary struct {
	OK      bool   `json:"ok"`
	DataDir string `json:"dataDir"`
	ChainID uint64 `json:"chainId"`

	GenesisHash string `json:"genesisHash,omitempty"`
	Head        uint64 `json:"head"`
	From        uint64 `json:"from"`
	To          uint64 `json:"to"`

	Blocks       uint64 `json:"blocks"`
	Transactions uint64 `json:"transactions"`
	GasUsed      uint64 `json:"gasUsed"`
	StateRoot    string `json:"stateRoot,omitempty"`

	ElapsedSeconds  float64 `json:"elapsedSeconds"`
	BlocksPerSecond float64 `json:"blocksPerSecond"`

	Error    string    `json:"error,omitempty"`
	Mismatch *mismatch `json:"mismatch,omitempty"`
}

// mismatch is the structured form of chain.ReplayMismatch — the one output
// that matters when an audit fails, so it is reported as data rather than
// only as prose.
type mismatch struct {
	Block uint64 `json:"block"`
	Field string `json:"field"`
	Got   string `json:"got"`
	Want  string `json:"want"`
}

// run performs the audit and reports it. It returns a non-nil error when the
// chain did not verify (or could not be read), which main turns into exit
// code 1; the human- or machine-readable report is written here, so main
// stays a single decision.
func run() error {
	var (
		dataDirFlag = flag.String("data-dir", "", "chain data directory to audit (default: $DATA_DIR, else ./data)")
		fromFlag    = flag.Uint64("from", 0, "first block to re-execute; 0 or 1 means a full audit from genesis")
		toFlag      = flag.Uint64("to", 0, "last block to re-execute; 0 means the chain head")
		jsonFlag    = flag.Bool("json", false, "emit a machine-readable JSON summary on stdout instead of prose")
	)
	flag.Parse()

	// Same .env convenience the node has, so an audit reads the same
	// CHAIN_ID and BLOCK_GAS_LIMIT the node was configured with — both feed
	// genesis construction, and auditing against the wrong genesis would
	// verify the wrong chain.
	_ = godotenv.Load()

	started := time.Now()
	report := &summary{}

	cfg, err := config.Load()
	if err != nil {
		return fail(report, *jsonFlag, started, fmt.Errorf("invalid configuration: %w", err))
	}
	if *dataDirFlag != "" {
		cfg.DataDir = *dataDirFlag
	}
	report.DataDir = cfg.DataDir
	report.ChainID = cfg.ChainID

	db, err := storage.OpenReadOnly(cfg.DataDir)
	if err != nil {
		return fail(report, *jsonFlag, started, err)
	}
	defer db.Close()

	// Block 0 has nothing to execute, so it is verified by reconstruction
	// instead: rebuild the genesis this config produces and compare. Without
	// this an audit would happily verify a chain built from a different
	// prefund set or chain id, since every later block only has to be
	// consistent with the block before it.
	genesis, err := state.VerifyGenesis(db, cfg)
	if err != nil {
		return fail(report, *jsonFlag, started, err)
	}
	report.GenesisHash = genesis.Hash().Hex()

	head, err := state.HeadHeader(db)
	if err != nil {
		return fail(report, *jsonFlag, started, err)
	}
	report.Head = head.Number.Uint64()

	to := *toFlag
	if to == 0 || to > report.Head {
		to = report.Head
	}
	from := *fromFlag
	if from == 0 {
		from = 1
	}
	if from > report.Head+1 {
		return fail(report, *jsonFlag, started,
			fmt.Errorf("-from %d is past the chain head (%d)", from, report.Head))
	}
	// from == to+1 is the one legitimate empty range: `-from N` on a chain
	// whose head is N-1, which an incremental audit in a cron job hits every
	// time nothing new was sealed. Anything wider is an inverted range the
	// caller did not mean, and reporting AUDIT OK for it would be a false
	// clean bill of health.
	if from > to+1 {
		return fail(report, *jsonFlag, started,
			fmt.Errorf("-from %d is above -to %d; nothing would be verified", from, to))
	}
	report.From, report.To = from, to

	// The overlay is what makes "read-only" true in practice: replay's trie
	// nodes go to memory, while reads still reach the historical state only
	// the audited database holds (internal/storage/overlay.go).
	work := storage.NewReplayOverlay(db)
	defer work.Close()

	replayer := chain.NewReplayer(db, work, state.ChainConfig(cfg.ChainID))
	if !*jsonFlag {
		// Progress goes to stderr so `audit > report.txt` captures the
		// verdict alone.
		replayer.OnProgress(func(block, target uint64) {
			fmt.Fprintf(os.Stderr, "audit: verified block %d/%d (%.1f%%, %.1f blocks/s)\n",
				block, target, percent(block-from+1, target-from+1), rate(block-from+1, time.Since(started)))
		})
	}

	result, err := replayer.Replay(from, to)
	if err != nil {
		return fail(report, *jsonFlag, started, err)
	}

	report.OK = true
	// Taken from the result rather than from the flags: an empty range
	// (`-from N` on a chain whose head is N-1) verifies nothing, and the
	// report should say so rather than claim the requested range.
	report.From, report.To = result.From, result.To
	report.Blocks = result.Blocks
	report.Transactions = result.Transactions
	report.GasUsed = result.GasUsed
	report.StateRoot = result.StateRoot.Hex()
	finish(report, started)

	if *jsonFlag {
		return emitJSON(report)
	}
	fmt.Printf("AUDIT OK height=%d stateRoot=%s blocks=%d txs=%d gas=%d elapsed=%s (%.1f blocks/s)\n",
		report.To, report.StateRoot, report.Blocks, report.Transactions, report.GasUsed,
		time.Since(started).Round(time.Millisecond), report.BlocksPerSecond)
	return nil
}

// fail reports a failed audit in whichever format was requested and returns
// the error so main can exit non-zero.
func fail(report *summary, asJSON bool, started time.Time, err error) error {
	report.OK = false
	report.Error = err.Error()

	var mm *chain.ReplayMismatch
	if errors.As(err, &mm) {
		report.Mismatch = &mismatch{Block: mm.Block, Field: mm.Field, Got: mm.Got, Want: mm.Want}
	}
	finish(report, started)

	if asJSON {
		// A JSON emit failure would otherwise mask the audit failure being
		// reported, so it is printed and discarded — the returned error is
		// always the audit's.
		if emitErr := emitJSON(report); emitErr != nil {
			fmt.Fprintf(os.Stderr, "audit: could not write JSON summary: %v\n", emitErr)
		}
		return err
	}

	if report.Mismatch != nil {
		fmt.Printf("AUDIT FAILED block=%d field=%s got=%s want=%s\n",
			report.Mismatch.Block, report.Mismatch.Field, report.Mismatch.Got, report.Mismatch.Want)
	} else {
		fmt.Printf("AUDIT FAILED: %v\n", err)
	}
	return err
}

func finish(report *summary, started time.Time) {
	elapsed := time.Since(started)
	report.ElapsedSeconds = elapsed.Seconds()
	report.BlocksPerSecond = rate(report.Blocks, elapsed)
}

func emitJSON(report *summary) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(report)
}

// rate reports blocks per second, guarding the zero-duration case a very
// short audit on a coarse clock can produce.
func rate(blocks uint64, elapsed time.Duration) float64 {
	if elapsed <= 0 {
		return 0
	}
	return float64(blocks) / elapsed.Seconds()
}

func percent(done, total uint64) float64 {
	if total == 0 {
		return 100
	}
	return float64(done) / float64(total) * 100
}
