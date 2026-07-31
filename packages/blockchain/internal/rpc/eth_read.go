package rpc

import (
	"context"
	"errors"
	"math/big"
	"strconv"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	gethrpc "github.com/ethereum/go-ethereum/rpc"

	"zk-blockchain/internal/chain"
)

// This file implements the read half of MASTER §9's JSON-RPC compatibility
// matrix (M04). Every exported method on EthService/NetService/Web3Service
// becomes a JSON-RPC method once registered with a *gethrpc.Server
// (server.go does the registering): geth's reflection-based dispatcher
// lower-cases each Go method's first letter and prefixes it with the
// namespace given to RegisterName, e.g. EthService.GetBalance ->
// "eth_getBalance". Parameter types that implement json.Unmarshaler (every
// gethrpc/hexutil/common type used below does) are decoded straight off the
// JSON-RPC params array; a *T parameter is optional (nil if the caller
// didn't supply enough array elements), a bare T is required.

// EthService implements the JSON-RPC "eth" namespace's read methods.
// M05 adds SendRawTransaction/GetTransactionByHash/GetTransactionReceipt
// to this same namespace (registered on the same *gethrpc.Server, in a
// separate file per M05's own milestone) — kept as a second Go type there
// rather than growing this one, since M05 needs write access the
// Sequencer's read methods don't require.
type EthService struct {
	seq     *chain.Sequencer
	chainID *big.Int
}

// NewEthService builds the eth_* method set over seq for chain chainID.
func NewEthService(seq *chain.Sequencer, chainID uint64) *EthService {
	return &EthService{seq: seq, chainID: new(big.Int).SetUint64(chainID)}
}

// ChainId implements eth_chainId. Named "ChainId" (not the Go-idiomatic
// "ChainID") deliberately: geth's rpc server derives the JSON-RPC method
// name by lower-casing only this method's first rune, leaving the rest
// verbatim — so "ChainID" would register as "eth_chainID" (wrong: capital
// ID), while "ChainId" correctly becomes "eth_chainId".
func (e *EthService) ChainId() hexutil.Uint64 {
	return hexutil.Uint64(e.chainID.Uint64())
}

// BlockNumber implements eth_blockNumber.
func (e *EthService) BlockNumber() (hexutil.Uint64, error) {
	n, err := e.seq.BlockNumber()
	if err != nil {
		return 0, err
	}
	return hexutil.Uint64(n), nil
}

// Syncing implements eth_syncing. This chain has no sync process to report
// (single sequencer, replicas re-execute rather than "sync" in the P2P
// sense — MASTER §3) — always false, matching a fully-synced Hardhat node.
func (e *EthService) Syncing() (bool, error) { return false, nil }

// Accounts implements eth_accounts. This node holds no private keys of its
// own (voters/admin/GN key custody is entirely client-side or in
// nextjs — see 01-AUTH-DESIGN.md), so this is always empty, matching
// Hardhat's behavior for a node not managing local accounts.
func (e *EthService) Accounts() []common.Address { return []common.Address{} }

// GetBalance implements eth_getBalance.
func (e *EthService) GetBalance(ctx context.Context, address common.Address, blockNumber *gethrpc.BlockNumber) (*hexutil.Big, error) {
	bal, err := e.seq.Balance(address, resolveBlockNumber(blockNumber))
	if err != nil {
		return nil, err
	}
	return (*hexutil.Big)(bal), nil
}

// GetCode implements eth_getCode.
func (e *EthService) GetCode(ctx context.Context, address common.Address, blockNumber *gethrpc.BlockNumber) (hexutil.Bytes, error) {
	code, err := e.seq.Code(address, resolveBlockNumber(blockNumber))
	if err != nil {
		return nil, err
	}
	return hexutil.Bytes(code), nil
}

// GetStorageAt implements eth_getStorageAt. position is a variable-length
// hex quantity (callers commonly send "0x0", not a zero-padded 32-byte
// value), so it is decoded as hexutil.Big and left-padded to a 32-byte
// storage key via common.BigToHash — common.Hash's own JSON decoding
// requires an already-fixed-width value and would reject a short "0x0".
func (e *EthService) GetStorageAt(ctx context.Context, address common.Address, position hexutil.Big, blockNumber *gethrpc.BlockNumber) (common.Hash, error) {
	slot := common.BigToHash(position.ToInt())
	return e.seq.StorageAt(address, slot, resolveBlockNumber(blockNumber))
}

// GetTransactionCount implements eth_getTransactionCount. "pending" isn't a
// distinct state on this chain (no mempool, auto-mine) — headerForBlockNumber
// (internal/chain) already maps pending/safe/finalized to latest (MASTER
// §10 pitfall 4), so no special-casing is needed here.
func (e *EthService) GetTransactionCount(ctx context.Context, address common.Address, blockNumber *gethrpc.BlockNumber) (hexutil.Uint64, error) {
	nonce, err := e.seq.Nonce(address, resolveBlockNumber(blockNumber))
	if err != nil {
		return 0, err
	}
	return hexutil.Uint64(nonce), nil
}

// GetBlockByNumber implements eth_getBlockByNumber. Per the JSON-RPC spec,
// an unresolvable block returns a null result, not an error.
func (e *EthService) GetBlockByNumber(ctx context.Context, blockNumber gethrpc.BlockNumber, fullTx bool) (*RPCBlock, error) {
	block, err := e.seq.BlockByTag(blockNumber)
	if err != nil {
		if errors.Is(err, chain.ErrBlockNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return newRPCBlock(block, fullTx, e.chainID)
}

// GetBlockByHash implements eth_getBlockByHash. Same null-on-not-found rule
// as GetBlockByNumber.
func (e *EthService) GetBlockByHash(ctx context.Context, hash common.Hash, fullTx bool) (*RPCBlock, error) {
	block, err := e.seq.BlockByHash(hash)
	if err != nil {
		if errors.Is(err, chain.ErrBlockNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return newRPCBlock(block, fullTx, e.chainID)
}

// CallArgs is the standard eth_call/eth_estimateGas transaction-call
// object. Both "data" and "input" are accepted for the calldata field (the
// JSON-RPC spec renamed data->input; real-world callers still send either),
// preferring Input when both are present, matching geth's own behavior.
type CallArgs struct {
	From     *common.Address `json:"from"`
	To       *common.Address `json:"to"`
	Gas      *hexutil.Uint64 `json:"gas"`
	GasPrice *hexutil.Big    `json:"gasPrice"`
	Value    *hexutil.Big    `json:"value"`
	Data     *hexutil.Bytes  `json:"data"`
	Input    *hexutil.Bytes  `json:"input"`
}

func (a CallArgs) toCallMsg() chain.CallMsg {
	msg := chain.CallMsg{To: a.To}
	if a.From != nil {
		msg.From = *a.From
	}
	if a.Gas != nil {
		msg.Gas = uint64(*a.Gas)
	}
	if a.GasPrice != nil {
		msg.GasPrice = a.GasPrice.ToInt()
	}
	if a.Value != nil {
		msg.Value = a.Value.ToInt()
	}
	switch {
	case a.Input != nil:
		msg.Data = []byte(*a.Input)
	case a.Data != nil:
		msg.Data = []byte(*a.Data)
	}
	return msg
}

// Call implements eth_call.
func (e *EthService) Call(ctx context.Context, args CallArgs, blockNumber *gethrpc.BlockNumber) (hexutil.Bytes, error) {
	ret, err := e.seq.Call(args.toCallMsg(), resolveBlockNumber(blockNumber))
	if err != nil {
		return nil, mapCallError(err)
	}
	return hexutil.Bytes(ret), nil
}

// EstimateGas implements eth_estimateGas. The optional trailing block
// number is accepted (some callers always send it) but ignored:
// Sequencer.EstimateGas (M03) always estimates against the current head —
// nothing in this app needs a historical estimate (MASTER §2: the mobile
// app submits vote() with a fixed 15,000,000 gas limit regardless of what
// this returns).
func (e *EthService) EstimateGas(ctx context.Context, args CallArgs, blockNumber *gethrpc.BlockNumber) (hexutil.Uint64, error) {
	gas, err := e.seq.EstimateGas(args.toCallMsg())
	if err != nil {
		return 0, mapCallError(err)
	}
	return hexutil.Uint64(gas), nil
}

// GasPrice implements eth_gasPrice. Always 0x0 — free-gas policy (MASTER §3/§10 pitfall 3).
func (e *EthService) GasPrice() *hexutil.Big { return (*hexutil.Big)(big.NewInt(0)) }

// MaxPriorityFeePerGas implements eth_maxPriorityFeePerGas. Always 0x0, same reason as GasPrice.
func (e *EthService) MaxPriorityFeePerGas() *hexutil.Big { return (*hexutil.Big)(big.NewInt(0)) }

// FeeHistoryResult is eth_feeHistory's response shape.
type FeeHistoryResult struct {
	OldestBlock   *hexutil.Big     `json:"oldestBlock"`
	BaseFeePerGas []*hexutil.Big   `json:"baseFeePerGas"`
	GasUsedRatio  []float64        `json:"gasUsedRatio"`
	Reward        [][]*hexutil.Big `json:"reward,omitempty"`
}

// maxFeeHistoryBlocks bounds blockCount defensively; generous for this
// chain's scale (a full permissioned election's lifetime is nowhere near
// this many blocks) and mirrors geth's own sanity cap on the same RPC
// method.
const maxFeeHistoryBlocks = 1024

// FeeHistory implements eth_feeHistory. Every value is zero (free-gas
// policy — MASTER M04 deliverable 2) but the array *shapes* (oldestBlock,
// length of baseFeePerGas/gasUsedRatio/reward) follow the real spec, since
// viem/ethers fee logic reads those lengths, not just the values.
func (e *EthService) FeeHistory(ctx context.Context, blockCount hexutil.Uint64, newestBlock gethrpc.BlockNumber, rewardPercentiles []float64) (*FeeHistoryResult, error) {
	count := uint64(blockCount)
	if count == 0 {
		count = 1
	}
	if count > maxFeeHistoryBlocks {
		count = maxFeeHistoryBlocks
	}

	// newestBlock is a required parameter (not a pointer), so it's already
	// a concrete tag/number — no resolveBlockNumber default-to-latest step
	// needed here, unlike the optional block-tag params elsewhere in this
	// file.
	header, err := e.seq.HeaderForBlockTag(newestBlock)
	if err != nil {
		return nil, err
	}
	newest := header.Number.Uint64()

	oldest := uint64(0)
	if newest+1 > count {
		oldest = newest + 1 - count
	}

	// baseFeePerGas has one more entry than gasUsedRatio (it includes the
	// next-unmined block's projected base fee) — standard eth_feeHistory
	// shape.
	baseFees := make([]*hexutil.Big, count+1)
	for i := range baseFees {
		baseFees[i] = (*hexutil.Big)(big.NewInt(0))
	}
	gasUsedRatio := make([]float64, count)

	result := &FeeHistoryResult{
		OldestBlock:   (*hexutil.Big)(new(big.Int).SetUint64(oldest)),
		BaseFeePerGas: baseFees,
		GasUsedRatio:  gasUsedRatio,
	}

	if len(rewardPercentiles) > 0 {
		reward := make([][]*hexutil.Big, count)
		for i := range reward {
			row := make([]*hexutil.Big, len(rewardPercentiles))
			for j := range row {
				row[j] = (*hexutil.Big)(big.NewInt(0))
			}
			reward[i] = row
		}
		result.Reward = reward
	}
	return result, nil
}

// resolveBlockNumber defaults an omitted block-tag parameter to "latest" —
// the standard Ethereum JSON-RPC default for every method that takes an
// optional block parameter.
func resolveBlockNumber(bn *gethrpc.BlockNumber) gethrpc.BlockNumber {
	if bn == nil {
		return gethrpc.LatestBlockNumber
	}
	return *bn
}

// NetService implements the JSON-RPC "net" namespace.
type NetService struct {
	chainID uint64
}

// NewNetService builds the net_* method set for chain chainID.
func NewNetService(chainID uint64) *NetService { return &NetService{chainID: chainID} }

// Version implements net_version: the network id as a decimal string (not
// hex — this method predates the rest of the hex-quantity convention).
func (n *NetService) Version() string { return strconv.FormatUint(n.chainID, 10) }

// Listening implements net_listening. Always true while the process is up.
func (n *NetService) Listening() bool { return true }

// Web3Service implements the JSON-RPC "web3" namespace.
type Web3Service struct{}

// NewWeb3Service builds the web3_* method set.
func NewWeb3Service() *Web3Service { return &Web3Service{} }

// ClientVersion implements web3_clientVersion. "zkchain/v2.0.0" per MASTER
// §9; revisit (e.g. an "anvil/..." string) only if some consumer's tooling
// is empirically found to special-case client identity (M07).
func (w *Web3Service) ClientVersion() string { return "zkchain/v2.0.0" }
