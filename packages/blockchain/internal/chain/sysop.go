package chain

import (
	"errors"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	gethstate "github.com/ethereum/go-ethereum/core/state"
	"github.com/holiman/uint256"
)

// System operations (M07) exist to satisfy MASTER §10 pitfall 10: *state
// must only ever mutate inside blocks*. `hardhat_setBalance` is the only
// method in this codebase that changes account state without a transaction,
// and letting it write straight to the trie would break two later
// milestones at once — M09's audit tool replays the block list and verifies
// every state root, and M10's replicas re-execute each pushed block and
// refuse any whose root doesn't match. Neither can see a mutation that
// isn't in a block.
//
// So a `setBalance` is sealed as a *system-op block*: a block with zero
// transactions whose header `extraData` carries a self-describing,
// deterministic encoding of the operation, and whose state root already
// reflects it. Replay is then uniform — for each block, apply its
// transactions *or* its system op, commit, compare roots — which is exactly
// what TestChainWithSysOpBlocksReplaysToIdenticalRoot does today and what
// M09/M10 will do for real.
//
// The encoding is a human-readable ASCII string rather than RLP or JSON on
// purpose: `extraData` is surfaced verbatim by eth_getBlockByNumber and the
// block explorer, so an operator (or an examiner reading the FYP report)
// can see what a stateful non-transaction block did just by looking at it.

// sysOpPrefix marks a header's extraData as a system operation. Genesis
// uses "zkchain-genesis" (internal/state/genesis.go) and every ordinary
// sealed block leaves extraData empty, so no non-sysop block can collide
// with this prefix.
const sysOpPrefix = "sysop:"

// SysOpSetBalance is the only system operation kind this chain defines
// (M07). New kinds must keep the same "sysop:<kind>:<args…>" shape so
// ParseSysOp stays backward compatible with blocks already on disk.
const SysOpSetBalance = "setBalance"

// sysOpFieldCount is how many colon-separated fields a setBalance sysop
// encodes: "sysop", "setBalance", "<address>", "<hex balance>".
const sysOpFieldCount = 4

var (
	// ErrNotSysOp means the header's extraData is not a system operation at
	// all (an ordinary block, or genesis). Callers that iterate over every
	// block — replay, replicas — errors.Is against this to skip rather than
	// fail.
	ErrNotSysOp = errors.New("extra data is not a system operation")
	// ErrMalformedSysOp means extraData *does* carry the sysop prefix but
	// could not be decoded. Unlike ErrNotSysOp this is always fatal for a
	// replayer: the block claims a state mutation that cannot be reproduced,
	// so its state root is unverifiable.
	ErrMalformedSysOp = errors.New("malformed system operation")
	// ErrUnknownSysOp means the operation decoded cleanly but names a kind
	// this build does not implement — an older binary reading a chain
	// written by a newer one. Fatal for the same reason.
	ErrUnknownSysOp = errors.New("unknown system operation")
)

// SysOp is a state mutation carried by a block's header rather than by a
// transaction. Exported because M09's audit tool and M10's replica verifier
// both need to decode and re-apply one.
type SysOp struct {
	// Kind is one of the SysOp* constants above.
	Kind string
	// Address is the account the operation targets.
	Address common.Address
	// Value is the new balance in wei, for SysOpSetBalance. Never nil in a
	// SysOp returned by ParseSysOp.
	Value *big.Int
}

// Encode renders op as header extraData bytes. It is a pure function of
// op's fields — no wall clock, no map iteration — so the same operation
// always produces byte-identical extraData and therefore the same block
// hash on the primary and on every replica.
//
// The address is EIP-55 checksummed (common.Address.Hex) and the value is a
// canonical minimal-width lowercase hex quantity (hexutil.EncodeBig, "0x0"
// for zero), so encode(decode(x)) == x for anything this function produced.
func (op *SysOp) Encode() []byte {
	return []byte(sysOpPrefix + op.Kind + ":" + op.Address.Hex() + ":" + hexutil.EncodeBig(op.Value))
}

// ParseSysOp decodes a header's extraData. It returns ErrNotSysOp for
// extraData that isn't a system operation at all (every ordinary block, plus
// genesis), which callers are expected to treat as "nothing to do" rather
// than as a failure; ErrMalformedSysOp / ErrUnknownSysOp are genuine
// corruption or version-skew and must not be ignored.
func ParseSysOp(extra []byte) (*SysOp, error) {
	s := string(extra)
	if !strings.HasPrefix(s, sysOpPrefix) {
		return nil, ErrNotSysOp
	}

	fields := strings.Split(s, ":")
	if len(fields) != sysOpFieldCount {
		return nil, fmt.Errorf("%w: expected %d colon-separated fields, got %d in %q",
			ErrMalformedSysOp, sysOpFieldCount, len(fields), s)
	}

	kind := fields[1]
	if kind != SysOpSetBalance {
		return nil, fmt.Errorf("%w: %q", ErrUnknownSysOp, kind)
	}

	// common.HexToAddress is lenient (it silently truncates or zero-pads),
	// so the length and prefix are checked explicitly first — a corrupted
	// address must be an error, not a silently different account.
	rawAddr := fields[2]
	if !common.IsHexAddress(rawAddr) {
		return nil, fmt.Errorf("%w: %q is not a hex address", ErrMalformedSysOp, rawAddr)
	}

	value, err := hexutil.DecodeBig(fields[3])
	if err != nil {
		return nil, fmt.Errorf("%w: balance %q: %v", ErrMalformedSysOp, fields[3], err)
	}

	return &SysOp{Kind: kind, Address: common.HexToAddress(rawAddr), Value: value}, nil
}

// ApplySysOp performs op against statedb. This is the single implementation
// the sequencer (sealing the block), M09's audit replay and M10's replica
// verifier all share — the whole point of the system-op design is that
// there is exactly one way a sysop block mutates state, so all three arrive
// at the same root.
//
// *** Version-sensitivity note (read first if `go build` fails here) ***
// StateDB.SetBalance's third parameter is go-ethereum's
// tracing.BalanceChangeReason. It is passed as the untyped constant 0
// (= tracing.BalanceChangeUnspecified) to avoid importing core/tracing for
// a single enum value — the same call shape already proven to compile in
// internal/state/statedb_test.go's AddBalance call. If this version's
// signature differs, fix just this one line.
func ApplySysOp(statedb *gethstate.StateDB, op *SysOp) error {
	switch op.Kind {
	case SysOpSetBalance:
		if op.Value == nil || op.Value.Sign() < 0 {
			return fmt.Errorf("%w: setBalance value must be non-negative, got %v", ErrMalformedSysOp, op.Value)
		}
		value, overflow := uint256.FromBig(op.Value)
		if overflow {
			return fmt.Errorf("%w: setBalance value %s exceeds 256 bits", ErrMalformedSysOp, op.Value)
		}
		statedb.SetBalance(op.Address, value, 0)
		return nil
	default:
		return fmt.Errorf("%w: %q", ErrUnknownSysOp, op.Kind)
	}
}
