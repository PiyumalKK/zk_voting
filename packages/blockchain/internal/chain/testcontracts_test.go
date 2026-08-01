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

// storageChurnRuntime writes ten storage slots when called with any
// calldata, and clears those same ten slots when called with none.
//
// Clearing non-zero slots is what earns EIP-3529 gas refunds, and refunds
// are the reason gas estimation cannot simply pad the reported UsedGas:
// core.ExecutionResult.UsedGas is *net* of the refund, while the
// transaction must be funded with the gross amount. Ten cleared slots put
// the refund at the EIP-3529 cap (gross/5), reproducing in one call the
// shape of Voting.resetElection() — the method whose underestimated gas
// limit broke seven M08 tests with an opaque "execution reverted".
func storageChurnRuntime() []byte {
	const slots = 10

	// store emits `slots` SSTOREs of the given value into slots 0..9.
	store := func(value byte) []byte {
		var out []byte
		for slot := byte(0); slot < slots; slot++ {
			out = append(out,
				byte(vm.PUSH1), value,
				byte(vm.PUSH1), slot,
				byte(vm.SSTORE),
			)
		}
		return out
	}

	fillPath := append(store(1), byte(vm.STOP))
	clearPath := append([]byte{byte(vm.JUMPDEST)}, store(0)...)
	clearPath = append(clearPath, byte(vm.STOP))

	dispatch := []byte{
		byte(vm.CALLDATASIZE),
		byte(vm.ISZERO),
		byte(vm.PUSH1), 0, // placeholder, patched below: clearPath's JUMPDEST offset
		byte(vm.JUMPI),
	}
	const clearOffsetIndex = 3
	dispatch[clearOffsetIndex] = byte(len(dispatch) + len(fillPath))

	out := append(append([]byte{}, dispatch...), fillPath...)
	return append(out, clearPath...)
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

// logThreeRuntime emits a single LOG3 carrying three topics and one 32-byte
// data word, then stops — the shape a Solidity event with two indexed
// arguments compiles to (topic0 = the event signature hash, topic1/topic2 =
// the indexed args, data = the non-indexed ones). Built for M06's
// eth_getLogs filter tests, which need logs whose topics differ per
// position so that positional matching can actually be distinguished from
// "matches anything".
//
// Each topic is a single PUSH1 byte, so the resulting 32-byte topic is that
// byte right-aligned in a zero word (topic0=0x11 becomes
// 0x0000…0011). That is not what a real event signature hash looks like,
// but the filter logic is indifferent to a topic's provenance — and
// e2e/diff/logs.mjs exercises the real keccak topics against a live Hardhat
// node, which is where that fidelity belongs.
//
// Stack discipline: LOG3 pops offset, then size, then topics 1..3, so they
// are pushed in the reverse of that order. MSTORE pops offset then value,
// hence "push value, push offset".
func logThreeRuntime(topic0, topic1, topic2, data byte) []byte {
	return []byte{
		byte(vm.PUSH1), data,
		byte(vm.PUSH1), 0x00,
		byte(vm.MSTORE), // memory[0:32] = data, right-aligned

		byte(vm.PUSH1), topic2, // third topic
		byte(vm.PUSH1), topic1, // second topic
		byte(vm.PUSH1), topic0, // first topic
		byte(vm.PUSH1), 0x20, // size = 32 bytes of data
		byte(vm.PUSH1), 0x00, // offset = 0
		byte(vm.LOG3),
		byte(vm.STOP),
	}
}
