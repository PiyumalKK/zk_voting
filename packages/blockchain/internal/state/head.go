package state

import (
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/rawdb"
	"github.com/ethereum/go-ethereum/ethdb"
)

// Height returns the current chain head's block number. Until
// internal/chain (M03) starts sealing blocks, every node reports the
// genesis height (0); from M03 on this reflects the real head. cmd/node
// wires /health's HeightProvider through this function (instead of the
// hardcoded 0 from M01) so it needs no changes when M03 lands.
func Height(db ethdb.Database) uint64 {
	headHash := rawdb.ReadHeadBlockHash(db)
	if headHash == (common.Hash{}) {
		return 0
	}
	number, ok := rawdb.ReadHeaderNumber(db, headHash)
	if !ok {
		return 0
	}
	return number
}
