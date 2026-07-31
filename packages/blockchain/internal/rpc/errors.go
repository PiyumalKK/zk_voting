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
