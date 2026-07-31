package rpc

import (
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
)

// This file hand-rolls the standard Ethereum JSON-RPC block/transaction
// object shapes (M04 deliverable 3). go-ethereum's own marshaling for these
// lives in internal/ethapi, which — being under an `internal/` path — is
// not importable outside the go-ethereum module itself (Go's internal-
// package visibility rule), so this package builds its own equivalent
// instead of vendoring or reimplementing that package wholesale. Every
// field below was chosen to match a real `eth_getBlockByNumber`/
// `eth_getTransactionByHash` response (MASTER §10 pitfall 5); the
// differential harness (e2e/diff) is what actually proves the shape
// matches Hardhat byte-for-byte, not this file's comments — treat any
// mismatch make diff reports as more authoritative than the assumptions
// documented here.
//
// hexutil.Big/hexutil.Uint64/hexutil.Bytes marshal to the spec's required
// "0x…", no-leading-zeros hex quantity encoding; common.Hash/common.Address
// marshal to lowercase, fixed-width hex — all four are go-ethereum's own
// public types, so no hand-written hex encoding logic lives in this file.

// RPCBlock is the JSON shape returned by eth_getBlockByNumber/ByHash.
// Withdrawals/blob/beacon-root fields are always populated (not
// conditionally omitted): this chain activates Shanghai/Cancun/Prague from
// genesis (internal/state.ChainConfig, MASTER §2/§3), and internal/chain's
// buildHeader (M03) always sets the corresponding header fields
// unconditionally for the same reason — mirroring that here rather than
// guessing at fork-conditional omission keeps this file and buildHeader in
// lockstep.
type RPCBlock struct {
	Number           *hexutil.Big     `json:"number"`
	Hash             common.Hash      `json:"hash"`
	ParentHash       common.Hash      `json:"parentHash"`
	Nonce            types.BlockNonce `json:"nonce"`
	MixHash          common.Hash      `json:"mixHash"`
	Sha3Uncles       common.Hash      `json:"sha3Uncles"`
	LogsBloom        types.Bloom      `json:"logsBloom"`
	StateRoot        common.Hash      `json:"stateRoot"`
	Miner            common.Address   `json:"miner"`
	Difficulty       *hexutil.Big     `json:"difficulty"`
	TotalDifficulty  *hexutil.Big     `json:"totalDifficulty"`
	ExtraData        hexutil.Bytes    `json:"extraData"`
	Size             hexutil.Uint64   `json:"size"`
	GasLimit         hexutil.Uint64   `json:"gasLimit"`
	GasUsed          hexutil.Uint64   `json:"gasUsed"`
	Timestamp        hexutil.Uint64   `json:"timestamp"`
	TransactionsRoot common.Hash      `json:"transactionsRoot"`
	ReceiptsRoot     common.Hash      `json:"receiptsRoot"`
	// Transactions holds either common.Hash (fullTx=false) or
	// *RPCTransaction (fullTx=true) elements — the RPC spec's two response
	// shapes for the same field, distinguished only by the request's fullTx
	// flag, so a fixed Go type can't express it without an interface slice.
	Transactions  []any         `json:"transactions"`
	Uncles        []common.Hash `json:"uncles"`
	BaseFeePerGas *hexutil.Big  `json:"baseFeePerGas"`

	WithdrawalsRoot       common.Hash         `json:"withdrawalsRoot"`
	Withdrawals           []*types.Withdrawal `json:"withdrawals"`
	BlobGasUsed           hexutil.Uint64      `json:"blobGasUsed"`
	ExcessBlobGas         hexutil.Uint64      `json:"excessBlobGas"`
	ParentBeaconBlockRoot common.Hash         `json:"parentBeaconBlockRoot"`
	// RequestsHash (EIP-7685, Prague) is this struct's least-certain field:
	// buildHeader (internal/chain/seal.go) always populates it since this
	// chain activates Prague from genesis, but whether the Hardhat version
	// this repo pins also reports it in eth_getBlockByNumber (and under
	// this exact field name) is unverified — confirm via `make diff` and
	// delete this field if Hardhat's response never has it.
	RequestsHash common.Hash `json:"requestsHash"`
}

// RPCTransaction is the JSON shape returned by eth_getTransactionByHash and
// embedded in RPCBlock.Transactions when fullTx=true. Legacy, EIP-2930
// (access-list) and EIP-1559 (dynamic-fee) transactions are all
// distinguished by Type; MaxFeePerGas/MaxPriorityFeePerGas/AccessList are
// only meaningful (and only populated) for the tx types that carry them —
// mobile sends legacy (MASTER §10 pitfall 3), hardhat-deploy may send 1559.
type RPCTransaction struct {
	BlockHash        *common.Hash      `json:"blockHash"`
	BlockNumber      *hexutil.Big      `json:"blockNumber"`
	From             common.Address    `json:"from"`
	Gas              hexutil.Uint64    `json:"gas"`
	GasPrice         *hexutil.Big      `json:"gasPrice"`
	GasFeeCap        *hexutil.Big      `json:"maxFeePerGas,omitempty"`
	GasTipCap        *hexutil.Big      `json:"maxPriorityFeePerGas,omitempty"`
	Hash             common.Hash       `json:"hash"`
	Input            hexutil.Bytes     `json:"input"`
	Nonce            hexutil.Uint64    `json:"nonce"`
	To               *common.Address   `json:"to"`
	TransactionIndex *hexutil.Uint64   `json:"transactionIndex"`
	Value            *hexutil.Big      `json:"value"`
	Type             hexutil.Uint64    `json:"type"`
	AccessList       *types.AccessList `json:"accessList,omitempty"`
	ChainID          *hexutil.Big      `json:"chainId,omitempty"`
	V                *hexutil.Big      `json:"v"`
	R                *hexutil.Big      `json:"r"`
	S                *hexutil.Big      `json:"s"`
}

// newRPCTransaction builds an RPCTransaction from a mined tx. blockHash/
// blockNumber/index describe where it was mined — every tx this chain ever
// returns is mined (no mempool, auto-mine; MASTER §3), so these are never
// the "pending tx" nil-block-fields case the general Ethereum RPC spec also
// allows for.
func newRPCTransaction(tx *types.Transaction, blockHash common.Hash, blockNumber, index uint64, chainID *big.Int) (*RPCTransaction, error) {
	signer := types.LatestSignerForChainID(chainID)
	from, err := types.Sender(signer, tx)
	if err != nil {
		return nil, err
	}

	v, r, s := tx.RawSignatureValues()

	rt := &RPCTransaction{
		BlockHash:        &blockHash,
		BlockNumber:      (*hexutil.Big)(new(big.Int).SetUint64(blockNumber)),
		From:             from,
		Gas:              hexutil.Uint64(tx.Gas()),
		GasPrice:         (*hexutil.Big)(tx.GasPrice()),
		Hash:             tx.Hash(),
		Input:            hexutil.Bytes(tx.Data()),
		Nonce:            hexutil.Uint64(tx.Nonce()),
		To:               tx.To(),
		TransactionIndex: uint64Ptr(index),
		Value:            (*hexutil.Big)(tx.Value()),
		Type:             hexutil.Uint64(tx.Type()),
		V:                (*hexutil.Big)(v),
		R:                (*hexutil.Big)(r),
		S:                (*hexutil.Big)(s),
	}

	if tx.Type() != types.LegacyTxType {
		al := tx.AccessList()
		rt.AccessList = &al
		rt.ChainID = (*hexutil.Big)(tx.ChainId())
	}
	if tx.Type() >= types.DynamicFeeTxType {
		rt.GasFeeCap = (*hexutil.Big)(tx.GasFeeCap())
		rt.GasTipCap = (*hexutil.Big)(tx.GasTipCap())
	}
	// Legacy txs signed by this chain's signer (types.LatestSignerForChainID)
	// are always EIP-155 replay-protected, so tx.ChainId() (derived from V)
	// is meaningful for them too — included for the same reason typed txs
	// get it, just outside the "!= LegacyTxType" branch above since legacy
	// still benefits from reporting it.
	if tx.Type() == types.LegacyTxType && rt.ChainID == nil {
		if cid := tx.ChainId(); cid != nil && cid.Sign() > 0 {
			rt.ChainID = (*hexutil.Big)(cid)
		}
	}

	return rt, nil
}

func uint64Ptr(v uint64) *hexutil.Uint64 {
	h := hexutil.Uint64(v)
	return &h
}

// newRPCBlock builds an RPCBlock from block. fullTx selects whether
// Transactions holds hashes or full RPCTransaction objects
// (eth_getBlockByNumber/ByHash's `fullTx` argument). chainID is needed to
// recover each tx's `from` when fullTx is true.
// *** If `go build` fails on header.Extra: *** every other types.Header
// field this function reads (MixDigest, Nonce, WithdrawalsHash,
// ParentBeaconRoot, ExcessBlobGas, BlobGasUsed, RequestsHash, …) is already
// proven to compile — internal/chain/seal.go's buildHeader (M03) uses the
// exact same field names. header.Extra ("extraData" in JSON) is the one
// field this file reads that seal.go never touches (buildHeader never sets
// it, leaving it nil for every sealed block), so it's this function's
// least-verified identifier; check core/types.Header in $GOMODCACHE for
// v1.16.8 if this line doesn't compile.
func newRPCBlock(block *types.Block, fullTx bool, chainID *big.Int) (*RPCBlock, error) {
	header := block.Header()
	hash := block.Hash()

	txs := block.Transactions()
	out := make([]any, len(txs))
	for i, tx := range txs {
		if !fullTx {
			out[i] = tx.Hash()
			continue
		}
		rt, err := newRPCTransaction(tx, hash, block.NumberU64(), uint64(i), chainID)
		if err != nil {
			return nil, err
		}
		out[i] = rt
	}

	withdrawalsRoot := common.Hash{}
	if header.WithdrawalsHash != nil {
		withdrawalsRoot = *header.WithdrawalsHash
	}
	withdrawals := block.Withdrawals()
	if withdrawals == nil {
		withdrawals = []*types.Withdrawal{}
	}
	blobGasUsed := uint64(0)
	if header.BlobGasUsed != nil {
		blobGasUsed = *header.BlobGasUsed
	}
	excessBlobGas := uint64(0)
	if header.ExcessBlobGas != nil {
		excessBlobGas = *header.ExcessBlobGas
	}
	parentBeaconRoot := common.Hash{}
	if header.ParentBeaconRoot != nil {
		parentBeaconRoot = *header.ParentBeaconRoot
	}
	requestsHash := common.Hash{}
	if header.RequestsHash != nil {
		requestsHash = *header.RequestsHash
	}

	return &RPCBlock{
		Number:           (*hexutil.Big)(header.Number),
		Hash:             hash,
		ParentHash:       header.ParentHash,
		Nonce:            header.Nonce,
		MixHash:          header.MixDigest,
		Sha3Uncles:       header.UncleHash,
		LogsBloom:        header.Bloom,
		StateRoot:        header.Root,
		Miner:            header.Coinbase,
		Difficulty:       (*hexutil.Big)(big.NewInt(0)),
		TotalDifficulty:  (*hexutil.Big)(big.NewInt(0)),
		ExtraData:        hexutil.Bytes(header.Extra),
		Size:             hexutil.Uint64(uint64(block.Size())),
		GasLimit:         hexutil.Uint64(header.GasLimit),
		GasUsed:          hexutil.Uint64(header.GasUsed),
		Timestamp:        hexutil.Uint64(header.Time),
		TransactionsRoot: header.TxHash,
		ReceiptsRoot:     header.ReceiptHash,
		Transactions:     out,
		Uncles:           []common.Hash{},
		BaseFeePerGas:    (*hexutil.Big)(big.NewInt(0)),

		WithdrawalsRoot:       withdrawalsRoot,
		Withdrawals:           withdrawals,
		BlobGasUsed:           hexutil.Uint64(blobGasUsed),
		ExcessBlobGas:         hexutil.Uint64(excessBlobGas),
		ParentBeaconBlockRoot: parentBeaconRoot,
		RequestsHash:          requestsHash,
	}, nil
}
