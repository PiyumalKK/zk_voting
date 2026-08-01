package state

import (
	"errors"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core"
	"github.com/ethereum/go-ethereum/core/rawdb"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethdb"
	"github.com/ethereum/go-ethereum/triedb"

	"zk-blockchain/internal/config"
)

// genesisExtraData is stamped into the genesis header's ExtraData field —
// cosmetic only, but handy when eyeballing a block explorer.
var genesisExtraData = []byte("zkchain-genesis")

// hardhatMnemonicAddresses are the 20 accounts derived from Hardhat's
// well-known default test mnemonic, "test test test test test test test
// test test test test junk", at derivation path m/44'/60'/0'/0/{0..19}.
// These are exactly the accounts `yarn chain` / `yarn deploy` sign with and
// the accounts the dev faucet (M11) draws from — prefunding them at
// genesis is what makes `yarn deploy --network custom` and the faucet work
// unchanged (MASTER §2 "Facts the plan depends on", §8 swap procedure).
//
// Not retyped from memory: derived 2026-07-29 in-repo with
// `packages/hardhat`'s own installed ethers.js
// (ethers.HDNodeWallet.fromMnemonic against the same mnemonic Hardhat
// uses), then pasted here so genesis construction has no runtime
// dependency on a mnemonic library. Re-derive and diff against this list
// if `packages/hardhat/hardhat.config.ts` ever changes its `accounts`
// mnemonic.
var hardhatMnemonicAddresses = [20]common.Address{
	common.HexToAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"),
	common.HexToAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8"),
	common.HexToAddress("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"),
	common.HexToAddress("0x90F79bf6EB2c4f870365E785982E1f101E93b906"),
	common.HexToAddress("0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"),
	common.HexToAddress("0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"),
	common.HexToAddress("0x976EA74026E726554dB657fA54763abd0C3a0aa9"),
	common.HexToAddress("0x14dC79964da2C08b23698B3D3cc7Ca32193d9955"),
	common.HexToAddress("0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f"),
	common.HexToAddress("0xa0Ee7A142d267C1f36714E4a8F75612F20a79720"),
	common.HexToAddress("0xBcd4042DE499D14e55001CcbB24a551F3b954096"),
	common.HexToAddress("0x71bE63f3384f5fb98995898A86B02Fb2426c5788"),
	common.HexToAddress("0xFABB0ac9d68B0B445fB7357272Ff202C5651694a"),
	common.HexToAddress("0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec"),
	common.HexToAddress("0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097"),
	common.HexToAddress("0xcd3B766CCDd6AE721141F452C550Ca635964ce71"),
	common.HexToAddress("0x2546BcD3c84621e976D8185a91A922aE77ECEc30"),
	common.HexToAddress("0xbDA5747bFD65F08deb54cb465eB87D40e51B197E"),
	common.HexToAddress("0xdD2FD4581271e230360230F9337D5c0430Bf44C0"),
	common.HexToAddress("0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199"),
}

// weiPerEther and prefundPerAccount give every genesis account 10,000 ETH
// (M02 goal), matching what a fresh `hardhat node` grants the same
// accounts — Hardhat-mode and custom-mode behave identically here.
var weiPerEther = big.NewInt(1_000_000_000_000_000_000)

func prefundPerAccount() *big.Int {
	return new(big.Int).Mul(big.NewInt(10_000), weiPerEther)
}

// buildGenesis assembles the core.Genesis this build always produces for
// cfg.ChainID. It reads no wall-clock time and no randomness, so two fresh
// data directories built from the same config produce byte-identical
// genesis blocks (M02 spec note; proven by TestGenesisIsDeterministic).
func buildGenesis(cfg *config.Config) *core.Genesis {
	alloc := make(types.GenesisAlloc, len(hardhatMnemonicAddresses))
	for _, addr := range hardhatMnemonicAddresses {
		alloc[addr] = types.Account{Balance: prefundPerAccount()}
	}

	return &core.Genesis{
		Config:     ChainConfig(cfg.ChainID),
		Nonce:      0,
		Timestamp:  0,
		ExtraData:  genesisExtraData,
		GasLimit:   cfg.BlockGasLimit,
		Difficulty: big.NewInt(0),
		Mixhash:    common.Hash{},
		Coinbase:   common.Address{},
		Alloc:      alloc,
		Number:     0,
		GasUsed:    0,
		ParentHash: common.Hash{},
		// Base fee is 0 at genesis and stays 0 forever — internal/chain
		// (M03) never recomputes it via misc.CalcBaseFee — the free-gas
		// foundation the whole custom-chain story depends on (MASTER §3,
		// §10 pitfall 3).
		BaseFee: big.NewInt(0),
	}
}

// GenesisMismatchError means dataDir already holds a genesis whose hash or
// persisted ChainConfig does not match what this build/config would
// produce: config drift (a different CHAIN_ID, BLOCK_GAS_LIMIT, or a code
// change to buildGenesis) against an existing data directory. There is no
// safe way to reconcile this automatically — the fix is `make reset` (wipe
// the data dir) or pointing DATA_DIR at a fresh directory.
type GenesisMismatchError struct {
	Stored, Computed common.Hash
	// Reason describes what specifically disagreed — either the genesis
	// hash itself, or (when the hash matches but CHAIN_ID doesn't; see the
	// comment in EnsureGenesis) the persisted ChainConfig.
	Reason string
}

func (e *GenesisMismatchError) Error() string {
	return fmt.Sprintf(
		"genesis mismatch (%s): data dir has genesis %s, this config computes %s — "+
			"the data dir was created with a different CHAIN_ID/BLOCK_GAS_LIMIT/genesis "+
			"allocation; run `make reset` to wipe it, or point DATA_DIR at a fresh directory",
		e.Reason, e.Stored, e.Computed,
	)
}

// ErrNoGenesis means db holds no genesis block at all — an empty or
// non-chain data directory. EnsureGenesis treats that as "write one";
// VerifyGenesis, which must never write, reports it.
var ErrNoGenesis = errors.New("no genesis block in this data directory")

// VerifyGenesis checks that the genesis already stored in db is the one
// this build and cfg produce, without writing anything. It returns the
// computed genesis block on success.
//
// Read-only is the point: M09's audit tool opens the chain read-only and
// starts its replay from the stored genesis, so it needs this check — a
// chain whose genesis does not match the configured CHAIN_ID/prefunds is
// not the chain the auditor thinks it is auditing, and every state root
// after block 0 would be verified against the wrong baseline.
func VerifyGenesis(db ethdb.Database, cfg *config.Config) (*types.Block, error) {
	genesis := buildGenesis(cfg)
	computed := genesis.ToBlock()

	existing := rawdb.ReadCanonicalHash(db, 0)
	if existing == (common.Hash{}) {
		return nil, ErrNoGenesis
	}
	if existing != computed.Hash() {
		return nil, &GenesisMismatchError{Stored: existing, Computed: computed.Hash(), Reason: "genesis hash differs"}
	}
	// The genesis header (and therefore its hash) does not encode ChainID —
	// EIP-155's replay-protection id is a transaction-signing parameter, not
	// a block header field — so a CHAIN_ID change against an
	// otherwise-identical genesis (same alloc/gas limit) produces the *same*
	// hash and would slip past the check above. go-ethereum's own
	// Genesis.Commit persists the full ChainConfig alongside the block
	// (rawdb.WriteChainConfig) for exactly this reason; read it back and
	// compare ChainID explicitly.
	if stored := rawdb.ReadChainConfig(db, existing); stored != nil && stored.ChainID.Cmp(genesis.Config.ChainID) != 0 {
		return nil, &GenesisMismatchError{
			Stored:   existing,
			Computed: computed.Hash(),
			Reason:   fmt.Sprintf("stored CHAIN_ID=%s, configured CHAIN_ID=%s", stored.ChainID, genesis.Config.ChainID),
		}
	}
	return computed, nil
}

// EnsureGenesis writes the genesis block if db has none yet, or verifies
// the existing genesis matches cfg if it does. It returns the canonical
// genesis block either way, so callers (cmd/node) always have the genesis
// hash and height-0 block on hand to log.
func EnsureGenesis(db ethdb.Database, cfg *config.Config) (*types.Block, error) {
	block, err := VerifyGenesis(db, cfg)
	if err == nil {
		return block, nil
	}
	if !errors.Is(err, ErrNoGenesis) {
		return nil, err
	}

	genesis := buildGenesis(cfg)

	// Hash-scheme trie database: this chain has no need for the newer
	// path-based scheme's pruning tradeoffs at this scale, and audit
	// replay (M09) wants the simplest, most auditable trie storage.
	tdb := triedb.NewDatabase(db, triedb.HashDefaults)
	defer tdb.Close()

	committed, err := genesis.Commit(db, tdb)
	if err != nil {
		return nil, fmt.Errorf("commit genesis: %w", err)
	}
	return committed, nil
}
