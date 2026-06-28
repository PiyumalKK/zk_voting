package main

import (
	"os"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"zk-blockchain/internal/api"
	"zk-blockchain/internal/core"
	"zk-blockchain/internal/evm"
	"zk-blockchain/internal/network"
	"zk-blockchain/internal/persistence"
)

func main() {
	// Set log level to Info for production, Debug for development
	zerolog.SetGlobalLevel(zerolog.InfoLevel)
	// Pretty print for local development
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339})

	nodeID := os.Getenv("NODE_ID")
	if nodeID == "" {
		nodeID = "3001"
	}

	port := ":" + nodeID
	dataDir := "data_" + nodeID

	log.Info().Msgf("Starting ZK Voting Node %s...", nodeID)

	store, err := persistence.NewFileStore(dataDir)
	if err != nil {
		log.Fatal().Err(err).Msg("Failed to initialize database")
	}
	defer store.Close()

	bc, err := store.LoadBlockchain()
	if err != nil {
		log.Info().Err(err).Msg("No existing blockchain found, creating new one")
		bc = core.NewBlockchain("Do you support this proposal?")
		if err := store.SaveBlockchain(bc); err != nil {
			log.Fatal().Err(err).Msg("Failed to save genesis block")
		}
	}

	// Initialize EVM for smart contract execution
	smgr, err := evm.NewStateManager()
	if err != nil {
		log.Fatal().Err(err).Msg("Failed to initialize EVM StateManager")
	}
	evmInstance := evm.CreateStatelessEVM(smgr.GetStateDB())
	contractCaller := evm.NewContractCaller(evmInstance)

	// Paths to security assets
	pubKeyPath := dataDir + "/keys/admin_public.pem"
	certFile := dataDir + "/certs/server.crt"
	keyFile := dataDir + "/certs/server.key"
	caFile := dataDir + "/certs/server.crt" // Assuming self-signed or same CA for dev

	// Initialize Admin Auth
	if err := api.InitAuth(pubKeyPath); err != nil {
		log.Fatal().Err(err).Msg("Failed to initialize admin authentication")
	}

	network.SyncWithPeers(&bc, store)

	api.InitServer(bc, store, contractCaller)
	api.StartServer(port, certFile, keyFile, caFile)
}
