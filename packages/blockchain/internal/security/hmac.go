package security

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
)

// ComputeHMAC generates an HMAC-SHA256 message authentication code.
//
// HMAC (Hash-based Message Authentication Code) combines a cryptographic
// hash function (SHA-256) with a secret key to produce a fixed-size
// authentication tag. This provides two security guarantees:
//
//   1. INTEGRITY:  If the message is modified in any way, the HMAC will
//                  not match — the receiver can detect tampering.
//   2. AUTHENTICITY: Only someone who possesses the secret key can compute
//                    a valid HMAC — this proves the sender's identity.
//
// How HMAC-SHA256 works internally:
//   - The secret key is XORed with two different padding constants (ipad, opad)
//   - Inner hash: SHA-256(key XOR ipad || message)
//   - Outer hash: SHA-256(key XOR opad || inner_hash)
//   - This double-hashing prevents length-extension attacks that affect
//     plain SHA-256 when used directly for authentication
//
// Parameters:
//   - message: The data to authenticate (e.g., HTTP request body)
//   - key:     The shared secret key (known to both sender and receiver)
//
// Returns: Hex-encoded HMAC-SHA256 string (64 hex characters = 32 bytes)
func ComputeHMAC(message, key []byte) string {
	mac := hmac.New(sha256.New, key)
	mac.Write(message)
	return hex.EncodeToString(mac.Sum(nil))
}

// VerifyHMAC checks whether a received HMAC signature matches the expected
// HMAC computed from the message and shared secret key.
//
// SECURITY: This function uses hmac.Equal() for comparison, which performs
// a constant-time byte comparison. This prevents TIMING SIDE-CHANNEL ATTACKS
// where an attacker could measure how long the comparison takes to determine
// how many bytes of their forged HMAC matched the real one.
//
// With a naive byte-by-byte comparison (==), the function returns faster
// when an early byte mismatches. An attacker could exploit this to brute-force
// the HMAC one byte at a time. Constant-time comparison always takes the
// same amount of time regardless of where the mismatch occurs.
//
// Parameters:
//   - message:      The original data that was signed
//   - signatureHex: The hex-encoded HMAC received from the sender
//   - key:          The shared secret key
//
// Returns: true if the signature is valid (message is authentic and unmodified)
func VerifyHMAC(message []byte, signatureHex string, key []byte) bool {
	// Decode the received signature from hex to raw bytes
	receivedMAC, err := hex.DecodeString(signatureHex)
	if err != nil {
		return false // Invalid hex encoding — reject
	}

	// Recompute the HMAC from the message using our copy of the secret key
	mac := hmac.New(sha256.New, key)
	mac.Write(message)
	expectedMAC := mac.Sum(nil)

	// Constant-time comparison prevents timing attacks
	return hmac.Equal(receivedMAC, expectedMAC)
}
