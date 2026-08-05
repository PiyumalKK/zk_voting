package chain

import (
	"errors"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/rawdb"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	gethrpc "github.com/ethereum/go-ethereum/rpc"
)

// This file adds the mined-transaction lookups M05's write-path RPC methods
// (eth_getTransactionByHash / eth_getTransactionReceipt /
// eth_getBlockTransactionCountBy*) need. Like read.go's accessors these take
// no lock and never touch the head: finalizeBlock (seal.go) already wrote
// the tx-lookup index and the receipts, so everything here is a pure read of
// what M03 persisted.
//
// Receipts are deliberately read with rawdb.ReadRawReceipts (the *stored*
// form: status, cumulative gas, and each log's address/topics/data) and then
// completed by deriveReceiptFields below, rather than with rawdb.ReadReceipts
// (which calls types.Receipts.DeriveFields internally). Two reasons:
//
//  1. ReadRawReceipts's signature (db, blockHash, number) has been stable
//     across go-ethereum releases, whereas ReadReceipts/DeriveFields have
//     repeatedly gained parameters (block time for Cancun blob pricing, blob
//     gas price, …). This package pins v1.16.8 but is written to survive a
//     bump.
//  2. Derivation here can use this chain's own invariants — free gas means
//     effectiveGasPrice is always 0, and blocks hold at most one tx — instead
//     of geth's general-purpose fee arithmetic, which would have to be fed a
//     base fee and blob gas price that are meaningless on this chain.
//
// The fields derived below are exactly the ones EIP-658 leaves out of the
// receipt trie's RLP encoding, so recomputing them cannot change a block's
// ReceiptHash (same reasoning as finalizeBlock's back-fill of BlockHash).

// ErrTxNotFound means no mined transaction with the requested hash exists on
// this chain. M05's eth_getTransactionByHash/eth_getTransactionReceipt use
// this (via errors.Is) to return a JSON null result rather than an error —
// viem's waitForTransactionReceipt polls on exactly that null.
var ErrTxNotFound = errors.New("transaction not found")

// TxLocation identifies where a mined transaction lives. Every transaction
// this chain knows about is mined (no mempool, auto-mine — MASTER §3), so
// there is no "pending, location unknown" case to represent.
type TxLocation struct {
	Tx          *types.Transaction
	BlockHash   common.Hash
	BlockNumber uint64
	Index       uint64
}

// TransactionByHash resolves hash through the tx-lookup index finalizeBlock
// wrote (rawdb.WriteTxLookupEntriesByBlock), returning the transaction and
// where it was mined.
//
// This is spelled out over the index primitive rather than calling a
// composite `rawdb.ReadTransaction` helper because go-ethereum removed that
// helper: resolving a hash all the way to a transaction requires knowing
// which chain is canonical, which the rawdb layer deliberately stopped
// assuming. The three calls below are the same steps that helper used to
// perform internally, and each is already proven against this exact
// go-ethereum version elsewhere in the package (ReadCanonicalHash and
// ReadBlock in read.go, the matching WriteTxLookupEntriesByBlock in
// seal.go) — the same "prefer stable primitives over composite helpers"
// reasoning this file's header comment gives for ReadRawReceipts.
//
// The three failure modes are deliberately distinguished. A missing index
// entry is an ordinary "unknown hash" (ErrTxNotFound → JSON null, which is
// what viem's waitForTransactionReceipt polls on). A hash that *is* indexed
// but whose block or body cannot be read is database corruption and is
// reported as a real error, never as null.
func (s *Sequencer) TransactionByHash(hash common.Hash) (*TxLocation, error) {
	number := rawdb.ReadTxLookupEntry(s.db, hash)
	if number == nil {
		return nil, fmt.Errorf("%w: %s", ErrTxNotFound, hash)
	}

	blockHash := rawdb.ReadCanonicalHash(s.db, *number)
	if blockHash == (common.Hash{}) {
		return nil, fmt.Errorf("tx %s is indexed at block %d, which has no canonical hash", hash, *number)
	}

	block := rawdb.ReadBlock(s.db, blockHash, *number)
	if block == nil {
		return nil, fmt.Errorf("tx %s is indexed at block %d (%s), whose block could not be read", hash, *number, blockHash)
	}

	// Single-tx blocks make this loop trivially short (MASTER §3), but it is
	// written as a scan rather than assuming index 0 so that system-op and
	// empty blocks — which carry no transactions at all (M07) — and any
	// future multi-tx block cannot silently return the wrong transaction.
	for i, tx := range block.Transactions() {
		if tx.Hash() == hash {
			return &TxLocation{Tx: tx, BlockHash: blockHash, BlockNumber: *number, Index: uint64(i)}, nil
		}
	}
	return nil, fmt.Errorf("tx %s is indexed at block %d (%s) but is not present in that block's body",
		hash, *number, blockHash)
}

// ReceiptByTxHash returns the fully-derived receipt for the mined
// transaction hash, together with its location. Returns ErrTxNotFound if the
// hash is unknown, or a plain error if the tx is indexed but its block's
// receipts are missing — that second case is real corruption, not a
// "not found", and must not be reported to a caller as JSON null.
func (s *Sequencer) ReceiptByTxHash(hash common.Hash) (*types.Receipt, *TxLocation, error) {
	loc, err := s.TransactionByHash(hash)
	if err != nil {
		return nil, nil, err
	}

	block, err := s.BlockByHash(loc.BlockHash)
	if err != nil {
		return nil, nil, fmt.Errorf("block %s for tx %s: %w", loc.BlockHash, hash, err)
	}

	receipts := rawdb.ReadRawReceipts(s.db, loc.BlockHash, loc.BlockNumber)
	if uint64(len(receipts)) <= loc.Index {
		return nil, nil, fmt.Errorf("receipts for block %s hold %d entries, want index %d (tx %s)",
			loc.BlockHash, len(receipts), loc.Index, hash)
	}

	if err := s.deriveReceiptFields(receipts, block); err != nil {
		return nil, nil, err
	}
	return receipts[loc.Index], loc, nil
}

// deriveReceiptFields fills in every receipt field that is not part of the
// stored (EIP-658) encoding: per-tx identity and gas, the deployed contract
// address for creations, block coordinates, the receipt's own bloom, and
// each log's block/tx/index annotations. receipts and block.Transactions()
// must be the same length — they always are, since finalizeBlock writes them
// as a pair.
func (s *Sequencer) deriveReceiptFields(receipts types.Receipts, block *types.Block) error {
	txs := block.Transactions()
	if len(receipts) != len(txs) {
		return fmt.Errorf("block %s has %d transactions but %d receipts", block.Hash(), len(txs), len(receipts))
	}

	blockHash := block.Hash()
	blockNumber := block.NumberU64()

	logIndex := uint(0)
	cumulativeBefore := uint64(0)

	for i, receipt := range receipts {
		tx := txs[i]

		receipt.TxHash = tx.Hash()
		receipt.Type = tx.Type()
		receipt.GasUsed = receipt.CumulativeGasUsed - cumulativeBefore
		cumulativeBefore = receipt.CumulativeGasUsed

		// Free-gas policy: base fee is 0 in every header this chain seals
		// and every tx is accepted at gasPrice 0, so the effective price a
		// receipt reports is unconditionally 0 (MASTER §3 / §10 pitfall 3).
		// Reported as its own big.Int per receipt rather than a shared
		// package-level zero, so a caller mutating one receipt can't affect
		// another.
		receipt.EffectiveGasPrice = big.NewInt(0)

		if tx.To() == nil {
			from, err := sender(s.chainCfg.ChainID, tx)
			if err != nil {
				return fmt.Errorf("recover sender of creation tx %s: %w", tx.Hash(), err)
			}
			receipt.ContractAddress = crypto.CreateAddress(from, tx.Nonce())
		} else {
			receipt.ContractAddress = common.Address{}
		}

		receipt.BlockHash = blockHash
		receipt.BlockNumber = new(big.Int).SetUint64(blockNumber)
		receipt.TransactionIndex = uint(i)

		for _, l := range receipt.Logs {
			l.BlockHash = blockHash
			l.BlockNumber = blockNumber
			l.TxHash = receipt.TxHash
			l.TxIndex = uint(i)
			// Index is the log's position within the whole *block*, not
			// within its transaction — hence the counter running across the
			// outer loop rather than resetting per receipt.
			l.Index = logIndex
			logIndex++
		}

		receipt.Bloom = types.CreateBloom(receipt)
	}
	return nil
}

// BlockTransactionCountByTag returns how many transactions the block bn
// resolves to contains (eth_getBlockTransactionCountByNumber).
func (s *Sequencer) BlockTransactionCountByTag(bn gethrpc.BlockNumber) (int, error) {
	block, err := s.BlockByTag(bn)
	if err != nil {
		return 0, err
	}
	return len(block.Transactions()), nil
}

// BlockTransactionCountByHash returns how many transactions the block with
// the given hash contains (eth_getBlockTransactionCountByHash).
func (s *Sequencer) BlockTransactionCountByHash(hash common.Hash) (int, error) {
	block, err := s.BlockByHash(hash)
	if err != nil {
		return 0, err
	}
	return len(block.Transactions()), nil
}
