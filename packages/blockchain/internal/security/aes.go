package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"io"
)

// EncryptedMagic is a 5-byte prefix written at the start of every encrypted
// blockchain file. When loading a file, this prefix is checked to determine
// whether the file is encrypted (has prefix) or plaintext JSON (no prefix).
//
// This enables BACKWARD COMPATIBILITY — existing unencrypted blockchain.json
// files can still be loaded even after encryption support is added.
var EncryptedMagic = []byte("ZKENC")

// DeriveKey derives a 32-byte AES-256 encryption key from a human-readable
// passphrase using SHA-256 hashing.
//
// Why SHA-256 for key derivation:
//   - AES-256 requires exactly a 32-byte (256-bit) key
//   - SHA-256 always produces exactly 32 bytes, regardless of input length
//   - The hash function is deterministic: same passphrase always produces
//     the same key, allowing decryption with the same passphrase
//   - SHA-256 is a one-way function: the original passphrase cannot be
//     recovered from the derived key
//
// The passphrase is provided via the ENCRYPTION_KEY environment variable.
func DeriveKey(passphrase string) []byte {
	hash := sha256.Sum256([]byte(passphrase))
	return hash[:]
}

// EncryptAESGCM encrypts plaintext data using AES-256 in GCM mode.
//
// AES-256-GCM (Advanced Encryption Standard, Galois/Counter Mode) is an
// AUTHENTICATED ENCRYPTION algorithm that provides both:
//   - CONFIDENTIALITY: The data is encrypted — it cannot be read without the key
//   - INTEGRITY: A GCM authentication tag (GMAC) is appended — any tampering
//     with the ciphertext will be detected during decryption
//
// How AES-256-GCM works:
//
//   1. KEY SETUP: The 32-byte key is expanded into round keys for AES-256
//      (14 rounds of SubBytes, ShiftRows, MixColumns, AddRoundKey)
//
//   2. NONCE GENERATION: A 12-byte random nonce (Number Used Once) is
//      generated using crypto/rand (cryptographically secure RNG).
//      The nonce ensures that encrypting the same plaintext twice produces
//      different ciphertext each time — this is critical for security.
//
//   3. ENCRYPTION: AES encrypts a counter value (nonce + incrementing counter)
//      to produce a keystream. The plaintext is XORed with this keystream
//      to produce the ciphertext (Counter Mode).
//
//   4. AUTHENTICATION: The ciphertext is processed through GHASH (a polynomial
//      hash over GF(2^128)) to produce a 16-byte authentication tag.
//      This tag is appended to the ciphertext.
//
// Output format: nonce (12 bytes) || ciphertext || GCM auth tag (16 bytes)
//
// Parameters:
//   - plaintext: The data to encrypt (e.g., JSON blockchain data)
//   - key:       32-byte AES-256 key (from DeriveKey)
//
// Returns: The encrypted data with nonce prepended
func EncryptAESGCM(plaintext, key []byte) ([]byte, error) {
	// Create the AES cipher block using the 256-bit key
	// This key is the SYMMETRIC key — the same key is used for both
	// encryption and decryption (unlike asymmetric encryption like RSA)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("failed to create AES cipher: %w", err)
	}

	// Wrap the AES block cipher in GCM mode
	// GCM adds authentication on top of the basic AES encryption
	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("failed to create GCM wrapper: %w", err)
	}

	// Generate a random nonce (12 bytes for GCM)
	// Using crypto/rand which reads from the OS CSPRNG (Cryptographically
	// Secure Pseudo-Random Number Generator)
	// CRITICAL: Never reuse a nonce with the same key — this would break
	// GCM's security guarantees entirely
	nonce := make([]byte, aesGCM.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("failed to generate random nonce: %w", err)
	}

	// Seal encrypts the plaintext and appends the GCM authentication tag
	// The nonce is prepended to the output so we can extract it during decryption
	// Output layout: [nonce (12 bytes)][ciphertext][GCM tag (16 bytes)]
	ciphertext := aesGCM.Seal(nonce, nonce, plaintext, nil)
	return ciphertext, nil
}

// DecryptAESGCM decrypts AES-256-GCM encrypted data.
//
// This function reverses the EncryptAESGCM operation:
//   1. Extracts the nonce from the first 12 bytes
//   2. Decrypts the remaining ciphertext using AES-256 counter mode
//   3. Verifies the GCM authentication tag to detect tampering
//
// If the key is wrong or the ciphertext has been tampered with, the GCM
// authentication check will fail and an error is returned. This provides
// AUTHENTICATED DECRYPTION — you can trust both the confidentiality and
// integrity of the decrypted data.
//
// Parameters:
//   - ciphertext: The encrypted data (nonce || ciphertext || GCM tag)
//   - key:        The same 32-byte AES-256 key used for encryption
//
// Returns: The original plaintext data, or an error if decryption fails
func DecryptAESGCM(ciphertext, key []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("failed to create AES cipher: %w", err)
	}

	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("failed to create GCM wrapper: %w", err)
	}

	// The nonce is stored at the beginning of the ciphertext
	nonceSize := aesGCM.NonceSize()
	if len(ciphertext) < nonceSize {
		return nil, fmt.Errorf("ciphertext too short: expected at least %d bytes for nonce", nonceSize)
	}

	// Split: [nonce][actual ciphertext + GCM tag]
	nonce, encryptedData := ciphertext[:nonceSize], ciphertext[nonceSize:]

	// Open decrypts and verifies the GCM authentication tag
	// If the tag doesn't match (wrong key or tampered data), this returns an error
	plaintext, err := aesGCM.Open(nil, nonce, encryptedData, nil)
	if err != nil {
		return nil, fmt.Errorf("AES-GCM decryption failed (wrong key or corrupted data): %w", err)
	}

	return plaintext, nil
}
