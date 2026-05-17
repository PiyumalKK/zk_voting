package security

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
)

// RSAKeyPair holds the RSA key pair used for digital signatures.
//
// RSA (Rivest–Shamir–Adleman) is an ASYMMETRIC encryption algorithm that
// uses a mathematically related key pair:
//
//   - PRIVATE KEY: Kept secret by the admin. Used to CREATE digital signatures.
//     The private key's security relies on the difficulty of factoring the
//     product of two large prime numbers (RSA problem).
//
//   - PUBLIC KEY: Distributed to all nodes. Used to VERIFY digital signatures.
//     Anyone with the public key can verify that a signature was created
//     by the holder of the corresponding private key.
//
// This key pair provides three security properties for admin transactions:
//   1. AUTHENTICATION: Only the admin (private key holder) can sign transactions
//   2. INTEGRITY: Any modification to a signed transaction invalidates the signature
//   3. NON-REPUDIATION: The admin cannot deny having created a signed transaction
type RSAKeyPair struct {
	PrivateKey  *rsa.PrivateKey
	PublicKey   *rsa.PublicKey
	PrivKeyFile string
	PubKeyFile  string
}

// GenerateRSAKeyPair generates or loads an RSA-2048 key pair from the specified directory.
//
// RSA-2048 key generation process:
//   1. Two large random prime numbers (p, q) are generated (~1024 bits each)
//   2. The modulus n = p × q is computed (2048 bits)
//   3. The public exponent e = 65537 is chosen (standard value)
//   4. The private exponent d is computed such that e × d ≡ 1 (mod φ(n))
//   5. The public key is (n, e), the private key is (n, d)
//
// The security of RSA relies on the computational difficulty of factoring n
// back into p and q. With 2048-bit keys, this is considered infeasible with
// current technology (estimated to require 2^112 operations).
//
// If keys already exist in the directory, they are loaded instead of regenerated.
func GenerateRSAKeyPair(keyDir string) (*RSAKeyPair, error) {
	privKeyFile := filepath.Join(keyDir, "admin_private.pem")
	pubKeyFile := filepath.Join(keyDir, "admin_public.pem")

	// Check if keys already exist — load them if so
	if _, err := os.Stat(privKeyFile); err == nil {
		return LoadRSAKeyPair(privKeyFile, pubKeyFile)
	}

	// Create the key directory
	if err := os.MkdirAll(keyDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create key directory: %w", err)
	}

	// Generate a new RSA-2048 private key using crypto/rand
	// (cryptographically secure random number generator)
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, fmt.Errorf("failed to generate RSA key pair: %w", err)
	}

	// ── Save Private Key (PEM format, restricted permissions) ─────────
	// The private key is serialized in PKCS#1 DER format, then wrapped
	// in a PEM block for human-readable storage.
	// File permissions 0600 = owner read/write only — CRITICAL for security
	privBytes := x509.MarshalPKCS1PrivateKey(privateKey)
	privPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: privBytes,
	})
	if err := os.WriteFile(privKeyFile, privPEM, 0600); err != nil {
		return nil, fmt.Errorf("failed to save private key: %w", err)
	}

	// ── Save Public Key (PEM format, readable by all nodes) ──────────
	// The public key is serialized in PKIX DER format.
	// File permissions 0644 = readable by anyone (public key is NOT secret)
	pubBytes, err := x509.MarshalPKIXPublicKey(&privateKey.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal public key: %w", err)
	}
	pubPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PUBLIC KEY",
		Bytes: pubBytes,
	})
	if err := os.WriteFile(pubKeyFile, pubPEM, 0644); err != nil {
		return nil, fmt.Errorf("failed to save public key: %w", err)
	}

	fmt.Println("🔏 RSA: Generated new 2048-bit key pair for admin digital signatures")

	return &RSAKeyPair{
		PrivateKey:  privateKey,
		PublicKey:   &privateKey.PublicKey,
		PrivKeyFile: privKeyFile,
		PubKeyFile:  pubKeyFile,
	}, nil
}

// LoadRSAKeyPair loads an existing RSA key pair from PEM files.
func LoadRSAKeyPair(privFile, pubFile string) (*RSAKeyPair, error) {
	// Load and parse private key
	privPEM, err := os.ReadFile(privFile)
	if err != nil {
		return nil, fmt.Errorf("failed to read private key: %w", err)
	}
	privBlock, _ := pem.Decode(privPEM)
	if privBlock == nil {
		return nil, fmt.Errorf("failed to decode private key PEM")
	}
	privateKey, err := x509.ParsePKCS1PrivateKey(privBlock.Bytes)
	if err != nil {
		return nil, fmt.Errorf("failed to parse private key: %w", err)
	}

	// Load and parse public key
	pubPEM, err := os.ReadFile(pubFile)
	if err != nil {
		return nil, fmt.Errorf("failed to read public key: %w", err)
	}
	pubBlock, _ := pem.Decode(pubPEM)
	if pubBlock == nil {
		return nil, fmt.Errorf("failed to decode public key PEM")
	}
	pubKeyInterface, err := x509.ParsePKIXPublicKey(pubBlock.Bytes)
	if err != nil {
		return nil, fmt.Errorf("failed to parse public key: %w", err)
	}
	publicKey, ok := pubKeyInterface.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("public key is not RSA")
	}

	fmt.Println("🔏 RSA: Loaded existing admin key pair from", privFile)

	return &RSAKeyPair{
		PrivateKey:  privateKey,
		PublicKey:   publicKey,
		PrivKeyFile: privFile,
		PubKeyFile:  pubFile,
	}, nil
}

// SignData creates a digital signature of data using the admin's RSA private key.
//
// How RSA digital signing works:
//
//   1. HASH: The data is first hashed with SHA-256 to produce a fixed-size
//      32-byte digest. This ensures the signature covers ALL of the data
//      regardless of its size.
//
//   2. SIGN: The SHA-256 hash is encrypted with the admin's RSA private key
//      using PKCS#1 v1.5 padding. This produces a 256-byte (2048-bit) signature.
//
//      Mathematically: signature = hash^d mod n
//      (where d is the private exponent, n is the modulus)
//
//   3. ENCODE: The raw signature bytes are hex-encoded for safe storage
//      in the JSON transaction structure.
//
// Only the private key holder (admin) can create a valid signature.
//
// Parameters:
//   - data:       The raw bytes to sign (e.g., transaction hash)
//   - privateKey: The admin's RSA private key
//
// Returns: Hex-encoded RSA signature string
func SignData(data []byte, privateKey *rsa.PrivateKey) (string, error) {
	// Step 1: Hash the data with SHA-256 (produces 32-byte digest)
	hash := sha256.Sum256(data)

	// Step 2: Sign the hash with the RSA private key (PKCS#1 v1.5 scheme)
	signature, err := rsa.SignPKCS1v15(rand.Reader, privateKey, crypto.SHA256, hash[:])
	if err != nil {
		return "", fmt.Errorf("RSA signing failed: %w", err)
	}

	// Step 3: Hex-encode the signature for JSON storage
	return hex.EncodeToString(signature), nil
}

// VerifySignature verifies an RSA digital signature against the original data.
//
// How RSA signature verification works:
//
//   1. DECODE: The hex-encoded signature is decoded to raw bytes.
//
//   2. HASH: The original data is hashed with SHA-256 to produce the
//      expected digest.
//
//   3. VERIFY: The signature is decrypted using the RSA public key:
//      decrypted = signature^e mod n
//      (where e is the public exponent, n is the modulus)
//
//      The decrypted value is compared to the SHA-256 hash.
//      If they match, the signature is VALID.
//
// This proves:
//   - AUTHENTICITY: The data was signed by the private key holder (admin)
//   - INTEGRITY: The data has not been modified since it was signed
//   - NON-REPUDIATION: The signer cannot deny having signed the data
//
// Parameters:
//   - data:         The original data that was signed
//   - signatureHex: The hex-encoded RSA signature to verify
//   - publicKey:    The admin's RSA public key
//
// Returns: true if the signature is valid
func VerifySignature(data []byte, signatureHex string, publicKey *rsa.PublicKey) bool {
	// Decode hex signature to raw bytes
	signature, err := hex.DecodeString(signatureHex)
	if err != nil {
		return false
	}

	// Hash the original data with SHA-256
	hash := sha256.Sum256(data)

	// Verify: decrypt signature with public key and compare to hash
	err = rsa.VerifyPKCS1v15(publicKey, crypto.SHA256, hash[:], signature)
	return err == nil
}
