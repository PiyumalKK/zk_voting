package p2p

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
)

// mTLS is the only authentication on the P2P port. There is no token, no
// signature over the block payload, no allowlist of peer addresses: a
// connection is authorised if and only if both ends present a certificate
// signed by the cluster CA (certgen.go). Everything reachable on that port —
// pushing a block into a replica's chain, reading the primary's history — is
// therefore gated on membership of the cluster.
//
// That is a smaller claim than it sounds, and worth being precise about in
// the report: mTLS proves *who is connected*, not *that a block is honest*.
// A compromised primary holds a valid certificate. The property that
// survives it is the one in internal/chain/follow.go — every replica
// re-executes every block — and mTLS's job is only to keep strangers off the
// port.
//
// This file was salvaged from the v1 node (MASTER §3, "salvage guide") and
// rewritten. The v1 version had three problems worth naming, since each was
// a real weakness rather than a style preference:
//
//   - It ignored the result of AppendCertsFromPEM, so an unreadable or empty
//     CA file produced an *empty trust pool* rather than an error. A server
//     built on it would reject every peer, and a client would reject every
//     server, with a handshake error naming neither the file nor the cause.
//   - It set no MinVersion, leaving the floor at Go's default TLS 1.2 with
//     the legacy cipher suites that implies, for a link where both ends are
//     this same binary.
//   - It returned one config used for both roles. A client config with
//     ClientAuth: RequireAndVerifyClientCert set is not wrong, merely
//     meaningless, and conflating the two directions is how the
//     "certificate is valid for server auth but not client auth" class of
//     bug goes unnoticed until the first push fails.

// ServerTLSConfig builds the TLS configuration for a node's P2P listener:
// present certFile/keyFile, and demand a certificate signed by caFile from
// every client that connects.
func ServerTLSConfig(certFile, keyFile, caFile string) (*tls.Config, error) {
	cert, pool, err := loadMaterial(certFile, keyFile, caFile)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		ClientCAs:    pool,
		// RequireAndVerify, not VerifyIfGiven: a client that presents no
		// certificate must be refused, not treated as anonymous.
		ClientAuth: tls.RequireAndVerifyClientCert,
		MinVersion: tls.VersionTLS13,
	}, nil
}

// ClientTLSConfig builds the TLS configuration a node uses when dialling a
// peer: present certFile/keyFile, and verify the peer's certificate against
// caFile.
//
// InsecureSkipVerify is deliberately absent and must stay absent. The
// certificates certgen.go issues carry localhost and 127.0.0.1 as subject
// alternative names precisely so that hostname verification can stay on for
// a local cluster.
func ClientTLSConfig(certFile, keyFile, caFile string) (*tls.Config, error) {
	cert, pool, err := loadMaterial(certFile, keyFile, caFile)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		RootCAs:      pool,
		MinVersion:   tls.VersionTLS13,
	}, nil
}

// loadMaterial reads the node's key pair and the CA certificate pool shared
// by both roles, failing with a message that names the offending file.
func loadMaterial(certFile, keyFile, caFile string) (tls.Certificate, *x509.CertPool, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return tls.Certificate{}, nil, fmt.Errorf("load key pair (%s / %s): %w", certFile, keyFile, err)
	}

	caPEM, err := os.ReadFile(caFile)
	if err != nil {
		return tls.Certificate{}, nil, fmt.Errorf("read CA certificate %s: %w", caFile, err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return tls.Certificate{}, nil, fmt.Errorf("CA certificate %s contains no usable PEM certificate", caFile)
	}

	return cert, pool, nil
}
