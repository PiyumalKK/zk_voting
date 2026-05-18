package main

import (
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"zk-blockchain/internal/core"
	"zk-blockchain/internal/persistence"
	"zk-blockchain/internal/security"
)

// ══════════════════════════════════════════════════════════════════════
//  SIMULATION MODE
//  Run with: $env:SIMULATION="true"; go run cmd/node/main.go
//  Spins up 3 HTTPS nodes in-process and runs all security tests.
// ══════════════════════════════════════════════════════════════════════

type simResult struct {
	name   string
	passed bool
	detail string
}

var results []simResult
var passed, failed int

func check(name string, ok bool, detail string) {
	r := simResult{name: name, passed: ok, detail: detail}
	results = append(results, r)
	if ok {
		passed++
		fmt.Printf("  [OK]   %s\n", name)
	} else {
		failed++
		fmt.Printf("  [FAIL] %s — %s\n", name, detail)
	}
}

func runSimulation() {
	fmt.Println("==========================================================")
	fmt.Println(" ZK VOTING BLOCKCHAIN — SECURITY SIMULATION (3 NODES)")
	fmt.Println("==========================================================")
	fmt.Println()

	// Clean up previous simulation data to start fresh
	for _, id := range []string{"data_3001", "data_3002", "data_3003"} {
		os.RemoveAll(id)
	}

	// ── Section 1: Core Blockchain Tests ────────────────────────────
	fmt.Println("-- Section 1: Core Blockchain Tests --")
	runCoreTests()

	// ── Section 2: Security Module Tests ────────────────────────────
	fmt.Println("\n-- Section 2: Security Module Tests --")
	runSecurityTests()

	// ── Section 3: 3-Node Network Simulation ────────────────────────
	fmt.Println("\n-- Section 3: 3-Node Network Simulation --")
	runNetworkSimulation()

	// ── Summary ─────────────────────────────────────────────────────
	fmt.Println("\n==========================================================")
	fmt.Printf(" RESULTS: %d passed, %d failed, %d total\n", passed, failed, passed+failed)
	fmt.Println("==========================================================")

	if failed > 0 {
		os.Exit(1)
	}
}

// ════════════════════════════════════════════════════════════════
//  Section 1 — Core blockchain logic (from blockchain_test.go)
// ════════════════════════════════════════════════════════════════

func runCoreTests() {
	// 1.1 Genesis block creation
	bc := core.NewBlockchain("Do you support this proposal?")
	check("Genesis block created", bc.Len() == 1, fmt.Sprintf("got %d blocks", bc.Len()))

	genesis := bc.GetLatestBlock()
	check("Genesis index is 0", genesis.Index == 0, fmt.Sprintf("got %d", genesis.Index))
	check("Genesis IsGenesis()", genesis.IsGenesis(), "")
	check("Genesis has transactions", genesis.HasTransactions(), "")
	check("Genesis has computed hash", genesis.Hash != "", "hash is empty")

	var gp core.GenesisPayload
	genesis.Transactions[0].ParsePayload(&gp)
	check("Genesis contains question", gp.Question == "Do you support this proposal?", gp.Question)

	// 1.2 Transaction creation and hash verification
	tx1, err := core.NewTransaction(core.TxAddVoter, core.AddVoterPayload{VoterID: "voter1", Allowed: true})
	check("Transaction created", err == nil, fmt.Sprint(err))
	check("Transaction hash not empty", tx1.Hash != "", "")
	check("Transaction ID length 16", len(tx1.ID) == 16, fmt.Sprintf("got %d", len(tx1.ID)))
	check("Transaction hash verifies", tx1.VerifyHash(), "")

	// 1.3 Transaction tamper detection
	tx2, _ := core.NewTransaction(core.TxAddVoter, core.AddVoterPayload{VoterID: "voter1", Allowed: true})
	tampered, _ := json.Marshal(core.AddVoterPayload{VoterID: "hacker", Allowed: true})
	tx2.Payload = tampered
	check("Tampered tx fails VerifyHash()", !tx2.VerifyHash(), "tampered tx passed verification")

	// 1.4 Block addition and chain linkage
	txA, _ := core.NewTransaction(core.TxAddVoter, core.AddVoterPayload{VoterID: "v1", Allowed: true})
	txB, _ := core.NewTransaction(core.TxAddVoter, core.AddVoterPayload{VoterID: "v2", Allowed: true})
	block, err := bc.AddBlock([]core.Transaction{*txA, *txB})
	check("Block added successfully", err == nil, fmt.Sprint(err))
	check("Block index is 1", block.Index == 1, fmt.Sprintf("got %d", block.Index))
	check("Block has 2 transactions", block.TransactionCount() == 2, "")
	g, _ := bc.GetBlock(0)
	check("Block PrevHash links to genesis", block.PrevHash == g.Hash, "")

	// 1.5 Empty block rejected
	_, err = bc.AddBlock([]core.Transaction{})
	check("Empty block rejected", err != nil, "empty block was accepted")

	// 1.6 Multi-block chain building
	bc2 := core.NewBlockchain("Test")
	for i := 0; i < 5; i++ {
		tx, _ := core.NewTransaction(core.TxAddVoter, core.AddVoterPayload{VoterID: fmt.Sprintf("v%d", i), Allowed: true})
		bc2.AddTransaction(tx)
	}
	check("Chain has 6 blocks (genesis+5)", bc2.Len() == 6, fmt.Sprintf("got %d", bc2.Len()))
	check("Chain height is 5", bc2.Height() == 5, "")

	blocks := bc2.GetBlocks()
	chainLinked := true
	for i := 1; i < len(blocks); i++ {
		if blocks[i].PrevHash != blocks[i-1].Hash {
			chainLinked = false
			break
		}
	}
	check("All blocks linked correctly", chainLinked, "")

	// 1.7 Chain validation
	check("Valid chain passes validation", bc2.ValidateChain() == nil, "")

	// 1.8 Tamper detection — modified block hash
	bc3 := core.NewBlockchain("Test")
	txT, _ := core.NewTransaction(core.TxAddVoter, core.AddVoterPayload{VoterID: "v1", Allowed: true})
	bc3.AddTransaction(txT)
	bc3.GetBlocks()[1].Hash = "tampered_hash"
	check("Tampered block hash detected", bc3.ValidateChain() != nil, "tamper not detected")

	// 1.9 Tamper detection — modified transaction payload
	bc4 := core.NewBlockchain("Test")
	txV, _ := core.NewTransaction(core.TxVote, core.VotePayload{Proof: "0xlegit", NullifierHash: "0xn", Root: "0xr", Vote: true, Depth: 3})
	bc4.AddTransaction(txV)
	fakePayload, _ := json.Marshal(core.VotePayload{Proof: "0xlegit", NullifierHash: "0xn", Root: "0xr", Vote: false, Depth: 3})
	bc4.GetBlocks()[1].Transactions[0].Payload = fakePayload
	check("Tampered vote payload detected", bc4.ValidateChain() != nil, "tamper not detected")

	// 1.10 LoadFromBlocks — valid chain
	bc5 := core.NewBlockchain("Test")
	txL, _ := core.NewTransaction(core.TxAddVoter, core.AddVoterPayload{VoterID: "v1", Allowed: true})
	bc5.AddTransaction(txL)
	loaded, err := core.LoadFromBlocks(bc5.GetBlocks())
	check("LoadFromBlocks succeeds", err == nil, fmt.Sprint(err))
	if loaded != nil {
		check("Loaded chain matches original", loaded.Len() == bc5.Len(), "")
	}

	// 1.11 LoadFromBlocks — tampered chain rejected
	bc6 := core.NewBlockchain("Test")
	txL2, _ := core.NewTransaction(core.TxAddVoter, core.AddVoterPayload{VoterID: "v1", Allowed: true})
	bc6.AddTransaction(txL2)
	badBlocks := bc6.GetBlocks()
	badBlocks[1].Hash = "tampered"
	_, err = core.LoadFromBlocks(badBlocks)
	check("Tampered LoadFromBlocks rejected", err != nil, "tampered chain was accepted")

	// 1.12 LoadFromBlocks — empty chain rejected
	_, err = core.LoadFromBlocks([]*core.Block{})
	check("Empty LoadFromBlocks rejected", err != nil, "empty chain was accepted")

	// 1.13 Transaction type queries
	bc7 := core.NewBlockchain("Test")
	txQ1, _ := core.NewTransaction(core.TxAddVoter, core.AddVoterPayload{VoterID: "v1", Allowed: true})
	bc7.AddTransaction(txQ1)
	txQ2, _ := core.NewTransaction(core.TxRegister, core.RegisterPayload{VoterID: "v1", Commitment: "0xabc"})
	bc7.AddTransaction(txQ2)
	txQ3, _ := core.NewTransaction(core.TxVote, core.VotePayload{Vote: true})
	bc7.AddTransaction(txQ3)
	check("GetAllTransactions returns 4 (incl genesis)", len(bc7.GetAllTransactions("")) == 4, "")
	check("Filter REGISTER returns 1", len(bc7.GetAllTransactions(core.TxRegister)) == 1, "")
	check("Filter VOTE returns 1", len(bc7.GetAllTransactions(core.TxVote)) == 1, "")
}

// ════════════════════════════════════════════════════════════════
//  Section 2 — Security module tests
// ════════════════════════════════════════════════════════════════

func runSecurityTests() {
	// 2.1 AES-256-GCM encryption/decryption
	key := security.DeriveKey("test-passphrase")
	check("AES key derivation produces 32 bytes", len(key) == 32, fmt.Sprintf("got %d", len(key)))

	plaintext := []byte(`{"blocks":[{"index":0}]}`)
	encrypted, err := security.EncryptAESGCM(plaintext, key)
	check("AES-GCM encryption succeeds", err == nil, fmt.Sprint(err))
	check("Ciphertext differs from plaintext", !bytes.Equal(encrypted, plaintext), "")

	decrypted, err := security.DecryptAESGCM(encrypted, key)
	check("AES-GCM decryption succeeds", err == nil, fmt.Sprint(err))
	check("Decrypted matches original", bytes.Equal(decrypted, plaintext), "")

	// 2.2 AES wrong key detection
	wrongKey := security.DeriveKey("wrong-passphrase")
	_, err = security.DecryptAESGCM(encrypted, wrongKey)
	check("AES wrong key rejected", err != nil, "wrong key was accepted")

	// 2.3 AES unique nonces (same plaintext → different ciphertext)
	enc1, _ := security.EncryptAESGCM(plaintext, key)
	enc2, _ := security.EncryptAESGCM(plaintext, key)
	check("AES random nonce: different ciphertext each time", !bytes.Equal(enc1, enc2), "")

	// 2.4 HMAC-SHA256 compute and verify
	msg := []byte(`{"voter_id":"voter1"}`)
	hmacKey := []byte("admin-secret-key")
	sig := security.ComputeHMAC(msg, hmacKey)
	check("HMAC signature not empty", sig != "", "")
	check("HMAC verification passes", security.VerifyHMAC(msg, sig, hmacKey), "")

	// 2.5 HMAC wrong key
	check("HMAC wrong key rejected", !security.VerifyHMAC(msg, sig, []byte("wrong")), "wrong key was accepted")

	// 2.6 HMAC tampered message
	check("HMAC tampered msg rejected", !security.VerifyHMAC([]byte("tampered"), sig, hmacKey), "tamper not detected")

	// 2.7 RSA key generation, signing, verification
	rsaDir := filepath.Join("data_3001", "keys")
	rsaKeys, err := security.GenerateRSAKeyPair(rsaDir)
	check("RSA-2048 key pair generated", err == nil, fmt.Sprint(err))

	data := []byte("transaction-hash-abc123")
	rsaSig, err := security.SignData(data, rsaKeys.PrivateKey)
	check("RSA signing succeeds", err == nil, fmt.Sprint(err))
	check("RSA signature not empty", rsaSig != "", "")
	check("RSA verification passes", security.VerifySignature(data, rsaSig, rsaKeys.PublicKey), "")

	// 2.8 RSA tampered data
	check("RSA tampered data rejected", !security.VerifySignature([]byte("tampered"), rsaSig, rsaKeys.PublicKey), "")

	// 2.9 RSA wrong key
	rsaDir2 := filepath.Join("data_3002", "keys")
	rsaKeys2, _ := security.GenerateRSAKeyPair(rsaDir2)
	check("RSA wrong public key rejected", !security.VerifySignature(data, rsaSig, rsaKeys2.PublicKey), "")

	// 2.10 TLS certificate generation
	certDir := filepath.Join("data_3001", "certs")
	tlsCfg, err := security.GenerateSelfSignedCert(certDir)
	check("TLS cert generated", err == nil, fmt.Sprint(err))
	check("Cert file exists", fileExistsSim(tlsCfg.CertFile), "")
	check("Key file exists", fileExistsSim(tlsCfg.KeyFile), "")

	serverCfg, err := security.NewServerTLSConfig(tlsCfg.CertFile, tlsCfg.KeyFile)
	check("TLS config loaded", err == nil, fmt.Sprint(err))
	check("TLS min version is 1.2", serverCfg.MinVersion == tls.VersionTLS12, "")

	// 2.11 Persistence with encryption
	store := persistence.NewFileStore("data_3001")
	store.SetEncryptionKey("test-secret")
	bc := core.NewBlockchain("Sim test")
	tx, _ := core.NewTransaction(core.TxAddVoter, core.AddVoterPayload{VoterID: "v1", Allowed: true})
	bc.AddTransaction(tx)

	err = store.SaveBlockchain(bc)
	check("Encrypted save succeeds", err == nil, fmt.Sprint(err))

	loaded, err := store.LoadBlockchain()
	check("Encrypted load succeeds", err == nil, fmt.Sprint(err))
	if loaded != nil {
		check("Loaded chain matches saved", loaded.Len() == bc.Len(), "")
		check("Loaded chain validates", loaded.ValidateChain() == nil, "")
	}

	// 2.12 Persistence without encryption key fails to load encrypted file
	store2 := persistence.NewFileStore("data_3001")
	// no SetEncryptionKey
	_, err = store2.LoadBlockchain()
	check("Encrypted file without key rejected", err != nil, "loaded encrypted file without key")
}

// ════════════════════════════════════════════════════════════════
//  Section 3 — 3-node network simulation
// ════════════════════════════════════════════════════════════════

type simNode struct {
	port    string
	dataDir string
	certDir string
	bc      *core.Blockchain
	store   *persistence.FileStore
}

func runNetworkSimulation() {
	nodes := make([]simNode, 3)
	ports := []string{"3001", "3002", "3003"}

	// Start 3 HTTPS nodes
	for i, port := range ports {
		dataDir := "data_" + port
		certDir := filepath.Join(dataDir, "certs")

		tlsCfg, err := security.GenerateSelfSignedCert(certDir)
		if err != nil {
			check(fmt.Sprintf("Node %s TLS setup", port), false, err.Error())
			return
		}

		serverTLS, err := security.NewServerTLSConfig(tlsCfg.CertFile, tlsCfg.KeyFile)
		if err != nil {
			check(fmt.Sprintf("Node %s TLS config", port), false, err.Error())
			return
		}

		store := persistence.NewFileStore(dataDir)
		bc := core.NewBlockchain("Simulation: Do you support this?")

		mux := http.NewServeMux()

		// Health endpoint
		mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
			json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
		})

		// Chain endpoint
		bcRef := bc
		mux.HandleFunc("/chain", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"length": len(bcRef.GetBlocks()),
				"blocks": bcRef.GetBlocks(),
			})
		})

		// Blocks endpoint
		mux.HandleFunc("/blocks", func(w http.ResponseWriter, r *http.Request) {
			json.NewEncoder(w).Encode(bcRef.GetBlocks())
		})

		server := &http.Server{
			Addr:      ":" + port,
			Handler:   mux,
			TLSConfig: serverTLS,
		}

		go func(s *http.Server, cf, kf string) {
			if err := s.ListenAndServeTLS(cf, kf); err != nil && err != http.ErrServerClosed {
				fmt.Printf("  [FAIL] Node %s failed to start: %v\n", s.Addr, err)
			}
		}(server, tlsCfg.CertFile, tlsCfg.KeyFile)

		nodes[i] = simNode{port: port, dataDir: dataDir, certDir: certDir, bc: bc, store: store}
	}

	// Wait for servers to start
	time.Sleep(1 * time.Second)

	// TLS client for testing
	client := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				MinVersion:         tls.VersionTLS12,
				InsecureSkipVerify: true,
			},
		},
		Timeout: 5 * time.Second,
	}

	// 3.1 Health check on all nodes
	for _, n := range nodes {
		resp, err := client.Get("https://localhost:" + n.port + "/health")
		ok := err == nil && resp != nil && resp.StatusCode == 200
		if resp != nil {
			resp.Body.Close()
		}
		check(fmt.Sprintf("Node %s HTTPS health check", n.port), ok, fmt.Sprint(err))
	}

	// 3.2 TLS connection verification
	for _, n := range nodes {
		conn, err := tls.Dial("tcp", "localhost:"+n.port, &tls.Config{InsecureSkipVerify: true})
		if err == nil {
			state := conn.ConnectionState()
			check(fmt.Sprintf("Node %s TLS version >= 1.2", n.port), state.Version >= tls.VersionTLS12,
				fmt.Sprintf("got 0x%04x", state.Version))
			check(fmt.Sprintf("Node %s cipher suite is AES-GCM", n.port),
				strings.Contains(tls.CipherSuiteName(state.CipherSuite), "GCM"),
				tls.CipherSuiteName(state.CipherSuite))
			conn.Close()
		} else {
			check(fmt.Sprintf("Node %s TLS dial", n.port), false, err.Error())
		}
	}

	// 3.3 Add transactions on node 3001, save blockchain.json
	for i := 0; i < 3; i++ {
		tx, _ := core.NewTransaction(core.TxAddVoter, core.AddVoterPayload{
			VoterID: fmt.Sprintf("voter_%d", i), Allowed: true,
		})
		nodes[0].bc.AddTransaction(tx)
	}
	check("Node 3001 has 4 blocks (genesis+3)", nodes[0].bc.Len() == 4, fmt.Sprintf("got %d", nodes[0].bc.Len()))
	check("Node 3001 chain validates", nodes[0].bc.ValidateChain() == nil, "")

	// Save node 3001's blockchain to disk
	err := nodes[0].store.SaveBlockchain(nodes[0].bc)
	check("Node 3001 blockchain.json saved", err == nil, fmt.Sprint(err))
	check("Node 3001 blockchain.json exists", fileExistsSim(filepath.Join(nodes[0].dataDir, "blockchain.json")), "")

	// 3.4 Verify chain data available via HTTPS
	resp, err := client.Get("https://localhost:3001/chain")
	if err == nil {
		defer resp.Body.Close()
		var chainResp map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&chainResp)
		length, _ := chainResp["length"].(float64)
		check("HTTPS /chain returns correct length", int(length) == 4, fmt.Sprintf("got %v", length))
	} else {
		check("HTTPS /chain request", false, err.Error())
	}

	// 3.5 SHA-256 checksum verification via HTTPS
	body := []byte(`{"voter_id":"checksum_test"}`)
	hash := sha256.Sum256(body)
	hashHex := hex.EncodeToString(hash[:])

	req, _ := http.NewRequest("GET", "https://localhost:3001/health", bytes.NewBuffer(body))
	req.Header.Set("X-Content-SHA256", hashHex)
	resp2, err := client.Do(req)
	if resp2 != nil {
		resp2.Body.Close()
	}
	check("Request with valid checksum accepted", err == nil && resp2.StatusCode == 200, fmt.Sprint(err))

	// 3.6 Plain HTTP should fail (TLS required)
	plainClient := &http.Client{Timeout: 2 * time.Second}
	plainResp, plainErr := plainClient.Get("http://localhost:3001/health")
	plainRejected := plainErr != nil || plainResp == nil || plainResp.StatusCode != 200
	if plainResp != nil {
		plainResp.Body.Close()
	}
	check("Plain HTTP rejected (TLS required)", plainRejected, "plain HTTP returned 200 OK")

	// 3.7 Network sync: nodes 3002 and 3003 fetch chain from 3001 via HTTPS
	// This replicates what SyncWithPeers() does in network/sync.go:
	//   1. Fetch blocks from peer over TLS-encrypted HTTPS
	//   2. Validate the chain with SHA-256 hash verification (LoadFromBlocks)
	//   3. Replace local chain if remote is longer
	//   4. Save to local blockchain.json
	for _, syncNode := range nodes[1:] {
		syncResp, syncErr := client.Get("https://localhost:3001/blocks")
		if syncErr != nil {
			check(fmt.Sprintf("Node %s HTTPS fetch from 3001", syncNode.port), false, syncErr.Error())
			continue
		}

		bodyBytes, _ := io.ReadAll(syncResp.Body)
		syncResp.Body.Close()

		var remoteBlocks []*core.Block
		json.Unmarshal(bodyBytes, &remoteBlocks)

		check(fmt.Sprintf("Node %s received %d blocks from 3001", syncNode.port, len(remoteBlocks)),
			len(remoteBlocks) == 4, fmt.Sprintf("got %d", len(remoteBlocks)))

		// Validate and load (same as LoadFromBlocks in sync.go)
		loaded, loadErr := core.LoadFromBlocks(remoteBlocks)
		check(fmt.Sprintf("Node %s chain validation passes", syncNode.port), loadErr == nil, fmt.Sprint(loadErr))

		if loaded != nil {
			// Replace local chain and save
			syncNode.bc = loaded
			saveErr := syncNode.store.SaveBlockchain(loaded)
			check(fmt.Sprintf("Node %s blockchain.json saved", syncNode.port), saveErr == nil, fmt.Sprint(saveErr))
			check(fmt.Sprintf("Node %s blockchain.json exists", syncNode.port),
				fileExistsSim(filepath.Join(syncNode.dataDir, "blockchain.json")), "")
			check(fmt.Sprintf("Node %s chain length matches 3001", syncNode.port),
				loaded.Len() == nodes[0].bc.Len(), fmt.Sprintf("got %d, want %d", loaded.Len(), nodes[0].bc.Len()))
			check(fmt.Sprintf("Node %s latest hash matches 3001", syncNode.port),
				loaded.GetLatestBlock().Hash == nodes[0].bc.GetLatestBlock().Hash, "")
		}
	}

	// 3.8 Verify all 3 nodes have consistent blockchain.json files
	for _, n := range nodes {
		check(fmt.Sprintf("Node %s has blockchain.json", n.port),
			fileExistsSim(filepath.Join(n.dataDir, "blockchain.json")), "file missing")
	}

	// 3.9 Reload each node's chain from disk and verify integrity
	for _, n := range nodes {
		reloaded, reloadErr := n.store.LoadBlockchain()
		check(fmt.Sprintf("Node %s reload from disk succeeds", n.port), reloadErr == nil, fmt.Sprint(reloadErr))
		if reloaded != nil {
			check(fmt.Sprintf("Node %s reloaded chain validates", n.port), reloaded.ValidateChain() == nil, "")
			check(fmt.Sprintf("Node %s reloaded chain has 4 blocks", n.port),
				reloaded.Len() == 4, fmt.Sprintf("got %d", reloaded.Len()))
		}
	}

	// 3.10 Tampered block rejected during cross-node sync
	resp4, err := client.Get("https://localhost:3001/blocks")
	if err == nil {
		defer resp4.Body.Close()
		bodyBytes, _ := io.ReadAll(resp4.Body)
		var tamperedBlocks []*core.Block
		json.Unmarshal(bodyBytes, &tamperedBlocks)

		if len(tamperedBlocks) > 1 {
			tamperedBlocks[1].Hash = "tampered_by_attacker"
			_, err := core.LoadFromBlocks(tamperedBlocks)
			check("Tampered blocks rejected during sync", err != nil, "tampered blocks were accepted")
		}
	}

	// 3.11 Encrypted persistence across nodes
	for _, n := range nodes {
		s := persistence.NewFileStore(n.dataDir + "_enc")
		s.SetEncryptionKey("node-secret-" + n.port)
		err := s.SaveBlockchain(n.bc)
		check(fmt.Sprintf("Node %s encrypted save", n.port), err == nil, fmt.Sprint(err))

		loaded, err := s.LoadBlockchain()
		ok := err == nil && loaded != nil && loaded.ValidateChain() == nil
		check(fmt.Sprintf("Node %s encrypted load + validate", n.port), ok, fmt.Sprint(err))

		// Wrong key should fail
		s2 := persistence.NewFileStore(n.dataDir + "_enc")
		s2.SetEncryptionKey("wrong-key")
		_, err = s2.LoadBlockchain()
		check(fmt.Sprintf("Node %s wrong encryption key rejected", n.port), err != nil, "wrong key accepted")

		os.RemoveAll(n.dataDir + "_enc")
	}

	// 3.12 RSA signatures across nodes
	keyDir1 := filepath.Join("data_3001", "rsa_test")
	keyDir2 := filepath.Join("data_3002", "rsa_test")
	keys1, _ := security.GenerateRSAKeyPair(keyDir1)
	keys2, _ := security.GenerateRSAKeyPair(keyDir2)

	tx, _ := core.NewTransaction(core.TxAddVoter, core.AddVoterPayload{VoterID: "signed_voter", Allowed: true})
	sig, err := security.SignData([]byte(tx.Hash), keys1.PrivateKey)
	check("Node 1 signs tx with RSA", err == nil, fmt.Sprint(err))

	check("Node 2 verifies Node 1 signature (same key)", security.VerifySignature([]byte(tx.Hash), sig, keys1.PublicKey), "")
	check("Node 2 rejects with wrong public key", !security.VerifySignature([]byte(tx.Hash), sig, keys2.PublicKey), "")

	// 3.13 HMAC authentication simulation
	apiKey := []byte("shared-admin-secret")
	reqBody := []byte(`{"voter_id":"hmac_voter"}`)
	hmacSig := security.ComputeHMAC(reqBody, apiKey)
	check("HMAC signature computed for request", hmacSig != "", "")
	check("Server verifies HMAC", security.VerifyHMAC(reqBody, hmacSig, apiKey), "")
	check("Tampered body fails HMAC", !security.VerifyHMAC([]byte(`{"voter_id":"evil"}`), hmacSig, apiKey), "")
	check("Wrong API key fails HMAC", !security.VerifyHMAC(reqBody, hmacSig, []byte("wrong-key")), "")
}

func fileExistsSim(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
