package rpc

import (
	"context"
	"fmt"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	gethrpc "github.com/ethereum/go-ethereum/rpc"

	"zk-blockchain/internal/chain"
	"zk-blockchain/internal/consensus"
)

// The zk_ namespace: this chain's own methods, which have no Ethereum
// equivalent.
//
// It exists so that consensus can be inspected *without touching eth_*. Every
// method in the eth namespace has a shape that viem, ethers and the mobile
// relay depend on; adding a field to eth_getBlockByNumber to carry commit
// seals, or inventing eth_getCommitSeals, would put chain-specific data in a
// namespace whose whole value is that it is not chain-specific. Anything
// added here is additive by construction: a client that does not know about
// zk_ is unaffected, and a solo node simply does not register the namespace,
// so its methods answer -32601 exactly as a method that was never written
// would.

// SealProvider is the read side of the commit-seal store.
type SealProvider interface {
	Get(height uint64, hash common.Hash) (*consensus.CommitSeals, error)
}

// ConsensusStatusProvider reports the engine's live state. *consensus.Engine
// satisfies it.
type ConsensusStatusProvider interface {
	Status() consensus.Status
}

// ZkService implements the JSON-RPC "zk" namespace. Registered only when
// CONSENSUS_MODE=bft.
type ZkService struct {
	seq        *chain.Sequencer
	seals      SealProvider
	validators *consensus.ValidatorSet
	status     ConsensusStatusProvider
	chainID    uint64
}

// NewZkService builds the zk_* method set.
func NewZkService(seq *chain.Sequencer, seals SealProvider, validators *consensus.ValidatorSet, status ConsensusStatusProvider, chainID uint64) *ZkService {
	return &ZkService{seq: seq, seals: seals, validators: validators, status: status, chainID: chainID}
}

// RPCSeal is one validator's signature on a finalized block.
type RPCSeal struct {
	// Validator is the operator-facing name from VALIDATOR_SET. An empty
	// string here is itself a finding: it means a seal recovered to an
	// address outside the configured set.
	Validator string `json:"validator"`
	// Address is recovered server-side from the signature, not taken from
	// anywhere. A client can therefore verify the quorum without holding
	// VALIDATOR_SET itself.
	Address   common.Address `json:"address"`
	Signature hexutil.Bytes  `json:"signature"`
}

// RPCCommitSeals is one block's commit certificate as served over JSON-RPC.
type RPCCommitSeals struct {
	Number           hexutil.Uint64 `json:"number"`
	BlockHash        common.Hash    `json:"blockHash"`
	Round            hexutil.Uint64 `json:"round"`
	Quorum           hexutil.Uint64 `json:"quorum"`
	ValidatorSetSize hexutil.Uint64 `json:"validatorSetSize"`
	Seals            []RPCSeal      `json:"seals"`
}

// GetCommitSeals implements zk_getCommitSeals: the certificate proving which
// validators agreed to a block.
//
// This is the method that makes the whole design auditable from outside. A
// scrutineer can ask any node for any block and get back the signatures, the
// addresses they recover to, and how many were required — and check the
// arithmetic without trusting the node that served it.
//
// A block that is unknown, or that has no recorded certificate, returns JSON
// null rather than an error. That is the convention the rest of this package
// already follows (eth_getBlockByNumber and eth_getTransactionReceipt both
// answer null for "no such thing"), and it is what makes the method safe to
// call across a rollout: blocks sealed before consensus was enabled have no
// certificate, and neither do blocks synced from a peer with a truncated seal
// store. Reporting those as errors would make a client unable to distinguish
// "not applicable" from "something is wrong".
//
// A certificate that *exists but does not verify* is a different matter
// entirely and does return an error. Serving a partial list would let a
// caller read three seals as a quorum when one of them recovered to a
// stranger.
func (z *ZkService) GetCommitSeals(ctx context.Context, blockNrOrTag gethrpc.BlockNumber) (*RPCCommitSeals, error) {
	header, err := z.seq.HeaderForBlockTag(blockNrOrTag)
	if err != nil {
		return nil, nil // unknown block: null, per the convention above
	}

	number := header.Number.Uint64()
	hash := header.Hash()

	stored, err := z.seals.Get(number, hash)
	if err != nil {
		return nil, newCodedError(invalidInputCode, "reading commit seals for block %d: %v", number, err)
	}
	if stored == nil {
		return nil, nil
	}

	signers, err := consensus.SealedBy(z.chainID, z.validators, number, hash, stored)
	if err != nil {
		return nil, newCodedError(invalidInputCode, "block %d has a commit certificate that does not verify: %v", number, err)
	}

	out := &RPCCommitSeals{
		Number:           hexutil.Uint64(number),
		BlockHash:        hash,
		Round:            hexutil.Uint64(stored.Round),
		Quorum:           hexutil.Uint64(z.validators.Quorum()),
		ValidatorSetSize: hexutil.Uint64(z.validators.Size()),
		Seals:            make([]RPCSeal, 0, len(stored.Seals)),
	}
	for i, seal := range stored.Seals {
		out.Seals = append(out.Seals, RPCSeal{
			Validator: signers[i].Name,
			Address:   signers[i].Address,
			Signature: seal,
		})
	}
	return out, nil
}

// ConsensusStatus implements zk_consensusStatus: who this node is, what
// height and round it is on, whose turn it is to propose, and which
// validators it has caught misbehaving.
//
// It exists because the interesting questions about a BFT cluster —
// "did the proposership rotate when we killed a node?", "is this validator
// caught up?" — are otherwise only answerable by reading logs, which no test
// and no operator dashboard should have to do.
func (z *ZkService) ConsensusStatus(ctx context.Context) (*consensus.Status, error) {
	if z.status == nil {
		return nil, fmt.Errorf("this node is not running consensus")
	}
	status := z.status.Status()
	return &status, nil
}
