package chain

import (
	"errors"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	gethstate "github.com/ethereum/go-ethereum/core/state"
	"github.com/ethereum/go-ethereum/core/types"
)

// Sentinel errors for the fast-fail checks validateTx performs before a tx
// ever reaches the EVM. Each is joined with a human-readable detail via
// fmt.Errorf("%w: ...", ErrX, ...) so callers can both errors.Is-match on
// the sentinel and log/return the full message. M05 maps these to the exact
// Hardhat JSON-RPC error text (MASTER §10 pitfall 1) via differential
// testing against a real `hardhat node` — that mapping is out of scope
// here; validateTx only needs to distinguish failure *kinds* reliably.
var (
	// ErrWrongChainID means signature recovery failed against this chain's
	// signer — either the tx was signed for a different chain id, or the
	// signature itself is malformed.
	ErrWrongChainID = errors.New("wrong chain id or invalid signature")
	// ErrNonceTooLow means tx.Nonce() < the sender's current account nonce.
	ErrNonceTooLow = errors.New("nonce too low")
	// ErrNonceTooHigh means tx.Nonce() > the sender's current account nonce
	// — there is no mempool to hold it for later, so out-of-order
	// submission is rejected outright (MASTER §3: "auto-mine, no mempool").
	ErrNonceTooHigh = errors.New("nonce too high")
	// ErrGasLimitExceeded means tx.Gas() exceeds the block gas limit — a
	// tx this large could never fit in any block this chain produces
	// (single-tx blocks, MASTER §2: BLOCK_GAS_LIMIT must stay > 15,000,000
	// so the mobile app's fixed vote-tx gas limit always fits).
	ErrGasLimitExceeded = errors.New("gas limit exceeds block gas limit")
	// ErrInsufficientFunds mirrors core.ErrInsufficientFunds (M03 spec
	// note: "Free gas: when gasPrice == 0 skip fee deduction entirely" —
	// this only bites value transfers or non-zero-gasPrice txs from an
	// underfunded account).
	ErrInsufficientFunds = errors.New("insufficient funds for gas * price + value")
	// ErrIntrinsicGas means tx.Gas() is below the minimum gas the tx would
	// need just to be included (21000 base + calldata + access list +
	// contract-creation costs), before any EVM opcode runs.
	ErrIntrinsicGas = errors.New("intrinsic gas too low")
)

// sender recovers the tx's signer using the signer that accepts every tx
// type this chain's ChainConfig activates (legacy/EIP-1559/EIP-2930 at
// minimum; MASTER §10 pitfall 3 — mobile sends legacy txs and must keep
// working). A recovery failure is reported as ErrWrongChainID: in practice
// the overwhelmingly common cause is a tx signed against a different chain
// id (viem/ethers embed the configured chain id in the signature per
// EIP-155), which is exactly the case MASTER §10 wants surfaced clearly.
func sender(chainID *big.Int, tx *types.Transaction) (common.Address, error) {
	signer := types.LatestSignerForChainID(chainID)
	from, err := types.Sender(signer, tx)
	if err != nil {
		return common.Address{}, fmt.Errorf("%w: %v", ErrWrongChainID, err)
	}
	return from, nil
}

// validateTx runs every stateless + stateful check MASTER §10 and the M03
// spec require before a tx is allowed anywhere near the EVM: signature/
// chain-id recovery, nonce match, and the block gas cap. It deliberately
// does NOT duplicate the balance/intrinsic-gas checks core.ApplyMessage's
// own pre-check (core.NewStateTransition(...).TransitionDb) already
// performs — execute.go's applyTx maps those returned errors onto
// ErrInsufficientFunds / ErrIntrinsicGas instead, so there is exactly one
// place in this codebase that encodes geth's own fee/gas arithmetic instead
// of two copies that could drift apart.
//
// Returns the recovered sender on success, since every caller needs it
// again immediately afterward (execute.go's message construction).
func validateTx(tx *types.Transaction, chainID *big.Int, statedb *gethstate.StateDB, blockGasLimit uint64) (common.Address, error) {
	from, err := sender(chainID, tx)
	if err != nil {
		return common.Address{}, err
	}

	if tx.Gas() > blockGasLimit {
		return from, fmt.Errorf("%w: tx gas %d > block gas limit %d", ErrGasLimitExceeded, tx.Gas(), blockGasLimit)
	}

	stateNonce := statedb.GetNonce(from)
	switch {
	case tx.Nonce() < stateNonce:
		return from, fmt.Errorf("%w: tx nonce %d, account nonce %d", ErrNonceTooLow, tx.Nonce(), stateNonce)
	case tx.Nonce() > stateNonce:
		return from, fmt.Errorf("%w: tx nonce %d, account nonce %d", ErrNonceTooHigh, tx.Nonce(), stateNonce)
	}

	return from, nil
}
