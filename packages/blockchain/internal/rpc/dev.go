package rpc

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"

	"github.com/ethereum/go-ethereum/common"

	"zk-blockchain/internal/chain"
)

// This file implements M07: the small set of non-standard methods the
// Hardhat contract test suite and dev tooling need — `evm_increaseTime`,
// `evm_setNextBlockTimestamp`, `evm_mine`, and `hardhat_setBalance` with its
// `anvil_setBalance` alias.
//
// All of them are gated behind DEV_RPC=true, which is enforced structurally
// rather than with per-method checks: server.go simply does not register
// these namespaces when the flag is off, so go-ethereum's own dispatcher
// answers -32601 "the method … does not exist/is not available" — the same
// response any genuinely unknown method gets, with no way for a
// half-initialised service to leak a mutation path into a production node.
//
// *** Return-value provenance (read before "fixing" any of these) ***
// Hardhat is inconsistent about how these four methods encode their return
// values — two return *decimal* strings, one returns a hex quantity, one
// returns a boolean — and this file reproduces that inconsistency
// deliberately, from knowledge of Hardhat's evm module rather than from
// observation (the agent that wrote M07 had no Go or Hardhat toolchain).
// `e2e/diff/dev.mjs` asserts every one of them against a live `hardhat
// node`; treat that harness's output as authoritative over these comments,
// exactly as M05's error strings are governed by `e2e/diff/write.mjs`.

// devUint64 decodes a JSON-RPC numeric parameter from any of the three
// forms real callers send, because the consumers that matter disagree:
// `packages/hardhat/test/Voting.ts` calls
// `ethers.provider.send("evm_increaseTime", [3601])` with a **bare JSON
// number**, while curl-based tooling and viem send hex quantity strings
// ("0xe11"). geth's own hexutil.Uint64 accepts only the latter and would
// reject the hardhat test suite outright — the M08 gate depends on this
// type being liberal.
//
// The literal's *text* is parsed rather than going through float64, so a
// value above 2^53 decodes exactly instead of silently rounding.
type devUint64 uint64

// UnmarshalJSON accepts 3601, "3601" and "0xe11" (any letter case), and
// rejects fractional, exponent-form, negative and out-of-range values.
func (d *devUint64) UnmarshalJSON(data []byte) error {
	s, err := numericLiteral(data)
	if err != nil {
		return err
	}

	base := 10
	if lower := strings.ToLower(s); strings.HasPrefix(lower, "0x") {
		base, s = 16, s[2:]
	}
	v, err := strconv.ParseUint(s, base, 64)
	if err != nil {
		return fmt.Errorf("invalid unsigned integer %s: %w", string(data), err)
	}
	*d = devUint64(v)
	return nil
}

// devBig is devUint64's arbitrary-precision sibling, used for the wei
// balance `hardhat_setBalance` takes — 10,000 ETH already needs more than
// 64 bits.
type devBig big.Int

// UnmarshalJSON accepts the same three forms as devUint64. Unlike geth's
// hexutil.Big it tolerates leading zeros ("0x01"), which is a deliberate
// superset of Hardhat's stricter validation: the compatibility requirement
// runs one way — every input Hardhat accepts must work here, so the M08
// hardhat test run passes — and accepting a little more than Hardhat does
// cannot break that direction.
func (d *devBig) UnmarshalJSON(data []byte) error {
	s, err := numericLiteral(data)
	if err != nil {
		return err
	}

	base := 10
	if lower := strings.ToLower(s); strings.HasPrefix(lower, "0x") {
		base, s = 16, s[2:]
	}
	v, ok := new(big.Int).SetString(s, base)
	if !ok {
		return fmt.Errorf("invalid integer %s", string(data))
	}
	if v.Sign() < 0 {
		return fmt.Errorf("value %s must not be negative", string(data))
	}
	*d = devBig(*v)
	return nil
}

func (d *devBig) toInt() *big.Int { return (*big.Int)(d) }

// numericLiteral unwraps a JSON scalar into the digit text devUint64 and
// devBig parse: it strips the quotes from a JSON string, leaves a bare JSON
// number as-is, and rejects the forms neither type can represent (null, an
// empty value, and the fractional/exponent number forms JSON permits but an
// integer parameter never legitimately uses).
func numericLiteral(data []byte) (string, error) {
	s := strings.TrimSpace(string(data))
	switch {
	case s == "" || s == "null":
		return "", errors.New("value must not be null")
	case strings.HasPrefix(s, `"`) && strings.HasSuffix(s, `"`) && len(s) >= 2:
		s = strings.TrimSpace(s[1 : len(s)-1])
	case strings.ContainsAny(s, ".eE"):
		// Guarded only for bare numbers: "0xe11" legitimately contains 'e',
		// which is why this case sits after the quoted-string case.
		return "", fmt.Errorf("value %s must be an integer, not a decimal or exponent", string(data))
	}
	if s == "" {
		return "", errors.New("value must not be empty")
	}
	return s, nil
}

// EvmService implements the JSON-RPC "evm" namespace (M07 deliverables
// 1–3). Registered only when DEV_RPC=true.
type EvmService struct {
	seq *chain.Sequencer
}

// NewEvmService builds the evm_* method set over seq.
func NewEvmService(seq *chain.Sequencer) *EvmService { return &EvmService{seq: seq} }

// IncreaseTime implements evm_increaseTime: shifts the dev clock forward by
// seconds, affecting every block sealed afterward (MASTER §10 pitfall 7 —
// the shift lands in each header's stored timestamp, so replicas and audit
// replay reproduce it from the header rather than from any node-local
// clock).
//
// Returns the new *total* accumulated offset as a **decimal** string. That
// is not a typo and not this codebase's choice: `evm_increaseTime` is the
// documented exception to Hardhat's hex-quantity convention, and
// `hardhat-network-helpers`' `time.increase()` parses the result as
// decimal. Verified by `make diff-dev`.
//
// The total is signed and formatted with FormatInt, not FormatUint: it goes
// negative whenever evm_setNextBlockTimestamp has pinned a block below wall
// clock, which is reachable on a fresh chain (genesis is timestamped 0).
// See Sequencer.IncreaseTime.
func (e *EvmService) IncreaseTime(ctx context.Context, seconds devUint64) (string, error) {
	total, err := e.seq.IncreaseTime(uint64(seconds))
	if err != nil {
		return "", mapDevError(err)
	}
	return strconv.FormatInt(total, 10), nil
}

// SetNextBlockTimestamp implements evm_setNextBlockTimestamp: pins the
// exact timestamp of the next block to be sealed. Also returns a decimal
// string (same Hardhat exception as IncreaseTime).
//
// A timestamp at or below the current head is an error, not a clamp —
// MASTER §10 pitfall 7 makes strictly-increasing timestamps a chain
// invariant, and Voting.sol's phase deadlines depend on it.
func (e *EvmService) SetNextBlockTimestamp(ctx context.Context, timestamp devUint64) (string, error) {
	if err := e.seq.SetNextBlockTimestamp(uint64(timestamp)); err != nil {
		return "", mapDevError(err)
	}
	return strconv.FormatUint(uint64(timestamp), 10), nil
}

// Mine implements evm_mine: seals one empty block. The optional timestamp
// parameter pins that block's time, exactly as a preceding
// evm_setNextBlockTimestamp would.
//
// Returns the decimal string "0". I originally wrote "0x0" here, reasoning
// that evm_mine would follow the hex-quantity convention that
// evm_increaseTime is the documented exception to. `make diff-dev` put that
// to a live Hardhat node, which returns "0" — so all three evm_ methods
// return decimal and the exception is broader than the docs suggest. The
// value carries no information either way; callers await the call, not its
// result.
//
// The timestamp path goes through MineEmptyBlockAt rather than
// SetNextBlockTimestamp-then-MineEmptyBlock so that pinning and sealing
// happen under a single lock — see that method's doc comment.
func (e *EvmService) Mine(ctx context.Context, timestamp *devUint64) (string, error) {
	var err error
	if timestamp != nil {
		_, err = e.seq.MineEmptyBlockAt(uint64(*timestamp))
	} else {
		_, err = e.seq.MineEmptyBlock()
	}
	if err != nil {
		return "", mapDevError(err)
	}
	return "0", nil
}

// HardhatService implements the JSON-RPC "hardhat" namespace (M07
// deliverable 4). Registered only when DEV_RPC=true.
type HardhatService struct {
	seq *chain.Sequencer
}

// NewHardhatService builds the hardhat_* method set over seq.
func NewHardhatService(seq *chain.Sequencer) *HardhatService { return &HardhatService{seq: seq} }

// SetBalance implements hardhat_setBalance. The write is sealed as a
// *system-op block* rather than applied directly to the trie — MASTER §10
// pitfall 10: state may only change inside blocks, so that M09's audit
// replay and M10's replicas can reproduce it from the block list alone. See
// internal/chain/sysop.go.
//
// Returns `true`, matching Hardhat.
func (h *HardhatService) SetBalance(ctx context.Context, address common.Address, balance devBig) (bool, error) {
	if _, err := h.seq.SetBalance(address, balance.toInt()); err != nil {
		return false, mapDevError(err)
	}
	return true, nil
}

// AnvilService exposes the same method set under the "anvil" namespace
// (MASTER §9 lists `anvil_setBalance` alongside `hardhat_setBalance`).
// Embedding rather than re-declaring the method keeps the two aliases
// provably identical: Go promotes *HardhatService's methods into
// *AnvilService's method set, which is what go-ethereum's reflection-based
// registry scans.
type AnvilService struct {
	*HardhatService
}

// NewAnvilService builds the anvil_* alias namespace over seq.
func NewAnvilService(seq *chain.Sequencer) *AnvilService {
	return &AnvilService{HardhatService: NewHardhatService(seq)}
}

// mapDevError translates internal/chain's dev-method errors into the
// JSON-RPC shapes Hardhat returns for the same conditions. Like
// mapSubmitError (errors.go) the wording reproduces Hardhat's text so that
// a consumer which substring-matches keeps working across a backend swap;
// `e2e/diff/dev.mjs` is the authority on whether it still does.
func mapDevError(err error) error {
	switch {
	case errors.Is(err, chain.ErrTimestampNotIncreasing):
		return newCodedError(invalidInputCode, "Timestamp error: %v", err)
	case errors.Is(err, chain.ErrDevOffsetOutOfRange),
		errors.Is(err, chain.ErrMalformedSysOp),
		errors.Is(err, chain.ErrUnknownSysOp):
		return newCodedError(invalidInputCode, "%v", err)
	default:
		return err
	}
}
