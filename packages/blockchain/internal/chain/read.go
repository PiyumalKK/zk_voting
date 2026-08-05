package chain

import (
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/rawdb"
	gethstate "github.com/ethereum/go-ethereum/core/state"
	"github.com/ethereum/go-ethereum/core/types"
	gethrpc "github.com/ethereum/go-ethereum/rpc"

	"zk-blockchain/internal/state"
)

// This file adds the read-only account/block accessors internal/rpc's read
// methods (M04) need. Like Call/EstimateGas (execute.go), every method here
// takes no lock and opens its own disposable, read-only StateDB via
// internal/state.At — none of these touch the write path or the sequencer's
// head. Keeping them on Sequencer (rather than having internal/rpc reach
// into internal/state or go-ethereum's core/state directly) is deliberate:
// CallMsg's doc comment in execute.go already establishes that internal/rpc
// should only ever depend on this package's own exported surface plus
// common/types — never on geth's state/vm packages directly (MASTER §4
// package-boundary rule).

// Balance returns addr's wei balance at the block bn resolves to.
func (s *Sequencer) Balance(addr common.Address, bn gethrpc.BlockNumber) (*big.Int, error) {
	statedb, err := s.stateAt(bn)
	if err != nil {
		return nil, err
	}
	return statedb.GetBalance(addr).ToBig(), nil
}

// Nonce returns addr's account nonce at the block bn resolves to.
func (s *Sequencer) Nonce(addr common.Address, bn gethrpc.BlockNumber) (uint64, error) {
	statedb, err := s.stateAt(bn)
	if err != nil {
		return 0, err
	}
	return statedb.GetNonce(addr), nil
}

// Code returns addr's deployed contract code at the block bn resolves to
// (empty for an EOA or an account that doesn't exist).
func (s *Sequencer) Code(addr common.Address, bn gethrpc.BlockNumber) ([]byte, error) {
	statedb, err := s.stateAt(bn)
	if err != nil {
		return nil, err
	}
	return statedb.GetCode(addr), nil
}

// StorageAt returns the raw 32-byte word stored at addr's storage slot at
// the block bn resolves to.
func (s *Sequencer) StorageAt(addr common.Address, slot common.Hash, bn gethrpc.BlockNumber) (common.Hash, error) {
	statedb, err := s.stateAt(bn)
	if err != nil {
		return common.Hash{}, err
	}
	return statedb.GetState(addr, slot), nil
}

// stateAt is the shared "resolve a block tag, then open read-only state at
// its root" step Balance/Nonce/Code/StorageAt all need — the state
// equivalent of headerForBlockNumber, one level up.
func (s *Sequencer) stateAt(bn gethrpc.BlockNumber) (*gethstate.StateDB, error) {
	header, err := s.headerForBlockNumber(bn)
	if err != nil {
		return nil, err
	}
	return state.At(s.db, header.Root)
}

// BlockNumber returns the current chain head's block number (eth_blockNumber).
func (s *Sequencer) BlockNumber() (uint64, error) {
	header, err := s.currentHeader()
	if err != nil {
		return 0, err
	}
	return header.Number.Uint64(), nil
}

// HeaderForBlockTag resolves bn (a number or a latest/pending/safe/
// finalized/earliest tag) to a header — exported so internal/rpc's block
// methods (and eth_getBalance's block-tag error surface) can report "block
// not found" for an out-of-range number without needing their own copy of
// this chain's tag-resolution rule (MASTER §10 pitfall 4).
func (s *Sequencer) HeaderForBlockTag(bn gethrpc.BlockNumber) (*types.Header, error) {
	return s.headerForBlockNumber(bn)
}

// BlockByTag resolves bn to a header, then returns that block's full body
// (header + transactions) — used by eth_getBlockByNumber.
func (s *Sequencer) BlockByTag(bn gethrpc.BlockNumber) (*types.Block, error) {
	header, err := s.headerForBlockNumber(bn)
	if err != nil {
		return nil, err
	}
	return s.blockByHeader(header)
}

// BlockByHash returns the block identified by hash, or an error if it isn't
// a known canonical block — used by eth_getBlockByHash.
func (s *Sequencer) BlockByHash(hash common.Hash) (*types.Block, error) {
	number, ok := rawdb.ReadHeaderNumber(s.db, hash)
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrBlockNotFound, hash)
	}
	header := rawdb.ReadHeader(s.db, hash, number)
	if header == nil {
		return nil, fmt.Errorf("%w: header for %s", ErrBlockNotFound, hash)
	}
	return s.blockByHeader(header)
}

func (s *Sequencer) blockByHeader(header *types.Header) (*types.Block, error) {
	hash := header.Hash()
	block := rawdb.ReadBlock(s.db, hash, header.Number.Uint64())
	if block == nil {
		return nil, fmt.Errorf("%w: body for header %s (number %d)", ErrBlockNotFound, hash, header.Number.Uint64())
	}
	return block, nil
}
