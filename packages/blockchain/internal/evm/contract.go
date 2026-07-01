package evm

import (
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/vm"
	"github.com/holiman/uint256"
)

type ContractCaller struct {
	evm *vm.EVM
}

func NewContractCaller(evm *vm.EVM) *ContractCaller {
	return &ContractCaller{evm: evm}
}

// gasLimit is the per-call/deploy gas budget. Since this blockchain has no gas
// economics (no fees, authority model), we set it high enough that legitimate
// operations never run out. Poseidon hashing inside the LeanIMT is the most
// expensive operation and can use tens of millions of gas per call.
const gasLimit = uint64(1_000_000_000) // 1B gas — effectively unlimited for our usage

// Call executes a contract function.
// 'from' becomes msg.sender, 'to' is the contract address.
func (cc *ContractCaller) Call(from, to common.Address, data []byte) ([]byte, uint64, error) {
	ret, gas, err := cc.evm.Call(vm.AccountRef(from), to, data, gasLimit, uint256.NewInt(0))
	return ret, gas, err
}

// Deploy executes contract init-code, runs the constructor, and installs the returned runtime code.
// The input must be Solidity creation bytecode, not runtime bytecode.
func (cc *ContractCaller) Deploy(from common.Address, initCode []byte) (common.Address, []byte, error) {
	ret, contractAddr, _, err := cc.evm.Create(vm.AccountRef(from), initCode, gasLimit, uint256.NewInt(0))
	return contractAddr, ret, err
}

// InstallRuntimeCode keeps the low-level escape hatch for cases where init-code is not available.
// It bypasses constructor execution and should only be used when that is explicitly desired.
func (cc *ContractCaller) InstallRuntimeCode(addr common.Address, runtimeCode []byte) {
	cc.evm.StateDB.SetCode(addr, runtimeCode)
}
