package security

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

// TLSConfig holds paths to the TLS certificate and private key files.
type TLSConfig struct {
	CertFile string // Path to the PEM-encoded X.509 certificate
	KeyFile  string // Path to the PEM-encoded ECDSA private key
}

// GenerateSelfSignedCert creates a self-signed TLS certificate and ECDSA
// private key for development use. The certificate is valid for localhost
// and common loopback addresses (127.0.0.1, ::1).
//
// Security details:
//   - Uses ECDSA with the P-256 (secp256r1) elliptic curve for the key pair.
//     ECDSA P-256 provides 128-bit security — equivalent to RSA-3072 — but
//     with much smaller key sizes and faster operations.
//   - The certificate is self-signed: the same key pair acts as both the
//     Certificate Authority (CA) and the server identity.
//   - Valid for 1 year from the time of generation.
//   - Supports both TLS server and client authentication (for mutual TLS).
//
// If certificate files already exist in the given directory, they are reused
// without regeneration to avoid invalidating connected peers.
func GenerateSelfSignedCert(certDir string) (*TLSConfig, error) {
	// Create certificate directory with restricted permissions (owner-only)
	if err := os.MkdirAll(certDir, 0700); err != nil {
		return nil, fmt.Errorf("failed to create cert directory: %w", err)
	}

	certFile := filepath.Join(certDir, "server.crt")
	keyFile := filepath.Join(certDir, "server.key")

	// Reuse existing certificates if both files are present
	if fileExists(certFile) && fileExists(keyFile) {
		fmt.Println("🔐 TLS: Reusing existing certificate from", certDir)
		return &TLSConfig{CertFile: certFile, KeyFile: keyFile}, nil
	}

	fmt.Println("🔐 TLS: Generating new self-signed certificate...")

	// ── Step 1: Generate ECDSA Private Key ──────────────────────────────
	// ECDSA (Elliptic Curve Digital Signature Algorithm) is an asymmetric
	// encryption algorithm. The private key is kept secret on this node,
	// while the public key is embedded in the certificate and shared with
	// connecting clients and peers.
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("failed to generate ECDSA private key: %w", err)
	}

	// ── Step 2: Generate a Cryptographically Random Serial Number ───────
	// X.509 certificates require a unique serial number. We generate a
	// 128-bit random value using crypto/rand (cryptographically secure
	// random number generator) to ensure uniqueness.
	serialNumber, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, fmt.Errorf("failed to generate serial number: %w", err)
	}

	// ── Step 3: Create X.509 Certificate Template ───────────────────────
	// The certificate template defines the identity and capabilities of
	// the certificate. Key fields:
	//   - Subject:    Identifies the certificate owner
	//   - KeyUsage:   Allows digital signatures and key encipherment
	//                 (both needed for TLS handshake)
	//   - ExtKeyUsage: Permits both server and client authentication
	//                  (enables mutual TLS between peer nodes)
	//   - DNSNames & IPAddresses: The hostnames/IPs this cert is valid for
	template := x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			Organization: []string{"ZK Voting Blockchain"},
			CommonName:   "localhost",
		},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().Add(365 * 24 * time.Hour), // 1 year validity
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true,
		// Valid for localhost connections (development environment)
		DNSNames:    []string{"localhost"},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	}

	// ── Step 4: Self-Sign the Certificate ───────────────────────────────
	// x509.CreateCertificate signs the certificate using the private key.
	// Since we pass the same template as both the "template" and "parent",
	// this creates a self-signed certificate (the certificate is its own CA).
	// The signing process:
	//   1. The certificate data is serialized to DER (binary) format
	//   2. A SHA-256 hash of the data is computed
	//   3. The hash is signed with the ECDSA private key
	//   4. The signature is appended to the certificate
	certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &privateKey.PublicKey, privateKey)
	if err != nil {
		return nil, fmt.Errorf("failed to create certificate: %w", err)
	}

	// ── Step 5: Write Certificate to PEM File ───────────────────────────
	// PEM (Privacy-Enhanced Mail) is a Base64-encoded format for storing
	// cryptographic objects. The certificate contains the public key and
	// identity information — this file can be shared freely.
	certOut, err := os.Create(certFile)
	if err != nil {
		return nil, fmt.Errorf("failed to create cert file: %w", err)
	}
	defer certOut.Close()

	if err := pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: certDER}); err != nil {
		return nil, fmt.Errorf("failed to write certificate PEM: %w", err)
	}

	// ── Step 6: Write Private Key to PEM File ───────────────────────────
	// The private key file has restricted permissions (0600 = owner read/write
	// only) because anyone with this key can impersonate the server.
	// This is the SECRET part of the asymmetric key pair.
	keyOut, err := os.OpenFile(keyFile, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return nil, fmt.Errorf("failed to create key file: %w", err)
	}
	defer keyOut.Close()

	keyBytes, err := x509.MarshalECPrivateKey(privateKey)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal ECDSA private key: %w", err)
	}

	if err := pem.Encode(keyOut, &pem.Block{Type: "EC PRIVATE KEY", Bytes: keyBytes}); err != nil {
		return nil, fmt.Errorf("failed to write private key PEM: %w", err)
	}

	fmt.Println("🔐 TLS: Certificate generated successfully")
	fmt.Printf("   📄 Certificate: %s\n", certFile)
	fmt.Printf("   🔑 Private Key: %s\n", keyFile)

	return &TLSConfig{CertFile: certFile, KeyFile: keyFile}, nil
}

// NewServerTLSConfig loads the TLS certificate and private key, and returns
// a tls.Config configured with modern security settings for the HTTPS server.
//
// TLS (Transport Layer Security) protocol overview:
//   1. Client connects and sends a "ClientHello" with supported cipher suites
//   2. Server responds with its certificate (containing the public key)
//   3. Client verifies the certificate and generates a pre-master secret
//   4. The pre-master secret is encrypted with the server's PUBLIC key
//      (asymmetric encryption) and sent to the server
//   5. Server decrypts it with its PRIVATE key
//   6. Both sides derive the same symmetric session key from the pre-master secret
//   7. All subsequent data is encrypted with AES (symmetric encryption)
//      using the shared session key — this is much faster than asymmetric encryption
//
// This function enforces:
//   - Minimum TLS 1.2 (disables insecure TLS 1.0 and 1.1)
//   - Only AEAD cipher suites (AES-GCM) which provide both encryption
//     and integrity verification in a single operation
func NewServerTLSConfig(certFile, keyFile string) (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("failed to load TLS key pair: %w", err)
	}

	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
		// Preferred cipher suites using AES-GCM (Authenticated Encryption)
		// ECDHE = Elliptic Curve Diffie-Hellman Ephemeral (provides forward secrecy)
		// AES_256_GCM = AES-256 in Galois/Counter Mode (symmetric encryption + integrity)
		// SHA384/SHA256 = Hash function used for the HMAC in the TLS record layer
		CipherSuites: []uint16{
			tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
		},
	}, nil
}

// fileExists checks whether a file exists at the given path.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
