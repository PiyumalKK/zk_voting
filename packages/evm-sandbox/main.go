package main

import (
	"encoding/binary"
	"fmt"

	"evm-sandbox/internal/evm"

	"github.com/ethereum/go-ethereum/common"
)

func main() {

	// 1. Initialize ephemeral EVM state
	sm, err := evm.NewStateManager()
	if err != nil {
		panic(err)
	}

	evmInstance := evm.CreateStatelessEVM(sm.GetStateDB())

	caller := evm.NewContractCaller(evmInstance)

	// 2. Sender address for contract creation and later calls
	senderAddr := common.HexToAddress("0x0")

	// 3. Solidity creation bytecode, not runtime bytecode.
	// This init-code stores `10` in the constructor and then returns runtime code
	// that reads storage slot 0 and returns it.
	initCode := common.FromHex("600a600055600b6011600039600b6000f360005460005260206000f3")

	// 4. Deploy through EVM.Create so the constructor actually executes.
	contractAddr, _, err := caller.Deploy(senderAddr, initCode)
	if err != nil {
		panic(err)
	}

	// 5. Call the deployed runtime code. Empty calldata is enough for this demo.
	data := []byte{}

	// 6. Call contract
	ret, _, err := caller.Call(senderAddr, contractAddr, data)

	if err != nil {
		panic(err)
	}

	fmt.Println("Raw return:", ret)

	// 7. Decode uint256 return value
	if len(ret) >= 32 {
		value := binary.BigEndian.Uint64(ret[24:32])
		fmt.Println("Decoded value:", value)
	}
}