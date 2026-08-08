package rpc

import (
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

// Proposer is the write path the eth_ and dev namespaces drive.
//
// In solo mode it is *chain.Sequencer, which seals directly — one writer, no
// consensus, exactly as it has been since M03. In BFT mode
// (CONSENSUS_MODE=bft) it is *consensus.Engine, which builds a candidate
// block, runs a voting round, and commits the result through that same
// Sequencer once a quorum of validators has signed it.
//
// The two implementations must present exactly the same error surface: a
// revert is *chain.RevertError, a bad nonce is *chain.NonceError, and so on,
// so that mapSubmitError produces byte-identical JSON-RPC errors either way.
// That identity is the whole reason CONSENSUS_MODE can be a flag rather than
// a fork of this package — every method in eth_write.go and dev.go is written
// once and is unaware of which mode it is running in.
//
// Reads deliberately do not go through here. A read is answered from local
// state under any mode, and routing them through a consensus engine would
// serialise them behind block production for no benefit.
type Proposer interface {
	// SubmitTx validates, executes and commits tx in its own block, returning
	// its receipt. A transaction that reverts commits nothing and returns
	// *chain.RevertError (MASTER §10 pitfall 2).
	SubmitTx(tx *types.Transaction) (*types.Receipt, error)
	// MineEmptyBlock commits a zero-transaction block (evm_mine).
	MineEmptyBlock() (*types.Block, error)
	// MineEmptyBlockAt commits a zero-transaction block carrying exactly the
	// given timestamp (evm_mine with an argument).
	MineEmptyBlockAt(timestamp uint64) (*types.Block, error)
	// SetBalance commits a system-op block overwriting addr's balance
	// (hardhat_setBalance / anvil_setBalance).
	SetBalance(addr common.Address, balance *big.Int) (*types.Block, error)
}
