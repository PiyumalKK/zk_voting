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
		GasLimit:    100000000, // Very high limit: we are the authority!
	}

	// 2. Define Transaction Context
	txContext := vm.TxContext{
		Origin:   common.Address{}, // The 'tx.origin' in Solidity
		GasPrice: big.NewInt(0),    // Set to 0 to eliminate gas costs
	}

	// 3. Define Chain Config (Enabling ZK Math)
	// We explicitly set IstanbulBlock to 0. 
	// Istanbul introduced EIP-1108 which optimizes BN254 pairing 
	// precompiles (address 0x08) required for Noir proofs.
	config := &params.ChainConfig{
		ChainID:             big.NewInt(1337),
		HomesteadBlock:      big.NewInt(0),
		ByzantiumBlock:      big.NewInt(0),
		ConstantinopleBlock: big.NewInt(0),
		PetersburgBlock:     big.NewInt(0),
		IstanbulBlock:       big.NewInt(0),
		BerlinBlock:         big.NewInt(0),
		LondonBlock:         big.NewInt(0),
	}

	// 4. Initialize EVM
	return vm.NewEVM(blockContext, txContext, stateDB, config, vm.Config{})
}