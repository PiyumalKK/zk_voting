package rpc

import "github.com/ethereum/go-ethereum/core/vm"

// This file hand-assembles tiny EVM contracts for eth_read_test.go, the
// same technique internal/chain/testcontracts_test.go uses (duplicated
// here rather than shared, since that file's helpers are unexported in a
// different package) — bytecode built from named vm.OpCode constants, with
// every offset computed from len() rather than hand-counted.

// buildInitCode wraps runtime in EVM contract-creation code that deploys
// runtime verbatim as the new contract's code (standard CODECOPY-then-
// RETURN deployment prologue).
func buildInitCode(runtime []byte) []byte {
	if len(runtime) > 255 {
		panic("buildInitCode: runtime too long for a single PUSH1 length operand")
	}
	prologue := []byte{
		byte(vm.PUSH1), byte(len(runtime)),
		byte(vm.DUP1),
		byte(vm.PUSH1), 0, // placeholder, patched below
		byte(vm.PUSH1), 0x00,
		byte(vm.CODECOPY),
		byte(vm.PUSH1), 0x00,
		byte(vm.RETURN),
	}
	const codeOffsetIndex = 4
	prologue[codeOffsetIndex] = byte(len(prologue))
	return append(prologue, runtime...)
}

// returnFortyTwoRuntime always returns the 32-byte big-endian encoding of
// 42, regardless of calldata.
func returnFortyTwoRuntime() []byte {
	return []byte{
		byte(vm.PUSH1), 0x2a,
		byte(vm.PUSH1), 0x00,
		byte(vm.MSTORE),
		byte(vm.PUSH1), 0x20,
		byte(vm.PUSH1), 0x00,
		byte(vm.RETURN),
	}
}

// revertWithDataRuntime builds a contract that always reverts with exactly
// data as its revert payload, using the same "CODECOPY the trailing bytes
// of my own code, then act on them" trick buildInitCode uses for
// deployment — here ending in REVERT instead of RETURN, and CODECOPY-ing
// from the currently-executing runtime's own trailing bytes rather than an
// init code's.
func revertWithDataRuntime(data []byte) []byte {
	if len(data) > 255 {
		panic("revertWithDataRuntime: data too long for a single PUSH1 length operand")
	}
	prologue := []byte{
		byte(vm.PUSH1), byte(len(data)),
		byte(vm.DUP1),
		byte(vm.PUSH1), 0, // placeholder, patched below
		byte(vm.PUSH1), 0x00,
		byte(vm.CODECOPY),
		byte(vm.PUSH1), 0x00,
		byte(vm.REVERT),
	}
	const codeOffsetIndex = 4
	prologue[codeOffsetIndex] = byte(len(prologue))
	return append(prologue, data...)
}

// logRuntime emits two LOG1 events (topics 1 and 2, no log data) and stops
// — enough to assert that receipt logs carry sequential logIndex values and
// correct block/tx annotations, without needing a compiled Solidity
// contract in a unit test.
func logRuntime() []byte {
	log1 := func(topic byte) []byte {
		return []byte{
			byte(vm.PUSH1), topic, // topic1
			byte(vm.PUSH1), 0x00, // length = 0
			byte(vm.PUSH1), 0x00, // offset = 0
			byte(vm.LOG1),
		}
	}
	var out []byte
	out = append(out, log1(1)...)
	out = append(out, log1(2)...)
	out = append(out, byte(vm.STOP))
	return out
}

// logThreeRuntime emits a single LOG3 with three topics and one 32-byte
// data word — the shape a Solidity event with two indexed arguments
// compiles to. Added for M06's eth_getLogs tests, which need a log with
// distinct topics per position so positional filter decoding can be
// verified end-to-end over real JSON. Mirrors the identically-named helper
// in internal/chain/testcontracts_test.go (same duplication rationale as
// the rest of this file).
//
// LOG3 pops offset, size, then topics 1..3, so topics are pushed in reverse;
// MSTORE pops offset then value, hence "push value, push offset".
func logThreeRuntime(topic0, topic1, topic2, data byte) []byte {
	return []byte{
		byte(vm.PUSH1), data,
		byte(vm.PUSH1), 0x00,
		byte(vm.MSTORE),

		byte(vm.PUSH1), topic2,
		byte(vm.PUSH1), topic1,
		byte(vm.PUSH1), topic0,
		byte(vm.PUSH1), 0x20,
		byte(vm.PUSH1), 0x00,
		byte(vm.LOG3),
		byte(vm.STOP),
	}
}

// encodeErrorString ABI-encodes reason exactly as Solidity's
// `revert(reason)`/`require(cond, reason)` would: the 4-byte Error(string)
// selector, a 32-byte offset word (always 0x20 for a single dynamic
// param), a 32-byte length word, and the reason's bytes right-padded to a
// 32-byte boundary.
func encodeErrorString(reason string) []byte {
	selector := []byte{0x08, 0xc3, 0x79, 0xa0}

	offset := make([]byte, 32)
	offset[31] = 0x20

	length := make([]byte, 32)
	b := []byte(reason)
	if len(b) > 255 {
		panic("encodeErrorString: reason too long for this test helper")
	}
	length[31] = byte(len(b))

	padded := make([]byte, ((len(b)+31)/32)*32)
	copy(padded, b)
	if len(padded) == 0 {
		padded = make([]byte, 32)
	}

	out := append([]byte{}, selector...)
	out = append(out, offset...)
	out = append(out, length...)
	out = append(out, padded...)
	return out
}
