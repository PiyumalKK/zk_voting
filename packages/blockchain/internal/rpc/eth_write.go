package rpc

import (
	"context"
	"errors"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
	gethrpc "github.com/ethereum/go-ethereum/rpc"

	"zk-blockchain/internal/chain"
)

// This file implements the write half of MASTER §9's compatibility matrix
// (M05): eth_sendRawTransaction plus the transaction/receipt queries every
// writer polls afterward.
//
// It lives on its own service type rather than growing EthService (M04's
// eth_read.go), for the reason that file's doc comment already gives: the
// read methods only ever need the Sequencer's read surface, while these
// need its write path and the chain id for error text. go-ethereum's RPC
// registry merges receivers registered under the same namespace name (see
// rpc/service.go's registerName: it looks up an existing service entry and
// adds the new callbacks to it), so both types register as "eth" and their
// methods land in one flat eth_* namespace.

// EthWriteService implements the JSON-RPC "eth" namespace's write and
// transaction-query methods.
type EthWriteService struct {
	seq     *chain.Sequencer
	chainID uint64
}

// NewEthWriteService builds the write half of the eth_* method set over seq.
func NewEthWriteService(seq *chain.Sequencer, chainID uint64) *EthWriteService {
	return &EthWriteService{seq: seq, chainID: chainID}
}

func (e *EthWriteService) chainIDBig() *big.Int { return new(big.Int).SetUint64(e.chainID) }

// SendRawTransaction implements eth_sendRawTransaction.
//
// Auto-mine semantics (MASTER §3 / §10 pitfall 2) make this method do the
// whole job synchronously: the transaction is validated, executed and sealed
// into its own block before this returns. Consequently a transaction that
// *reverts* is rejected here — the caller gets the revert error (code 3 with
// the raw revert bytes in `data`, so viem decodes custom Solidity errors
// identically to Hardhat) and no block is mined. This is Hardhat's behavior,
// not a simplification: mobile and web error handling both depend on the
// revert surfacing at submission time rather than in a failed receipt.
func (e *EthWriteService) SendRawTransaction(ctx context.Context, input hexutil.Bytes) (common.Hash, error) {
	tx := new(types.Transaction)
	if err := tx.UnmarshalBinary(input); err != nil {
		// Undecodable bytes never reached the sequencer, so there is no
		// chain-level error to map — report it directly as invalid input.
		return common.Hash{}, newCodedError(invalidInputCode, "Invalid transaction: %v", err)
	}

	if _, err := e.seq.SubmitTx(tx); err != nil {
		return common.Hash{}, mapSubmitError(err, e.chainID)
	}
	return tx.Hash(), nil
}

// GetTransactionByHash implements eth_getTransactionByHash. An unknown hash
// returns a JSON null result (not an error) — the spec's shape, and what
// viem polls on. Every transaction this chain knows about is mined, so the
// block fields are always populated.
func (e *EthWriteService) GetTransactionByHash(ctx context.Context, hash common.Hash) (*RPCTransaction, error) {
	loc, err := e.seq.TransactionByHash(hash)
	if err != nil {
		if errors.Is(err, chain.ErrTxNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return newRPCTransaction(loc.Tx, loc.BlockHash, loc.BlockNumber, loc.Index, e.chainIDBig())
}

// GetTransactionReceipt implements eth_getTransactionReceipt. Same
// null-on-unknown rule as GetTransactionByHash — this one matters most:
// viem's waitForTransactionReceipt polls this method and treats a JSON-RPC
// *error* as a hard failure, so an unknown hash must be a null result
// (M05 spec deliverable 3).
func (e *EthWriteService) GetTransactionReceipt(ctx context.Context, hash common.Hash) (*RPCReceipt, error) {
	receipt, loc, err := e.seq.ReceiptByTxHash(hash)
	if err != nil {
		if errors.Is(err, chain.ErrTxNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return newRPCReceipt(receipt, loc.Tx, e.chainIDBig())
}

// GetBlockTransactionCountByNumber implements
// eth_getBlockTransactionCountByNumber. Unresolvable block → null, matching
// the eth_getBlockByNumber convention.
func (e *EthWriteService) GetBlockTransactionCountByNumber(ctx context.Context, blockNumber gethrpc.BlockNumber) (*hexutil.Uint, error) {
	n, err := e.seq.BlockTransactionCountByTag(blockNumber)
	if err != nil {
		if errors.Is(err, chain.ErrBlockNotFound) {
			return nil, nil
		}
		return nil, err
	}
	count := hexutil.Uint(n)
	return &count, nil
}

// GetBlockTransactionCountByHash implements
// eth_getBlockTransactionCountByHash.
func (e *EthWriteService) GetBlockTransactionCountByHash(ctx context.Context, hash common.Hash) (*hexutil.Uint, error) {
	n, err := e.seq.BlockTransactionCountByHash(hash)
	if err != nil {
		if errors.Is(err, chain.ErrBlockNotFound) {
			return nil, nil
		}
		return nil, err
	}
	count := hexutil.Uint(n)
	return &count, nil
}
