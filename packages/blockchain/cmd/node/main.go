package main

import (
	"os"

	"zk-blockchain/internal/api"
	"zk-blockchain/internal/core"
	"zk-blockchain/internal/persistence"
)

func main() {
	nodeID := os.Getenv("NODE_ID")
	if nodeID == "" {
		nodeID = "3001"
	}

	port := ":" + nodeID

	store := persistence.NewFileStore("data_" + nodeID)

	var bc *core.Blockchain

	if store.Exists() {
		loaded, _ := store.LoadBlockchain()
		bc = loaded
	} else {
		bc = core.NewBlockchain("Do you support this proposal?")
		store.SaveBlockchain(bc)
	}

	api.InitServer(bc, store)
	api.StartServer(port)
}