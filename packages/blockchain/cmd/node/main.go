package main

import (
	"os"
	"strconv"
	"time"

	"github.com/joho/godotenv"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"zk-blockchain/internal/api"
	"zk-blockchain/internal/core"
	"zk-blockchain/internal/evm"
	"zk-blockchain/internal/network"
	"zk-blockchain/internal/persistence"
	"zk-blockchain/internal/security"
)

func main() {
	// Load .env file if present. Silently ignored when missing so that
	// production deployments can rely purely on real environment variables.
	_ = godotenv.Load()

	zerolog.SetGlobalLevel(zerolog.InfoLevel)
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339})

	nodeID := os.Getenv("NODE_ID")
	if nodeID == "" {
		nodeID = "3001"
	}

	port := ":" + nodeID
	dataDir := "data_" + nodeID

	// assetsDir contains the compiled Solidity artifacts (Voting.json, HonkVerifier.json).
	// These are produced by `npx hardhat compile` in packages/hardhat and copied here.
	assetsDir := os.Getenv("ASSETS_DIR")
	if assetsDir == "" {
		assetsDir = "assets"
	}

	log.Info().Msgf("Starting ZK Voting Node %s...", nodeID)

	// ── Storage ──────────────────────────────────────────────────────────────
	store, err := persistence.NewFileStore(dataDir)
	if err != nil {
		log.Fatal().Err(err).Msg("Failed to initialize database")
	}
	defer store.Close()

	bc, err := store.LoadBlockchain()
	if err != nil {
		log.Info().Msg("No existing blockchain found — creating new genesis block")
		// Default candidates mirror packages/hardhat/deploy/00_deploy_your_contract.ts,
		// which seeds ["Yes", "No"] at deploy time to preserve the original demo's feel.
		// The admin can replace these later during Phase.Setup via /set-candidates.
		bc = core.NewBlockchain("Do you support this proposal?", []string{"Yes", "No"})
		if err := store.SaveBlockchain(bc); err != nil {
			log.Fatal().Err(err).Msg("Failed to save genesis block")
		}
	}
	log.Info().Int("blocks", bc.Len()).Msg("Blockchain loaded")

	// ── EVM ──────────────────────────────────────────────────────────────────
	smgr, err := evm.NewStateManager()
	if err != nil {
		log.Fatal().Err(err).Msg("Failed to initialize EVM StateManager")
	}
	evmInstance := evm.CreateStatelessEVM(smgr.GetStateDB())
	contractCaller := evm.NewContractCaller(evmInstance)
	log.Info().Msg("EVM initialized (Istanbul fork, BN254 precompiles enabled)")

	// ── TLS ──────────────────────────────────────────────────────────────────
	// Load TLS config here so it can be passed to both the network client
	// and the HTTP server. This ordering matters: InitNetworkClient must
	// be called before SyncWithPeers so the mTLS client exists for sync.
	certFile := dataDir + "/certs/server.crt"
	keyFile := dataDir + "/certs/server.key"
	caFile := dataDir + "/certs/server.crt" // self-signed dev: cert acts as its own CA

	tlsConfig, err := security.LoadTLSConfig(certFile, keyFile, caFile)
	if err != nil {
		log.Fatal().Err(err).Msgf(
			"Failed to load TLS certificates from %s/certs/. "+
				"Generate them with: openssl req -x509 -newkey rsa:4096 -nodes "+
				"-keyout %s/certs/server.key -out %s/certs/server.crt -days 365",
			dataDir, dataDir, dataDir,
		)
	}

	// ── Admin Auth ───────────────────────────────────────────────────────────
	// Non-fatal: node runs normally, but /add-voter returns 503 until configured.
	pubKeyPath := dataDir + "/keys/admin_public.pem"
	if err := api.InitAuth(pubKeyPath); err != nil {
		log.Warn().Msgf(
			"Admin auth not configured (key not found at %s). "+
				"The /add-voter endpoint will be disabled. "+
				"Generate a keypair and place the public key at that path to enable it.",
			pubKeyPath,
		)
	} else {
		log.Info().Msg("Admin authentication loaded")
	}

	// ── Network ──────────────────────────────────────────────────────────────
	// InitNetworkClient must come before SyncWithPeers so the mTLS HTTP client
	// is ready when we attempt to fetch chains from peers.
	network.InitNetworkClient(tlsConfig)
	network.SyncWithPeers(bc, store)

	// ── Contract Bridge (Stage 3) ─────────────────────────────────────────────
	// Deploy Voting.sol and HonkVerifier.sol into the embedded EVM, then replay
	// all blockchain blocks to reconstruct the EVM state deterministically.
	//
	// Non-fatal by default: if contract artifacts are missing the node continues
	// without EVM verification (Stage 1/2 mode) — /vote and /register then accept
	// requests with NO cryptographic checks at all. That is convenient for local
	// development but dangerous to leave on by accident in a real deployment, so
	// set REQUIRE_EVM=true to turn a missing/broken bridge into a startup failure
	// instead of a silent fallback.
	//
	// Compile artifacts with:
	//   cd packages/hardhat && npx hardhat compile
	//   cp artifacts/contracts/Voting.sol/Voting.json        packages/blockchain/assets/
	//   cp artifacts/contracts/Verifier.sol/HonkVerifier.json packages/blockchain/assets/
	requireEVM := os.Getenv("REQUIRE_EVM") == "true"

	var bridge *evm.ContractBridge
	question := genesisQuestion(bc)
	candidates := genesisCandidates(bc)
	contractBridge, err := evm.NewContractBridge(contractCaller, assetsDir, question, candidates)
	if err != nil {
		if requireEVM {
			log.Fatal().Err(err).Msg(
				"Contract bridge unavailable and REQUIRE_EVM=true — refusing to start in " +
					"unverified storage-only mode. Compile Solidity artifacts and copy them to " +
					assetsDir + "/, or unset REQUIRE_EVM to allow storage-only mode explicitly.",
			)
		}
		log.Warn().Err(err).Msg(
			"Contract bridge unavailable — running in storage-only mode (Stage 1/2), " +
				"/vote and /register will accept requests with NO ZK verification. " +
				"Compile Solidity artifacts and copy them to " + assetsDir + "/ to enable ZK verification, " +
				"or set REQUIRE_EVM=true to make this a startup failure instead.",
		)
	} else {
		bridge = contractBridge
		log.Info().
			Str("voting_contract", bridge.VotingAddress().Hex()).
			Msg("Contracts deployed — replaying blockchain to reconstruct EVM state")
		evm.ReplayBlockchain(bc, bridge)
	}

	// ── Periodic Peer Sync (Live Node Drift fix, see PLAN.md Stage 1.4) ────────
	// BroadcastBlock is fire-and-forget: a peer that's briefly offline or whose
	// POST fails silently falls behind, with no recovery short of a restart.
	// This ticker re-runs SyncWithPeers on an interval so live nodes self-heal.
	// bc is mutated in place (Blockchain.ReplaceBlocks), so this is safe to run
	// long after api.InitServer has already captured the same *bc pointer.
	syncInterval := 30 * time.Second
	if v := os.Getenv("SYNC_INTERVAL_SEC"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			syncInterval = time.Duration(n) * time.Second
		} else {
			log.Warn().Str("SYNC_INTERVAL_SEC", v).Msg("Invalid SYNC_INTERVAL_SEC, using default 30s")
		}
	}
	network.StartPeriodicSync(bc, store, syncInterval, func() {
		// A peer's chain was just adopted — replay it into the EVM bridge so the
		// EVM state (votes, registrations, phase) reflects what ReplaceBlocks just
		// wrote into bc. ReplayBlockchain re-runs every block from the start, but
		// that's safe here: transactions already reflected in EVM state simply
		// fail again (already-registered, wrong-phase, etc.) and are skipped with
		// a warning, same as any other replay-time rejection — only the blocks
		// this node was missing actually apply.
		if bridge != nil {
			log.Info().Msg("Periodic sync adopted a longer peer chain — replaying into EVM state")
			evm.ReplayBlockchain(bc, bridge)
		}
	})

	// ── API Server ───────────────────────────────────────────────────────────
	api.InitServer(bc, store, bridge)
	api.StartServer(port, tlsConfig)
}

// genesisQuestion reads the voting question from the genesis block's transaction payload.
// Falls back to a sensible default if the genesis block cannot be parsed.
func genesisQuestion(bc *core.Blockchain) string {
	genesis, err := bc.GetBlock(0)
	if err != nil || len(genesis.Transactions) == 0 {
		return "Do you support this proposal?"
	}
	var payload core.GenesisPayload
	if err := genesis.Transactions[0].ParsePayload(&payload); err != nil || payload.Question == "" {
		return "Do you support this proposal?"
	}
	return payload.Question
}

// genesisCandidates reads the initial candidate list from the genesis block's
// transaction payload. Returns nil (no candidates) if the genesis block predates
// this field or cannot be parsed — the contract deploys fine with zero candidates,
// and an admin can set them later via /set-candidates during Phase.Setup.
func genesisCandidates(bc *core.Blockchain) []string {
	genesis, err := bc.GetBlock(0)
	if err != nil || len(genesis.Transactions) == 0 {
		return nil
	}
	var payload core.GenesisPayload
	if err := genesis.Transactions[0].ParsePayload(&payload); err != nil {
		return nil
	}
	return payload.Candidates
}
