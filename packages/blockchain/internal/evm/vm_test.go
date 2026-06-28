package evm

import (
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

func TestEVMPrecompiles(t *testing.T) {
	sm, err := NewStateManager()
	if err != nil {
		t.Fatalf("Failed to create StateManager: %v", err)
	}

	evm := CreateStatelessEVM(sm.GetStateDB())

	// Address 0x08 is the BN254 Pairing precompile.
	// This is the "Engine" that verifies Noir/Barretenberg proofs.
	precompileAddr := common.BytesToAddress([]byte{0x08})

	// Perform a StaticCall with empty data.
	// If the precompile is active, it will return a result (success).
	// If it is disabled (wrong fork), it will return nil or an error.
	ret, _, err := evm.StaticCall(AccountRef(common.Address{}), precompileAddr, []byte{}, 1000000)

	if err != nil {
		t.Fatalf("Precompile call failed: %v", err)
	}

	if len(ret) == 0 {
		t.Error("Precompile returned empty result; Istanbul fork might be disabled in config")
	}
}

// AccountRef is a helper to satisfy Geth's vm.AccountRef interface
type AccountRef common.Address

func (ar AccountRef) Address() common.Address { return common.Address(ar) }
