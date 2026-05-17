package network

import (
	"crypto/tls"
	"net/http"
	"time"
)

// secureClient is the package-level TLS-configured HTTP client used for
// all peer-to-peer communication (block broadcasting and chain syncing).
//
// This replaces the default http.Client / http.Get / http.Post which use
// plain unencrypted HTTP. With this client, all P2P traffic is encrypted
// using TLS, preventing:
//   - Eavesdropping:  Attackers cannot read block data or votes in transit
//   - Tampering:      TLS integrity checks detect any modification to messages
//   - Replay attacks: TLS session keys are unique per connection
var secureClient *http.Client

// init initialises the secure HTTP client when the package is first loaded.
// This ensures the TLS client is available before any P2P calls are made.
func init() {
	secureClient = newTLSClient()
}

// newTLSClient creates an HTTP client configured for TLS-encrypted
// communication with peer blockchain nodes.
//
// TLS Configuration Details:
//   - MinVersion TLS 1.2: Disables the insecure TLS 1.0 and 1.1 protocols
//     which have known vulnerabilities (POODLE, BEAST attacks).
//   - InsecureSkipVerify: Set to true for development with self-signed
//     certificates. In production, this should be false and the CA
//     certificate should be loaded into a custom certificate pool.
//
// How TLS protects P2P communication:
//   1. When this client connects to a peer, a TLS handshake occurs
//   2. The peer presents its TLS certificate (containing its public key)
//   3. A symmetric session key is negotiated using Diffie-Hellman key exchange
//   4. All subsequent data (blocks, chain data) is encrypted with AES
//      using the negotiated session key (symmetric encryption)
//   5. Each message includes a MAC (Message Authentication Code) computed
//      with SHA-256 to verify integrity
func newTLSClient() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				MinVersion: tls.VersionTLS12,
				// InsecureSkipVerify is true because we use self-signed certificates
				// in development. For production, set this to false and configure
				// a proper CA certificate pool:
				//
				//   caCertPool := x509.NewCertPool()
				//   caCertPool.AppendCertsFromPEM(caCert)
				//   RootCAs: caCertPool,
				//   InsecureSkipVerify: false,
				InsecureSkipVerify: true,
			},
		},
		// Timeout prevents hanging connections from blocking the node
		Timeout: 10 * time.Second,
	}
}

// GetSecureClient returns the package-level TLS-configured HTTP client.
// This can be used by other packages that need to make secure peer requests.
func GetSecureClient() *http.Client {
	return secureClient
}
