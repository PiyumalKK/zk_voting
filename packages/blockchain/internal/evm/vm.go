package evm

import (
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/rawdb"
	"github.com/ethereum/go-ethereum/core/state"
	"github.com/ethereum/go-ethereum/core/vm"
	"github.com/ethereum/go-ethereum/params"
	"github.com/holiman/uint256"
)

// StateManager handles the ephemeral EVM state.
type StateManager struct {
	stateDB *state.StateDB
}

// NewStateManager creates a new state database in memory.
func NewStateManager() (*StateManager, error) {
	// RawDB is Geth's storage layer. rawdb.NewMemoryDatabase() ensures 
	// that no data is written to disk during execution.
	db := rawdb.NewMemoryDatabase()
	
	// StateDB manages account states (balance, code, storage variables).
	// common.Hash{} initializes an empty state root.
	sdb, err := state.New(common.Hash{}, state.NewDatabase(db), nil)
	if err != nil {
		return nil, err
	}

	return &StateManager{stateDB: sdb}, nil
}

// GetStateDB returns the underlying Geth StateDB.
func (sm *StateManager) GetStateDB() *state.StateDB {
	return sm.stateDB
}

// CreateStatelessEVM initializes a Geth EVM configured for ZK verification.
func CreateStatelessEVM(stateDB *state.StateDB) *vm.EVM {
	// 1. Define Block Context (The "Environment")
	// Since we are stateless, we spoof these values.
	blockContext := vm.BlockContext{
		// CanTransfer/Transfer are disabled (always return true/success)
		// because we don't use ETH currency.
		CanTransfer: func(db vm.StateDB, addr common.Address, amount *uint256.Int) bool { return true },
		Transfer:    func(db vm.StateDB, sender, recipient common.Address, amount *uint256.Int) {},
		GetHash:     func(n uint64) common.Hash { return common.Hash{} },
		Coinbase:    common.Address{},
		BlockNumber: big.NewInt(1),
		Time:        1,
		Difficulty:  big.NewInt(1),
		GasLimit:    1_000_000_000, // No gas economics: authority model, so no practical limit.
		BaseFee:     big.NewInt(0), // Must be non-nil with London; zero since we have no fee market.
	}

	// 2. Define Transaction Context
	txContext := vm.TxContext{
		Origin:   common.Address{}, // The 'tx.origin' in Solidity
		GasPrice: big.NewInt(0),    // Zero: no fee market in this blockchain.
	}

	// 3. Define Chain Config (Enabling ZK Math)
	//
	// Fork selection rationale:
	//   EIP-150 (Tangerine Whistle): REQUIRED — introduces the 63/64 gas forwarding rule
	//     for CALL/DELEGATECALL. Without it, callGas() forwards ALL available gas to the
	//     callee; combined with EIP-2929's cold-account base cost (Berlin), this causes
	//     baseCost+forwardedGas to exceed available gas → OOG before LeanIMT runs.
	//   EIP-155/158: replay protection and state clearing (safe defaults).
	//   Istanbul: REQUIRED — EIP-1108 reduces BN254 pairing precompile gas cost (address
	//     0x08, needed for UltraHonk ZK proof verification).
	//   Berlin: REQUIRED — EIP-2929 access-list gas schedule matches Solidity 0.8+ output.
	//   London: NOT included — EIP-1559 base-fee mechanics are irrelevant (no fee market)
	//     and the BASEFEE opcode is not used by any contract we deploy.
	config := &params.ChainConfig{
		ChainID:             big.NewInt(1337),
		HomesteadBlock:      big.NewInt(0),
		EIP150Block:         big.NewInt(0),
		EIP155Block:         big.NewInt(0),
		EIP158Block:         big.NewInt(0),
		ByzantiumBlock:      big.NewInt(0),
		ConstantinopleBlock: big.NewInt(0),
		PetersburgBlock:     big.NewInt(0),
		IstanbulBlock:       big.NewInt(0),
		BerlinBlock:         big.NewInt(0),
	}

	// 4. Initialize EVM — NoBaseFee bypasses EIP-1559 gas-price checks, which
	// would otherwise require GasPrice >= BaseFee (both 0 here, but the check
	// path itself can dereference a nil pointer inside nested DELEGATECALL frames).
	return vm.NewEVM(blockContext, txContext, stateDB, config, vm.Config{NoBaseFee: true})
}
