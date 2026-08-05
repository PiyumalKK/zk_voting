package p2p

import (
	"crypto/x509"
	"encoding/pem"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestGenerateClusterWritesUsableMaterial(t *testing.T) {
	dir := t.TempDir()
	if err := GenerateCluster(dir, []string{"primary", "replica1"}, nil, time.Hour); err != nil {
		t.Fatalf("GenerateCluster: %v", err)
	}

	for _, name := range []string{"ca.crt", "ca.key", "primary.crt", "primary.key", "replica1.crt", "replica1.key"} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("expected %s: %v", name, err)
		}
		if info.Size() == 0 {
			t.Errorf("%s is empty", name)
		}
	}

	// Reloading must produce the same authority — `cmd/gencerts` issuing a
	// certificate for a node added later depends on it.
	ca, err := LoadCA(filepath.Join(dir, "ca.crt"), filepath.Join(dir, "ca.key"))
	if err != nil {
		t.Fatalf("LoadCA: %v", err)
	}
	if !ca.Certificate.IsCA {
		t.Error("reloaded certificate is not a CA")
	}

	certPEM, _, err := ca.IssueNode("replica2", []string{"localhost", "127.0.0.1"}, time.Hour)
	if err != nil {
		t.Fatalf("IssueNode: %v", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca.CertPEM) {
		t.Fatal("the reloaded CA PEM is not usable as a trust root")
	}
	leaf := parseFirstCertificate(t, certPEM)
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: pool, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny}}); err != nil {
		t.Errorf("certificate issued by the reloaded CA does not verify against it: %v", err)
	}
}

// TestNodeCertificatesAreValidForBothDirections is the mistake this
// generator exists to prevent. Every node is a server (serving catch-up
// pulls) and a client (pushing blocks), so a certificate issued for only one
// of those usages works in one direction and fails in the other — a
// confusing partial outage rather than an obvious misconfiguration.
func TestNodeCertificatesAreValidForBothDirections(t *testing.T) {
	certs := newCertSet(t, "primary")
	certFile, _ := certs.paths("primary")

	pemBytes, err := os.ReadFile(certFile)
	if err != nil {
		t.Fatalf("read certificate: %v", err)
	}
	leaf := parseFirstCertificate(t, pemBytes)

	var server, client bool
	for _, usage := range leaf.ExtKeyUsage {
		switch usage {
		case x509.ExtKeyUsageServerAuth:
			server = true
		case x509.ExtKeyUsageClientAuth:
			client = true
		}
	}
	if !server || !client {
		t.Errorf("ExtKeyUsage = %v, want both server and client auth", leaf.ExtKeyUsage)
	}
}

// TestMutualTLSAcceptsAClusterMember completes a real handshake in the exact
// composition the node uses: ServerTLSConfig on the listener,
// ClientTLSConfig on the dialler, certificates from GenerateCluster.
func TestMutualTLSAcceptsAClusterMember(t *testing.T) {
	certs := newCertSet(t, "primary", "replica1")

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ok")
	})
	url := serveTLS(t, certs.serverConfig(t, "primary"), handler)

	client := &http.Client{
		Transport: &http.Transport{TLSClientConfig: certs.clientConfig(t, "replica1")},
		Timeout:   5 * time.Second,
	}
	resp, err := client.Get(url)
	if err != nil {
		t.Fatalf("cluster member was refused: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if string(body) != "ok" {
		t.Errorf("body = %q, want %q", body, "ok")
	}
}

// TestMutualTLSRejectsAForeignCertificate is M10's "bad cert" case: a node
// holding a well-formed certificate from an authority this cluster does not
// trust gets no further than the handshake. Membership of the cluster *is*
// possession of a certificate signed by its CA.
func TestMutualTLSRejectsAForeignCertificate(t *testing.T) {
	ours := newCertSet(t, "primary")
	theirs := newCertSet(t, "intruder")

	url := serveTLS(t, ours.serverConfig(t, "primary"), http.NotFoundHandler())

	client := &http.Client{
		Transport: &http.Transport{TLSClientConfig: theirs.clientConfig(t, "intruder")},
		Timeout:   5 * time.Second,
	}
	resp, err := client.Get(url)
	if err == nil {
		_ = resp.Body.Close()
		t.Fatal("a certificate from a foreign CA was accepted")
	}
}

// TestMutualTLSRejectsAnAnonymousClient: RequireAndVerifyClientCert, not
// VerifyClientCertIfGiven. A client that presents nothing must be refused,
// not treated as an unauthenticated visitor — the P2P port has no read-only
// tier.
func TestMutualTLSRejectsAnAnonymousClient(t *testing.T) {
	certs := newCertSet(t, "primary")
	url := serveTLS(t, certs.serverConfig(t, "primary"), http.NotFoundHandler())

	// Trusts the server, presents no certificate of its own.
	anonymous := certs.clientConfig(t, "primary")
	anonymous.Certificates = nil

	client := &http.Client{
		Transport: &http.Transport{TLSClientConfig: anonymous},
		Timeout:   5 * time.Second,
	}
	resp, err := client.Get(url)
	if err == nil {
		_ = resp.Body.Close()
		t.Fatal("a client with no certificate was accepted")
	}
}

// TestTLSConfigReportsAnUnusableCAFile covers the v1 bug this file's header
// comment describes: AppendCertsFromPEM's result was ignored, so a CA file
// that was missing, empty or not PEM produced an empty trust pool and a
// handshake failure at some later point, naming neither the file nor the
// cause.
func TestTLSConfigReportsAnUnusableCAFile(t *testing.T) {
	certs := newCertSet(t, "primary")
	certFile, keyFile := certs.paths("primary")

	junk := filepath.Join(t.TempDir(), "not-a-ca.crt")
	if err := os.WriteFile(junk, []byte("this is not a certificate\n"), 0o644); err != nil {
		t.Fatalf("write junk CA: %v", err)
	}

	if _, err := ServerTLSConfig(certFile, keyFile, junk); err == nil {
		t.Error("ServerTLSConfig accepted a CA file containing no certificate")
	}
	if _, err := ClientTLSConfig(certFile, keyFile, junk); err == nil {
		t.Error("ClientTLSConfig accepted a CA file containing no certificate")
	}
	if _, err := ServerTLSConfig(certFile, keyFile, filepath.Join(t.TempDir(), "absent.crt")); err == nil {
		t.Error("ServerTLSConfig accepted a CA path that does not exist")
	}
}

func parseFirstCertificate(t *testing.T, pemBytes []byte) *x509.Certificate {
	t.Helper()
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		t.Fatal("no PEM block found")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("parse certificate: %v", err)
	}
	return cert
}
