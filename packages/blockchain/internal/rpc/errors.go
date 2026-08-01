package rpc

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"

	"github.com/ethereum/go-ethereum/common/hexutil"

	"zk-blockchain/internal/chain"
)

// This file maps internal/chain's *chain.RevertError onto the exact
// JSON-RPC error shape viem expects (MASTER §10 pitfall 1): code 3,
// message "execution reverted[: <reason>]", and a `data` field carrying
// the raw revert bytes (0x-prefixed) so viem can decode custom Solidity
// errors (Voting__NullifierHashAlreadyUsed, …) exactly as it does against
// Hardhat. Verified against a real `hardhat node` by e2e/diff, not just by
// reading the spec — see M04's acceptance gate.

// revertErrorCode is the JSON-RPC error code Ethereum clients use for
// "execution reverted" (distinct from the standard -32000-range server
// errors) — MASTER §10 pitfall 1.
const revertErrorCode = 3

// revertError implements both gethrpc's Error interface (Error() string +
// ErrorCode() int) and its DataError interface (Error() string +
// ErrorData() interface{}); the server only includes a `data` field in the
// JSON-RPC error response for errors implementing the latter, which is
// exactly what viem's custom-error decoder reads.
type revertError struct {
	msg  string
	data []byte
}

// newRevertError builds a revertError from raw EVM revert data, decoding a
// standard Solidity `revert("reason")` (Error(string) selector
// 0x08c379a0) reason string into the message when present; a custom error
// (`revert CustomError(...)`, no decodable string) keeps the bare
// "execution reverted" message and relies entirely on `data` for the
// caller to decode.
func newRevertError(data []byte) *revertError {
	msg := "execution reverted"
	if reason := decodeRevertReason(data); reason != "" {
		msg = fmt.Sprintf("execution reverted: %s", reason)
	}
	return &revertError{msg: msg, data: data}
}

func (e *revertError) Error() string          { return e.msg }
func (e *revertError) ErrorCode() int         { return revertErrorCode }
func (e *revertError) ErrorData() interface{} { return hexutil.Encode(e.data) }

// errorStringSelector is the 4-byte selector of Solidity's built-in
// `Error(string)`, which `revert("...")` and `require(cond, "...")` both
// compile to.
var errorStringSelector = []byte{0x08, 0xc3, 0x79, 0xa0}

// decodeRevertReason best-effort decodes a standard ABI-encoded
// Error(string) revert payload (selector + offset word + length word +
// UTF-8 bytes) and returns "" for anything else — most importantly for a
// custom error's revert data, which does not follow this layout at all.
func decodeRevertReason(data []byte) string {
	if len(data) < 4+32+32 || !bytes.Equal(data[:4], errorStringSelector) {
		return ""
	}
	payload := data[4:]

	// payload[0:32] is the string's ABI offset, always 0x20 for a single
	// dynamic-string return; skip it and read the length word directly.
	lengthWord := payload[32:64]
	// Guard against a length word using more than 8 bytes of magnitude —
	// nothing legitimate ever does, and it would otherwise let a malformed
	// payload claim an absurd length before the bounds check below.
	if !isUint64Range(lengthWord) {
		return ""
	}
	length := binary.BigEndian.Uint64(lengthWord[24:32])

	start := uint64(64)
	if uint64(len(payload)) < start+length {
		return ""
	}
	return string(payload[start : start+length])
}

// isUint64Range reports whether a 32-byte big-endian word's value fits in
// a uint64 (i.e. its top 24 bytes are all zero).
func isUint64Range(word []byte) bool {
	for _, b := range word[:24] {
		if b != 0 {
			return false
		}
	}
	return true
}

// mapCallError translates a *chain.RevertError (from Sequencer.Call/
// EstimateGas) into the JSON-RPC revert shape gethrpc's server recognizes;
// any other error is passed through unchanged (it becomes a generic
// JSON-RPC -32000 "internal error" via the server's default handling,
// which is correct — MASTER §10 pitfall 1 only special-cases reverts).
func mapCallError(err error) error {
	var revertErr *chain.RevertError
	if errors.As(err, &revertErr) {
		return newRevertError(revertErr.Data)
	}
	return err
}

// invalidInputCode is the JSON-RPC error code Hardhat Network reports for
// every transaction-validation rejection below (its InvalidInputError). It
// is also the conventional "server error" code Ethereum clients use for the
// same class of failure, so matching it costs nothing and keeps tooling that
// branches on the code behaving identically across both backends.
const invalidInputCode = -32000

// codedError is a JSON-RPC error with an explicit code and no `data` field —
// the shape every non-revert failure below uses. (Reverts use revertError
// instead, which additionally carries `data`.)
type codedError struct {
	code int
	msg  string
}

func (e *codedError) Error() string  { return e.msg }
func (e *codedError) ErrorCode() int { return e.code }

func newCodedError(code int, format string, args ...any) *codedError {
	return &codedError{code: code, msg: fmt.Sprintf(format, args...)}
}

// mapSubmitError translates everything Sequencer.SubmitTx can return into
// the JSON-RPC error a Hardhat-compatible client expects.
//
// *** Wording provenance (read before "fixing" any string here) ***
// The messages below reproduce Hardhat Network's own text, because the
// mobile and web clients substring-match error messages (MASTER §10 pitfall
// 2 / M05 spec deliverable 1) and a swap between backends must not change
// what they see. They were written from knowledge of Hardhat's source rather
// than observed from a live node — the agent that wrote M05 had no Go or
// Hardhat toolchain available. `e2e/diff/write.mjs` asserts each of them
// against a real `hardhat node` and reports any drift, so treat that
// harness's output as authoritative over this comment and adjust the strings
// here if it disagrees.
//
// Two cases (insufficient funds, intrinsic gas) keep Hardhat's *prefix* but
// append go-ethereum's own detail instead of reproducing Hardhat's exact
// numeric suffix: computing "max upfront cost" / "requires at least N gas"
// independently would mean duplicating geth's fee and intrinsic-gas
// arithmetic in this package, which internal/chain/validate.go's doc comment
// explicitly rejects as a source of drift. Neither is substring-matched by
// any consumer in MASTER §2's table, and both are effectively unreachable
// under the free-gas policy (gasPrice is always 0, so the only way to be
// short of funds is a value transfer larger than the balance). They are
// deliberately not covered by write.mjs for the same reason — there is no
// Hardhat text to diff against that anything depends on.
func mapSubmitError(err error, chainID uint64) error {
	var revertErr *chain.RevertError
	if errors.As(err, &revertErr) {
		return newRevertError(revertErr.Data)
	}

	var nonceErr *chain.NonceError
	if errors.As(err, &nonceErr) {
		direction := "Nonce too high"
		if nonceErr.TooLow() {
			direction = "Nonce too low"
		}
		return newCodedError(invalidInputCode,
			"%s. Expected nonce to be %d but got %d. Note that transactions can't be queued when automining.",
			direction, nonceErr.AccountNonce, nonceErr.TxNonce)
	}

	var gasErr *chain.GasLimitError
	if errors.As(err, &gasErr) {
		return newCodedError(invalidInputCode,
			"Transaction gas limit is %d and exceeds block gas limit of %d",
			gasErr.TxGas, gasErr.BlockGasLimit)
	}

	switch {
	case errors.Is(err, chain.ErrWrongChainID):
		return newCodedError(invalidInputCode,
			"Trying to send a raw transaction with an invalid chainId. The expected chainId is %d", chainID)
	// Fallbacks for a nonce failure that did not come from validateTx and so
	// carries no *chain.NonceError: core.ApplyMessage's own pre-check raises
	// the same sentinels (mapped in internal/chain/execute.go). validateTx
	// checks the nonce first, so these are unreachable today — they exist so
	// that if that ordering ever changes, the message still starts with the
	// phrase clients substring-match instead of falling through to
	// go-ethereum's wording.
	case errors.Is(err, chain.ErrNonceTooLow):
		return newCodedError(invalidInputCode, "Nonce too low. %v", err)
	case errors.Is(err, chain.ErrNonceTooHigh):
		return newCodedError(invalidInputCode, "Nonce too high. %v", err)
	case errors.Is(err, chain.ErrGasLimitExceeded):
		return newCodedError(invalidInputCode, "Transaction gas limit exceeds block gas limit: %v", err)
	case errors.Is(err, chain.ErrInsufficientFunds):
		return newCodedError(invalidInputCode, "Sender doesn't have enough funds to send tx: %v", err)
	case errors.Is(err, chain.ErrIntrinsicGas):
		return newCodedError(invalidInputCode, "Transaction requires more gas than it was given: %v", err)
	default:
		return err
	}
}
