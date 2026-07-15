package main

import (
	"crypto/tls"
	"errors"
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
	if errors.Is(err, persistence.ErrNoBlockchain) {
		log.Info().Msg("No existing blockchain found — creating new genesis block")
		// Default candidates mirror packages/hardhat/deploy/00_deploy_your_contract.ts,
		// which seeds ["Yes", "No"] at deploy time to preserve the original demo's feel.
		// The admin can replace these later during Phase.Setup via /set-candidates.
		bc = core.NewBlockchain("Do you support this proposal?", []string{"Yes", "No"})
		if err := store.SaveBlockchain(bc); err != nil {
			log.Fatal().Err(err).Msg("Failed to save genesis block")
		}
	} else if err != nil {
		// A load error that is NOT "empty database" means the persisted chain is
		// corrupt or failed validation. Refuse to start rather than silently
		// discarding it and reinitializing a fresh election (data loss).
		log.Fatal().Err(err).Msg(
			"Failed to load existing blockchain — the on-disk data is corrupt or invalid. " +
				"Refusing to start so it is not silently overwritten. " +
				"Inspect or remove " + dataDir + "/blockchain.db to start from a fresh genesis.")
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

	// ── TLS (P2P only) ───────────────────────────────────────────────────────
	// The mTLS config guards ONLY node-to-node traffic (its ClientAuth:
	// RequireAndVerifyClientCert would lock browsers out — they cannot present
	// client certificates, which is why the public API listens separately).
	//
	// Certificates are therefore optional for a standalone dev node: with no
	// PEERS configured, the node simply runs without a P2P listener. With PEERS
	// configured, missing certificates are still a fatal misconfiguration.
	certFile := dataDir + "/certs/server.crt"
	keyFile := dataDir + "/certs/server.key"
	caFile := dataDir + "/certs/server.crt" // self-signed dev: cert acts as its own CA

	tlsConfig, tlsErr := security.LoadTLSConfig(certFile, keyFile, caFile)
	if tlsErr != nil {
		if os.Getenv("PEERS") != "" {
			log.Fatal().Err(tlsErr).Msgf(
				"PEERS is configured but TLS certificates could not be loaded from %s/certs/. "+
					"P2P requires mTLS. Generate them with: openssl req -x509 -newkey rsa:4096 -nodes "+
					"-keyout %s/certs/server.key -out %s/certs/server.crt -days 365",
				dataDir, dataDir, dataDir,
			)
		}
		log.Warn().Msgf(
			"No TLS certificates at %s/certs/ — P2P networking disabled (fine for a standalone node). "+
				"Generate certificates and set PEERS to join a cluster.",
			dataDir,
		)
		tlsConfig = nil
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
	if tlsConfig != nil {
		network.InitNetworkClient(tlsConfig)
		network.SyncWithPeers(bc, store)
	}

	// ── Contract Bridge (Stage 3) ─────────────────────────────────────────────
	// Deploy Voting.sol and HonkVerifier.sol into the embedded EVM, then replay
	// all blockchain blocks to reconstruct the EVM state deterministically.
	//
	// A missing/broken bridge is a FATAL startup error by default: without the
	// EVM, /vote and /register accept requests with NO cryptographic checks at
	// all. Set ALLOW_STORAGE_ONLY=true to explicitly opt into that unverified
	// mode (early-stage development only).
	//
	// Compile artifacts with `make sync-artifacts` (runs hardhat compile and
	// copies Voting.json, HonkVerifier.json, PoseidonT3.json, LeanIMT.json here).
	allowStorageOnly := os.Getenv("ALLOW_STORAGE_ONLY") == "true"

	var bridge *evm.ContractBridge
	question := genesisQuestion(bc)
	candidates := genesisCandidates(bc)
	contractBridge, err := evm.NewContractBridge(contractCaller, assetsDir, question, candidates)
	if err != nil {
		if !allowStorageOnly {
			log.Fatal().Err(err).Msg(
				"Contract bridge unavailable — refusing to start in unverified storage-only mode. " +
					"Run `make sync-artifacts` to compile and copy Solidity artifacts to " + assetsDir + "/, " +
					"or set ALLOW_STORAGE_ONLY=true to explicitly allow running without ZK verification.",
			)
		}
		log.Warn().Err(err).Msg(
			"ALLOW_STORAGE_ONLY=true — running in storage-only mode (Stage 1/2), " +
				"/vote and /register will accept requests with NO ZK verification.",
		)
	} else {
		bridge = contractBridge
		log.Info().
			Str("voting_contract", bridge.VotingAddress().Hex()).
			Str("voting_code_hash", bridge.VotingCodeHash().Hex()).
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
		// A peer's chain was just adopted — rebuild the EVM from scratch to match it.
		// Replaying onto the existing EVM is only sound for a strict extension; if the
		// adopted chain diverged from ours, stale registrations/nullifiers from the
		// abandoned local blocks would linger and wrongly reject later operations.
		// ResyncFromChain deploys a fresh EVM and replays the whole adopted chain into
		// it, then swaps it in atomically.
		if bridge != nil {
			log.Info().Msg("Periodic sync adopted a longer peer chain — rebuilding EVM state")
			if err := bridge.ResyncFromChain(bc); err != nil {
				log.Error().Err(err).Msg("Failed to rebuild EVM state after peer sync")
			}
		}
	}, api.WriteLock, api.WriteUnlock)

	// ── API Servers ──────────────────────────────────────────────────────────
	// Two listeners with different trust models:
	//   - P2P (mTLS, client certs REQUIRED): /internal/* only. Started first,
	//     in a goroutine, and only when certificates exist.
	//   - Public API: browser-facing. Plain HTTP by default; set API_TLS=true
	//     to serve HTTPS using the same cert WITHOUT requiring client certs.
	api.InitServer(bc, store, bridge)

	if tlsConfig != nil {
		p2pPort := os.Getenv("P2P_PORT")
		if p2pPort == "" {
			if n, err := strconv.Atoi(nodeID); err == nil {
				p2pPort = strconv.Itoa(n + 1000)
			} else {
				p2pPort = "4001"
			}
		}
		api.StartP2PServer(":"+p2pPort, tlsConfig)
	}

	var publicTLS *tls.Config
	if os.Getenv("API_TLS") == "true" {
		if tlsConfig == nil {
			log.Fatal().Msg("API_TLS=true requires TLS certificates in " + dataDir + "/certs/")
		}
		// Same certificate, but NO ClientAuth — browsers can connect.
		publicTLS = &tls.Config{Certificates: tlsConfig.Certificates}
	}
	api.StartPublicServer(port, publicTLS)
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
