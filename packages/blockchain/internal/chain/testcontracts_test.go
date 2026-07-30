package chain

import "github.com/ethereum/go-ethereum/core/vm"

// This file hand-assembles a handful of tiny EVM contracts for the tests in
// sequencer_test.go. Bytecode is built from named vm.OpCode constants (not
// hand-typed hex strings), and every jump/offset value is computed with
// len() rather than counted by hand, so a change to any instruction
// sequence below can't silently desync an offset elsewhere in the same
// function — the two properties that make hand-rolled bytecode trustworthy
// without an assembler.

// buildInitCode wraps runtime in EVM contract-creation (init) code that
// deploys runtime verbatim as the new contract's code. It uses the
// standard CODECOPY-then-RETURN deployment prologue real compilers emit:
//
//	PUSH1 len(runtime)
//	DUP1
//	PUSH1 <codeOffset>   ; codeOffset = this prologue's own length
//	PUSH1 0x00
//	CODECOPY             ; memory[0:len] = initcode[codeOffset:codeOffset+len]
//	PUSH1 0x00
//	RETURN               ; return memory[0:len]
//	<runtime bytes...>
//
// codeOffset is filled in from len(prologue) after the prologue is built,
// so it's always correct even if the prologue above changes shape.
func buildInitCode(runtime []byte) []byte {
	if len(runtime) > 255 {
		panic("buildInitCode: runtime too long for a single PUSH1 length operand")
	}
	prologue := []byte{
		byte(vm.PUSH1), byte(len(runtime)), // [len]
		byte(vm.DUP1),     // [len, len]
		byte(vm.PUSH1), 0, // [len, len, codeOffset] -- 0 is a placeholder, patched below
		byte(vm.PUSH1), 0x00, // [len, len, codeOffset, 0]
		byte(vm.CODECOPY),    // [len]
		byte(vm.PUSH1), 0x00, // [len, 0]
		byte(vm.RETURN),
	}
	const codeOffsetIndex = 4
	prologue[codeOffsetIndex] = byte(len(prologue))
	return append(prologue, runtime...)
}

// returnFortyTwoRuntime always returns the 32-byte big-endian encoding of
// 42, regardless of calldata — the simplest possible "deploy, then read
// back a value via Call" fixture.
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

// counterRuntime implements a one-slot counter with a two-path dispatch on
// calldata size, entirely in storage slot 0:
//
//   - empty calldata (the "read" path, what Call uses): SLOAD slot 0,
//     return it as a 32-byte word.
//   - any calldata (the "write" path, what a submitted tx uses): SLOAD
//     slot 0, add 1, SSTORE it back, STOP.
//
// The dispatch's jump target (the read path's JUMPDEST) is computed from
// len(dispatch)+len(writePath), not hand-counted, so it can't drift out of
// sync if either section's instruction count changes.
func counterRuntime() []byte {
	writePath := []byte{
		byte(vm.PUSH1), 0x00, byte(vm.SLOAD),
		byte(vm.PUSH1), 0x01, byte(vm.ADD),
		byte(vm.PUSH1), 0x00, byte(vm.SSTORE),
		byte(vm.STOP),
	}
	readPath := []byte{
		byte(vm.JUMPDEST),
		byte(vm.PUSH1), 0x00, byte(vm.SLOAD),
		byte(vm.PUSH1), 0x00, byte(vm.MSTORE),
		byte(vm.PUSH1), 0x20, byte(vm.PUSH1), 0x00, byte(vm.RETURN),
	}
	dispatch := []byte{
		byte(vm.CALLDATASIZE),
		byte(vm.ISZERO),
		byte(vm.PUSH1), 0, // placeholder, patched below: readPath's JUMPDEST offset
		byte(vm.JUMPI),
	}
	const readOffsetIndex = 3
	dispatch[readOffsetIndex] = byte(len(dispatch) + len(writePath))

	out := append(append([]byte{}, dispatch...), writePath...)
	out = append(out, readPath...)
	return out
}

// revertRuntime always reverts with exactly the 4-byte selector 0xdeadbeef
// as its revert data — the shape a Solidity `revert CustomError();` with a
// zero-argument custom error compiles to (PUSH4 selector, MSTORE it as the
// top 4 bytes of a right-aligned 32-byte word at memory[0:32], REVERT the
// 4 non-zero bytes at memory[28:32]).
func revertRuntime() []byte {
	return []byte{
		byte(vm.PUSH4), 0xde, 0xad, 0xbe, 0xef,
		byte(vm.PUSH1), 0x00,
		byte(vm.MSTORE),
		byte(vm.PUSH1), 0x04,
		byte(vm.PUSH1), 0x1c,
		byte(vm.REVERT),
	}
}

// logRuntime emits three LOG1 events (topics 1, 2, 3; no log data) and
// stops — for asserting sequential log indices and a bloom filter that
// contains the emitting contract's address.
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
	out = append(out, log1(3)...)
	out = append(out, byte(vm.STOP))
	return out
}
