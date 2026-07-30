package chain

import (
	"errors"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core"
	"github.com/ethereum/go-ethereum/core/rawdb"
	gethstate "github.com/ethereum/go-ethereum/core/state"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/core/vm"
	"github.com/ethereum/go-ethereum/ethdb"
	"github.com/ethereum/go-ethereum/params"
)

// CallMsg is this package's stand-in for a read-only "message call" — the
// input to Call/EstimateGas, as opposed to a signed *types.Transaction.
// Kept as our own tiny type (rather than importing go-ethereum's root
// `ethereum.CallMsg`) so the RPC layer (M04/M05) never needs to import
// anything from geth beyond common/types either — it only talks to
// internal/chain in terms of this struct and *types.Transaction.
type CallMsg struct {
	From     common.Address
	To       *common.Address // nil means contract creation
	Gas      uint64          // 0 means "use the block gas limit" (toMessage's default)
	GasPrice *big.Int        // nil means 0 (this chain's free-gas policy)
	Value    *big.Int        // nil means 0
	Data     []byte
}

// RevertError is returned by SubmitTx/Call/EstimateGas when the EVM
// execution completed but reverted (STOP-with-failure, not a Go error from
// validation). Per MASTER §10 pitfall 1 and the M03 spec's revert policy
// (§5), the caller (M05's eth_sendRawTransaction handler) is expected to
// surface Data as the JSON-RPC error's `data` field so viem can decode
// custom Solidity errors exactly as it does against Hardhat.
type RevertError struct {
	Data []byte
}

func (e *RevertError) Error() string {
	if len(e.Data) == 0 {
		return "execution reverted"
	}
	return fmt.Sprintf("execution reverted: %#x", e.Data)
}

// toMessage builds a core.Message for a read-only call/estimate: unlike a
// submitted transaction, a CallMsg is never signed, so account checks
// (nonce, balance-covers-gas) must be skipped — this is standard eth_call/
// eth_estimateGas semantics (a caller can simulate as any `from` address
// without owning its key), not something specific to this chain.
func (m CallMsg) toMessage(fallbackGas uint64) *core.Message {
	gasPrice := m.GasPrice
	if gasPrice == nil {
		gasPrice = big.NewInt(0)
	}
	value := m.Value
	if value == nil {
		value = big.NewInt(0)
	}
	gas := m.Gas
	if gas == 0 {
		gas = fallbackGas
	}

	return &core.Message{
		From:      m.From,
		To:        m.To,
		Value:     value,
		GasLimit:  gas,
		GasPrice:  gasPrice,
		GasFeeCap: gasPrice,
		GasTipCap: gasPrice,
		Data:      m.Data,
		// core.Message.SkipAccountChecks was split into two more granular
		// fields in this go-ethereum version (verified against
		// core/state_transition.go for v1.16.8, not guessed): both are set
		// for the same reason the old single field existed — eth_call/
		// eth_estimateGas semantics let a caller simulate as any `from`
		// address without owning its key or matching its on-chain nonce.
		SkipNonceChecks:       true,
		SkipTransactionChecks: true,
	}
}

// newBlockContext builds the vm.BlockContext execution runs against.
// Coinbase is always the zero address (this chain mints nothing to a
// miner — MASTER §3's free-gas/no-consensus-reward design), BaseFee and
// Difficulty are always zero (free-gas policy; MASTER §10 pitfall 3), and
// Random is a fixed zero hash (post-merge PREVRANDAO — this chain has no
// randomness beacon, so every block reports the same fixed value; nothing
// in Voting.sol/ElectionRegistry.sol reads PREVRANDAO, so this is safe).
// GetHash reads canonical block hashes straight from rawdb so the BLOCKHASH
// opcode works without this package depending on a full blockchain/header
// cache.
func newBlockContext(db ethdb.Database, header *types.Header) vm.BlockContext {
	random := common.Hash{}
	return vm.BlockContext{
		CanTransfer: core.CanTransfer,
		Transfer:    core.Transfer,
		GetHash: func(n uint64) common.Hash {
			return rawdb.ReadCanonicalHash(db, n)
		},
		Coinbase:    common.Address{},
		GasLimit:    header.GasLimit,
		BlockNumber: new(big.Int).Set(header.Number),
		Time:        header.Time,
		Difficulty:  big.NewInt(0),
		BaseFee:     big.NewInt(0),
		Random:      &random,
	}
}

// applyMessage is the single chokepoint every execution path (SubmitTx's
// real, persisted run; Call; EstimateGas) funnels through: construct an EVM
// over statedb with header as the block context, run msg, and translate
// core's own pre-check sentinel errors (insufficient balance, intrinsic gas
// too low — raised by core.ApplyMessage's internal state-transition
// pre-check, NOT by validate.go, see validate.go's doc comment) into this
// package's typed errors.
//
// *** Version-sensitivity note (read this first if `go build` fails here) ***
// vm.NewEVM's signature and how the per-tx TxContext (Origin/GasPrice) is
// attached to an *vm.EVM changed across go-ethereum releases: older
// versions took the TxContext as a NewEVM constructor argument; this code
// assumes the newer decoupled-TxContext API (construct the EVM once from
// just the BlockContext, then evm.SetTxContext(txCtx) per message) which
// several go-ethereum 1.14+ releases use to let one EVM be reused across
// txs. If go vet/go build reports a mismatch here, check
// `github.com/ethereum/go-ethereum/core/vm.NewEVM`'s actual signature in
// $GOMODCACHE for v1.16.8 and adjust just this one function — nothing else
// in this package depends on which form it takes.
func applyMessage(evmCfg vm.Config, db ethdb.Database, chainCfg *params.ChainConfig, statedb *gethstate.StateDB, header *types.Header, msg *core.Message) (*core.ExecutionResult, error) {
	blockCtx := newBlockContext(db, header)
	evm := vm.NewEVM(blockCtx, statedb, chainCfg, evmCfg)
	evm.SetTxContext(core.NewEVMTxContext(msg))

	gp := new(core.GasPool).AddGas(header.GasLimit)
	result, err := core.ApplyMessage(evm, msg, gp)
	if err != nil {
		return nil, mapPreCheckError(err)
	}
	return result, nil
}

// mapPreCheckError translates the sentinel errors core.ApplyMessage's
// pre-check (core/state_transition.go) returns into this package's own
// typed errors, so callers (and tests) can errors.Is against ErrX without
// depending on core's exact error identity. core.ErrInsufficientFunds and
// core.ErrIntrinsicGas are long-standing exported sentinels; anything else
// is wrapped as-is (still returned as a real error, just not remapped).
func mapPreCheckError(err error) error {
	switch {
	case errors.Is(err, core.ErrInsufficientFunds):
		return fmt.Errorf("%w: %v", ErrInsufficientFunds, err)
	case errors.Is(err, core.ErrIntrinsicGas):
		return fmt.Errorf("%w: %v", ErrIntrinsicGas, err)
	case errors.Is(err, core.ErrNonceTooLow):
		return fmt.Errorf("%w: %v", ErrNonceTooLow, err)
	case errors.Is(err, core.ErrNonceTooHigh):
		return fmt.Errorf("%w: %v", ErrNonceTooHigh, err)
	default:
		return err
	}
}
