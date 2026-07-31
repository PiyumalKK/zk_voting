package rpc

import (
	"bytes"
	"crypto/ecdsa"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"

	"zk-blockchain/internal/chain"
	"zk-blockchain/internal/config"
	"zk-blockchain/internal/state"
	"zk-blockchain/internal/storage"
)

// testChainID matches internal/chain's own test suite so error messages and
// intuition transfer directly between the two packages' tests.
const testChainID = 9494

// testAccount0PrivateKeyHex is Hardhat's well-known default test account #0
// private key (0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266) — the same
// genesis-prefunded account internal/chain's own tests use (see
// internal/chain/sequencer_test.go's identical constant). Not a secret.
const testAccount0PrivateKeyHex = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

func mustTestKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	b, err := hex.DecodeString(testAccount0PrivateKeyHex)
	if err != nil {
		t.Fatalf("decode test private key: %v", err)
	}
	key, err := crypto.ToECDSA(b)
	if err != nil {
		t.Fatalf("ToECDSA: %v", err)
	}
	return key
}

// newTestSequencer opens a fresh temp-dir chain database, ensures genesis,
// and returns a ready-to-use Sequencer — mirroring
// internal/chain/sequencer_test.go's own helper of the same name, kept as a
// separate copy since it's unexported in that package.
func newTestSequencer(t *testing.T) *chain.Sequencer {
	t.Helper()
	db, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	cfg := &config.Config{ChainID: testChainID, BlockGasLimit: 60_000_000}
	if _, err := state.EnsureGenesis(db, cfg); err != nil {
		t.Fatalf("EnsureGenesis: %v", err)
	}

	chainCfg := state.ChainConfig(cfg.ChainID)
	return chain.New(db, chainCfg, cfg.BlockGasLimit)
}

// deployContract submits a contract-creation tx for runtime and fails the
// test if it doesn't succeed, returning the deployed address.
func deployContract(t *testing.T, seq *chain.Sequencer, key *ecdsa.PrivateKey, chainID *big.Int, nonce uint64, runtime []byte) common.Address {
	t.Helper()
	tx := mustSignLegacyTx(t, key, chainID, nonce, nil, big.NewInt(0), 500_000, buildInitCode(runtime))
	receipt, err := seq.SubmitTx(tx)
	if err != nil {
		t.Fatalf("deploy SubmitTx: %v", err)
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		t.Fatalf("deploy failed, status = %d", receipt.Status)
	}
	return receipt.ContractAddress
}

func mustSignLegacyTx(t *testing.T, key *ecdsa.PrivateKey, chainID *big.Int, nonce uint64, to *common.Address, value *big.Int, gas uint64, data []byte) *types.Transaction {
	t.Helper()
	tx := types.NewTx(&types.LegacyTx{
		Nonce:    nonce,
		To:       to,
		Value:    value,
		Gas:      gas,
		GasPrice: big.NewInt(0),
		Data:     data,
	})
	signer := types.LatestSignerForChainID(chainID)
	signed, err := types.SignTx(tx, signer, key)
	if err != nil {
		t.Fatalf("SignTx: %v", err)
	}
	return signed
}

// newTestMux builds the full HTTP handler (JSON-RPC + health, all
// middleware included) over a fresh Sequencer, wide-open CORS and a
// generous rate limit so most tests don't need to think about either.
func newTestMux(t *testing.T, seq *chain.Sequencer) http.Handler {
	t.Helper()
	rpcServer, err := NewJSONRPCServer(seq, testChainID)
	if err != nil {
		t.Fatalf("NewJSONRPCServer: %v", err)
	}
	t.Cleanup(rpcServer.Stop)

	health := NewHealthHandler(testChainID, "primary", nil)
	return NewMux(health, rpcServer, MuxConfig{
		CORSOrigins:    []string{"*"},
		RateLimitRPS:   1000,
		RateLimitBurst: 1000,
	})
}

// rpcRequest is a minimal JSON-RPC 2.0 request envelope for tests.
type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

// rpcResponse is a minimal JSON-RPC 2.0 response envelope for tests. Result
// is left as json.RawMessage so each test decodes it into whatever concrete
// type it expects.
type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *rpcError       `json:"error"`
}

type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

// callRPC POSTs a single JSON-RPC request against handler and decodes the
// single-object response. remoteAddr defaults to a non-loopback test IP so
// rate-limiting tests can opt into being subject to the limiter; pass
// "127.0.0.1:12345" explicitly to exercise the loopback-exempt path.
func callRPC(t *testing.T, handler http.Handler, remoteAddr, method string, params ...any) (*httptest.ResponseRecorder, rpcResponse) {
	t.Helper()
	if params == nil {
		params = []any{}
	}
	body, err := json.Marshal(rpcRequest{JSONRPC: "2.0", ID: 1, Method: method, Params: params})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if remoteAddr != "" {
		req.RemoteAddr = remoteAddr
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// Decode whatever body came back regardless of HTTP status: JSON-RPC
	// protocol-level errors (unknown method, invalid params, revert) are
	// expected to arrive as a 200 with an `error` object in the body — the
	// same convention every JSON-RPC client (viem included) relies on — but
	// this helper doesn't hard-code that assumption; callers that care can
	// still inspect the returned *httptest.ResponseRecorder's status
	// directly. An empty body (e.g. a 405 from a wrong HTTP method) is left
	// as a zero-value rpcResponse rather than failing the test here.
	var resp rpcResponse
	if rec.Body.Len() > 0 {
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("response is not valid JSON-RPC: %v (status %d, body: %s)", err, rec.Code, rec.Body.String())
		}
	}
	return rec, resp
}
