package chain

import (
	"bytes"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
)

// TestEstimateGasCoversStorageRefunds is the regression test for the bug that
// broke M08's contract test suite.
//
// core.ExecutionResult.UsedGas is reported *net of gas refunds*, but a
// transaction must be funded with the gross amount to execute. EstimateGas
// used to return UsedGas * 1.1, and EIP-3529 lets the refund reach gross/5 —
// so gross can be 1.25x UsedGas and the estimate came back short. Voting's
// resetElection() clears an array, a string and three slots, landing near
// that cap; ethers uses the estimate as the transaction's gas limit, so seven
// tests failed with an out-of-gas revert that carried no data and therefore
// no clue.
//
// The assertion that matters is the last one: a transaction submitted with
// *exactly* what EstimateGas returned must succeed. That is the contract
// every caller relies on, and the property the old implementation violated.
func TestEstimateGasCoversStorageRefunds(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	from := crypto.PubkeyToAddress(key.PublicKey)
	chainID := big.NewInt(testChainID)

	_, churn := deploy(t, seq, key, chainID, 0, storageChurnRuntime())

	// Any calldata takes the fill path: ten slots go from zero to non-zero.
	fillReceipt, err := seq.SubmitTx(mustSignTx(t, key, chainID, 1, &churn, big.NewInt(0), 500_000, []byte{0x01}))
	if err != nil {
		t.Fatalf("fill: %v", err)
	}
	if fillReceipt.Status != types.ReceiptStatusSuccessful {
		t.Fatalf("fill tx status = %d, want success", fillReceipt.Status)
	}

	// Empty calldata takes the clear path, which is where the refunds arise.
	estimate, err := seq.EstimateGas(CallMsg{From: from, To: &churn})
	if err != nil {
		t.Fatalf("EstimateGas: %v", err)
	}

	clearReceipt, err := seq.SubmitTx(mustSignTx(t, key, chainID, 2, &churn, big.NewInt(0), estimate, nil))
	if err != nil {
		t.Fatalf("clearing tx funded with exactly the estimated %d gas failed: %v — "+
			"EstimateGas is under-reporting, which is how the M08 suite broke", estimate, err)
	}
	if clearReceipt.Status != types.ReceiptStatusSuccessful {
		t.Fatalf("clearing tx status = %d with the estimated %d gas, want success", clearReceipt.Status, estimate)
	}

	// Prove the test actually exercises the refund path rather than passing
	// vacuously: the receipt's GasUsed is net of the refund, so a materially
	// larger estimate is exactly the gap the old 1.1x pad could not cover.
	// (Ten cleared slots put the refund at the EIP-3529 cap, so the ratio
	// should sit near 1.25.)
	ratio := float64(estimate) / float64(clearReceipt.GasUsed)
	t.Logf("estimate=%d, receipt GasUsed (net of refund)=%d, ratio=%.3f", estimate, clearReceipt.GasUsed, ratio)
	if ratio <= 1.10 {
		t.Errorf("estimate/UsedGas ratio = %.3f; the fixture is meant to earn enough refund to exceed the old 1.10 pad, "+
			"so this test would no longer catch the regression it exists for", ratio)
	}
}

// TestEstimateGasIsSufficientForContractCreation guards the other path
// ethers uses the estimate for: hardhat-deploy sends every deployment with a
// gas limit taken straight from eth_estimateGas.
func TestEstimateGasIsSufficientForContractCreation(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	from := crypto.PubkeyToAddress(key.PublicKey)
	chainID := big.NewInt(testChainID)

	initCode := buildInitCode(counterRuntime())

	estimate, err := seq.EstimateGas(CallMsg{From: from, To: nil, Data: initCode})
	if err != nil {
		t.Fatalf("EstimateGas: %v", err)
	}

	receipt, err := seq.SubmitTx(mustSignTx(t, key, chainID, 0, nil, big.NewInt(0), estimate, initCode))
	if err != nil {
		t.Fatalf("creation funded with exactly the estimated %d gas failed: %v", estimate, err)
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		t.Fatalf("creation status = %d with the estimated %d gas, want success", receipt.Status, estimate)
	}
	if receipt.ContractAddress == (common.Address{}) {
		t.Error("creation receipt carries no contract address")
	}
}

// TestEstimateGasReportsRevertsWithData confirms the search still surfaces a
// revert rather than reporting it as an allowance problem: a call that
// reverts at the ceiling can never succeed, so it must come back as a
// *RevertError carrying the revert bytes for viem/ethers to decode.
func TestEstimateGasReportsRevertsWithData(t *testing.T) {
	seq, _ := newTestSequencer(t)
	key := mustHardhatAccount0(t)
	from := crypto.PubkeyToAddress(key.PublicKey)
	chainID := big.NewInt(testChainID)

	_, reverter := deploy(t, seq, key, chainID, 0, revertRuntime())

	_, err := seq.EstimateGas(CallMsg{From: from, To: &reverter})
	if err == nil {
		t.Fatal("EstimateGas on a reverting call returned no error")
	}

	revertErr, ok := err.(*RevertError)
	if !ok {
		t.Fatalf("EstimateGas error is %T (%v), want *RevertError", err, err)
	}
	// revertRuntime reverts with exactly the 4-byte selector 0xdeadbeef.
	if want := []byte{0xde, 0xad, 0xbe, 0xef}; !bytes.Equal(revertErr.Data, want) {
		t.Errorf("revert data = %#x, want %#x", revertErr.Data, want)
	}
}
