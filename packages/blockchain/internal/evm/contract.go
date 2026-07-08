package evm

import (
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/vm"
	"github.com/ethereum/go-ethereum/crypto"
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

// SetTime sets the EVM's block timestamp (unix SECONDS) for subsequent calls.
// Voting.sol reads block.timestamp to enforce registration/voting deadlines, so
// callers must stamp the correct time before every call:
//   - interactive writes: the wall-clock instant that also becomes the block's
//     persisted timestamp (making replay deterministic)
//   - replay: the stored block's timestamp
//   - reads: the current wall clock (so expired phases report as Ended)
//
// Not safe for concurrent use — ContractBridge serializes all EVM access under
// its mutex, which is the only place this is called from.
func (cc *ContractCaller) SetTime(unixSec uint64) {
	cc.evm.Context.Time = unixSec
}

// CodeHash returns the keccak256 hash of the runtime bytecode deployed at addr.
// Logged at startup so a stale compiled artifact (assets/ out of sync with
// packages/hardhat) is visible immediately.
func (cc *ContractCaller) CodeHash(addr common.Address) common.Hash {
	return crypto.Keccak256Hash(cc.evm.StateDB.GetCode(addr))
}

// InstallRuntimeCode keeps the low-level escape hatch for cases where init-code is not available.
// It bypasses constructor execution and should only be used when that is explicitly desired.
func (cc *ContractCaller) InstallRuntimeCode(addr common.Address, runtimeCode []byte) {
	cc.evm.StateDB.SetCode(addr, runtimeCode)
}
