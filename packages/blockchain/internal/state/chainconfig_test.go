package state

import (
	"math/big"
	"testing"
)

func TestChainConfigChainID(t *testing.T) {
	cfg := ChainConfig(9494)
	if cfg.ChainID.Uint64() != 9494 {
		t.Errorf("ChainID = %s, want 9494", cfg.ChainID)
	}
}

// TestChainConfigForksActiveFromGenesis asserts every fork through Cancun
// and Prague is live at block 0 / time 0, and that the chain is always
// "post-merge" (TerminalTotalDifficulty = 0) — MASTER §2/§3/§10: solc
// 0.8.30 may target the Prague EVM version, and there is no PoW/PoA
// consensus for a merge-status check to disagree with.
func TestChainConfigForksActiveFromGenesis(t *testing.T) {
	cfg := ChainConfig(9494)
	genesisBlock := big.NewInt(0)
	const genesisTime = 0

	if !cfg.IsLondon(genesisBlock) {
		t.Error("London not active at block 0")
	}
	if !cfg.IsShanghai(genesisBlock, genesisTime) {
		t.Error("Shanghai not active at block/time 0")
	}
	if !cfg.IsCancun(genesisBlock, genesisTime) {
		t.Error("Cancun not active at block/time 0")
	}
	if !cfg.IsPrague(genesisBlock, genesisTime) {
		t.Error("Prague not active at block/time 0")
	}
	if cfg.TerminalTotalDifficulty == nil || cfg.TerminalTotalDifficulty.Sign() != 0 {
		t.Errorf("TerminalTotalDifficulty = %v, want 0", cfg.TerminalTotalDifficulty)
	}
}
