package p2p

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/core/types"

	"zk-blockchain/internal/chain"
	"zk-blockchain/internal/config"
	"zk-blockchain/internal/state"
	"zk-blockchain/internal/storage"
)

// testChainID matches the chain's default (MASTER §7). Nothing here depends
// on the value; it only has to be the same on both nodes of a test, which is
// the same constraint a real cluster has.
const testChainID = 9494

// newChain builds a real, empty, genesis-initialised chain in a temp
// directory.
//
// These tests use real chains rather than fakes on purpose. The behaviour
// under test is "does a replica end up with the primary's chain", and a fake
// applier that always says yes would pass every test in this package while
// the actual node failed. The cost is a few hundred milliseconds of Pebble
// setup per test.
func newChain(t *testing.T) *chain.Sequencer {
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
	return chain.New(db, state.ChainConfig(cfg.ChainID), cfg.BlockGasLimit)
}

// mineBlocks seals n empty blocks on seq and returns them.
func mineBlocks(t *testing.T, seq *chain.Sequencer, n int) []*types.Block {
	t.Helper()

	blocks := make([]*types.Block, 0, n)
	for i := 0; i < n; i++ {
		block, err := seq.MineEmptyBlock()
		if err != nil {
			t.Fatalf("MineEmptyBlock #%d: %v", i+1, err)
		}
		blocks = append(blocks, block)
	}
	return blocks
}

// chainHeight returns seq's current head number.
func chainHeight(t *testing.T, seq *chain.Sequencer) uint64 {
	t.Helper()
	n, _, err := seq.HeadInfo()
	if err != nil {
		t.Fatalf("HeadInfo: %v", err)
	}
	return n
}

// waitFor polls cond until it holds or the deadline passes. Used instead of
// a sleep for the asynchronous paths (pushes, catch-up loops), so a slow
// machine is tolerated and a fast one is not waited on.
func waitFor(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out after %s waiting for %s", timeout, what)
}

// Shared fixtures for this package's tests. Everything here builds *real*
// material and runs *real* TLS: the certificates come from certgen.go and
// the servers are ordinary net/http servers behind a tls.Listener, so a test
// that passes proves the same code path a running cluster uses. Faking the
// transport would leave the one thing most likely to be misconfigured —
// mutual authentication — untested.

// certSet is a generated CA plus the node certificates signed by it.
type certSet struct {
	dir string
}

// newCertSet generates a CA and a certificate for each named node into a
// temp directory that is removed at the end of the test.
func newCertSet(t *testing.T, nodes ...string) certSet {
	t.Helper()
	dir := t.TempDir()
	if err := GenerateCluster(dir, nodes, nil, time.Hour); err != nil {
		t.Fatalf("GenerateCluster(%v): %v", nodes, err)
	}
	return certSet{dir: dir}
}

func (c certSet) caPath() string { return filepath.Join(c.dir, "ca.crt") }

func (c certSet) paths(node string) (certFile, keyFile string) {
	return filepath.Join(c.dir, node+".crt"), filepath.Join(c.dir, node+".key")
}

func (c certSet) serverConfig(t *testing.T, node string) *tls.Config {
	t.Helper()
	certFile, keyFile := c.paths(node)
	cfg, err := ServerTLSConfig(certFile, keyFile, c.caPath())
	if err != nil {
		t.Fatalf("ServerTLSConfig(%s): %v", node, err)
	}
	return cfg
}

func (c certSet) clientConfig(t *testing.T, node string) *tls.Config {
	t.Helper()
	certFile, keyFile := c.paths(node)
	cfg, err := ClientTLSConfig(certFile, keyFile, c.caPath())
	if err != nil {
		t.Fatalf("ClientTLSConfig(%s): %v", node, err)
	}
	return cfg
}

// serveTLS starts handler on a loopback port with the given server TLS
// configuration and returns its base URL. The server is shut down when the
// test ends.
func serveTLS(t *testing.T, tlsCfg *tls.Config, handler http.Handler) string {
	t.Helper()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		// tls.NewListener rather than ListenAndServeTLS so the port is known
		// before the server starts and the test never races it.
		if err := server.Serve(tls.NewListener(ln, tlsCfg)); err != nil && !errors.Is(err, http.ErrServerClosed) {
			// Not t.Fatalf: this runs on a goroutine, where Fatalf is not
			// allowed. A serve failure surfaces as the request failing.
			t.Logf("test server stopped: %v", err)
		}
	}()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	})

	return "https://" + ln.Addr().String()
}
