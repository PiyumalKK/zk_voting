// Package state owns everything about "what the world looks like": the EVM
// ruleset (this file), genesis construction (genesis.go), and StateDB
// lifecycle (statedb.go). internal/chain (M03) is the only other package
// allowed to touch these types directly — RPC and P2P go through it.
package state

import (
	"math/big"

	"github.com/ethereum/go-ethereum/params"
)

// ChainConfig returns the EVM ruleset for chainID: every fork through
// Cancun and Prague is active from block/time 0 (MASTER §2, §3, §10 — solc
// 0.8.30 may target the Prague EVM version; M08 additionally pins
// evmVersion:"cancun" in hardhat.config.ts belt-and-braces). There is no
// PoW/PoA consensus in this chain — blocks are sealed directly by
// internal/chain (M03) — so TerminalTotalDifficulty is pinned to 0 so any
// geth code path that branches on merge status sees "always post-merge".
//
// Base fee is 0 in every header (free-gas policy, MASTER §3/§10) even
// though London/EIP-1559 is enabled; internal/chain enforces that by
// construction rather than by disabling the fork, so txs of every type
// (legacy, 2930, 1559) remain valid — mobile sends legacy txs and must
// keep working (MASTER §10 pitfall 3).
func ChainConfig(chainID uint64) *params.ChainConfig {
	zero := big.NewInt(0)
	zeroTime := uint64(0)

	return &params.ChainConfig{
		ChainID: new(big.Int).SetUint64(chainID),

		HomesteadBlock:      zero,
		DAOForkBlock:        nil, // no DAO fork on a chain that starts post-Homestead
		DAOForkSupport:      false,
		EIP150Block:         zero,
		EIP155Block:         zero,
		EIP158Block:         zero,
		ByzantiumBlock:      zero,
		ConstantinopleBlock: zero,
		PetersburgBlock:     zero,
		IstanbulBlock:       zero,
		MuirGlacierBlock:    zero,
		BerlinBlock:         zero,
		LondonBlock:         zero,
		ArrowGlacierBlock:   zero,
		GrayGlacierBlock:    zero,

		MergeNetsplitBlock:      zero,
		TerminalTotalDifficulty: zero,

		ShanghaiTime: &zeroTime,
		CancunTime:   &zeroTime,
		PragueTime:   &zeroTime,

		// go-ethereum requires an explicit blob schedule entry for every
		// activated fork that has one (params.ChainConfig.CheckConfigForkOrder
		// / the "missing entry for fork ... in blobSchedule" validation
		// error) — even though this chain has no blob-carrying transactions
		// in its RPC surface (MASTER §9's "not implemented" list has no
		// blob-tx method). Reusing go-ethereum's own mainnet defaults here
		// keeps the config valid without inventing arbitrary numbers.
		BlobScheduleConfig: &params.BlobScheduleConfig{
			Cancun: params.DefaultCancunBlobConfig,
			Prague: params.DefaultPragueBlobConfig,
		},
	}
}
