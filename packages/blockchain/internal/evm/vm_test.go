package evm

import (
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/vm"
)

// TestEVMPrecompiles verifies that the BN254 pairing precompile (address 0x08)
// is reachable under the Istanbul fork config. This precompile is the cryptographic
// engine that verifies Noir/Barretenberg ZK proofs.
func TestEVMPrecompiles(t *testing.T) {
	sm, err := NewStateManager()
	if err != nil {
		t.Fatalf("Failed to create StateManager: %v", err)
	}

	evmInstance := CreateStatelessEVM(sm.GetStateDB())

	// Address 0x08 is the BN254 pairing precompile (EIP-197, activated in Byzantium,
	// gas cost reduced in Istanbul via EIP-1108).
	precompileAddr := common.BytesToAddress([]byte{0x08})

	// A StaticCall with empty input to the pairing precompile should succeed and return
	// a 32-byte result (the encoding of the scalar 1 for the empty pairing check).
	ret, _, err := evmInstance.StaticCall(vm.AccountRef(common.Address{}), precompileAddr, []byte{}, 1_000_000)
	if err != nil {
		t.Fatalf("BN254 pairing precompile call failed: %v", err)
	}
	if len(ret) == 0 {
		t.Error("Precompile returned empty result — Istanbul fork may not be active in config")
	}
}
