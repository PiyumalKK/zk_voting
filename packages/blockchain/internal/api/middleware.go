package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"zk-blockchain/internal/security"
)

// hmacAuthMiddleware wraps an HTTP handler with HMAC-SHA256 authentication.
//
// This middleware implements a SYMMETRIC KEY authentication scheme:
//   - Both the client (admin) and the server share the same secret key
//   - The client computes HMAC-SHA256(request_body, secret_key) and sends
//     it in the X-HMAC-Signature HTTP header
//   - The server recomputes the HMAC using its own copy of the secret key
//   - If the HMACs match, the request is authenticated
//
// Security properties of HMAC-SHA256 authentication:
//
//   1. AUTHENTICATION: Only someone with the secret key can compute a valid
//      HMAC. An attacker without the key cannot forge a valid signature.
//
//   2. INTEGRITY: If the request body is modified in transit (even by one
//      byte), the HMAC will not match — tampering is detected.
//
//   3. REPLAY PROTECTION: While HMAC alone doesn't prevent replay attacks,
//      the combination with TLS (which provides its own replay protection
//      via sequence numbers) makes this secure.
//
//   4. TIMING ATTACK RESISTANCE: The HMAC comparison uses hmac.Equal()
//      (constant-time comparison) to prevent side-channel attacks.
//
// Usage: The admin must set the X-HMAC-Signature header:
//
//	signature = HMAC-SHA256(request_body_bytes, admin_api_key)
//	Header: X-HMAC-Signature: <hex-encoded signature>
//
// Example with curl:
//
//	BODY='{"voter_id":"voter1"}'
//	SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "your-secret-key" | awk '{print $2}')
//	curl -k -X POST https://localhost:3001/add-voter \
//	  -H "Content-Type: application/json" \
//	  -H "X-HMAC-Signature: $SIG" \
//	  -d "$BODY"
func hmacAuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// ── Step 1: Extract the HMAC signature from the request header ───
		// The client must include this header — it proves they have the key
		signature := r.Header.Get("X-HMAC-Signature")
		if signature == "" {
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, `{"error":"missing X-HMAC-Signature header","hint":"compute HMAC-SHA256 of the request body using the admin API key"}`, http.StatusUnauthorized)
			return
		}

		// ── Step 2: Read the request body ───────────────────────────────
		// We need the raw bytes to compute the HMAC. After reading, we
		// restore the body so the actual handler can read it too.
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, `{"error":"failed to read request body"}`, http.StatusBadRequest)
			return
		}
		// Restore the body for the next handler to consume
		r.Body = io.NopCloser(bytes.NewBuffer(body))

		// ── Step 3: Verify the HMAC signature ───────────────────────────
		// Recompute HMAC-SHA256(body, admin_api_key) and compare with the
		// received signature using constant-time comparison.
		//
		// If the HMACs don't match, either:
		//   (a) The sender doesn't have the correct key (authentication failure)
		//   (b) The body was modified in transit (integrity failure)
		//   (c) The signature is malformed (invalid hex encoding)
		if !security.VerifyHMAC(body, signature, []byte(adminAPIKey)) {
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, `{"error":"invalid HMAC signature - authentication failed"}`, http.StatusUnauthorized)
			return
		}

		// HMAC verified — request is authentic and unmodified
		next(w, r)
	}
}

// checksumMiddleware verifies the integrity of incoming API request bodies
// by checking a SHA-256 hash sent in the X-Content-SHA256 header.
//
// This provides APPLICATION-LAYER INTEGRITY VERIFICATION — a second layer
// of defence on top of TLS transport-layer integrity:
//
//   1. The client computes SHA-256(request_body) and sends it as a header
//   2. The server reads the body and independently computes SHA-256(body)
//   3. If the hashes don't match, the body was corrupted or tampered with
//
// Why this matters even with TLS:
//   - TLS protects data IN TRANSIT between two endpoints
//   - But if a PROXY, LOAD BALANCER, or APPLICATION MIDDLEWARE modifies
//     the body between the TLS termination point and the handler, TLS
//     won't detect it
//   - The checksum provides END-TO-END integrity from client to handler
//
// SHA-256 properties that make this effective:
//   - COLLISION RESISTANCE: An attacker cannot find a different body that
//     produces the same hash (2^128 operations required)
//   - AVALANCHE EFFECT: Changing even one bit of the body produces a
//     completely different hash — there's no "close" match
//   - DETERMINISTIC: The same body always produces the same hash
//
// This header is OPTIONAL — if X-Content-SHA256 is not present, the request
// passes through without checksum verification (backward compatible).
//
// Usage:
//
//	checksum = SHA-256(request_body_bytes)
//	Header: X-Content-SHA256: <hex-encoded SHA-256 hash>
func checksumMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Check if the client included a checksum header
		expectedHash := r.Header.Get("X-Content-SHA256")
		if expectedHash == "" {
			// No checksum provided — pass through (backward compatible)
			next(w, r)
			return
		}

		// Read the request body
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, `{"error":"failed to read request body"}`, http.StatusBadRequest)
			return
		}
		// Restore the body for the next handler
		r.Body = io.NopCloser(bytes.NewBuffer(body))

		// Compute SHA-256 hash of the actual body received
		actualHash := sha256.Sum256(body)
		actualHashHex := hex.EncodeToString(actualHash[:])

		// Compare the computed hash with the expected hash from the header
		// If they don't match, the body was corrupted or tampered with
		if actualHashHex != expectedHash {
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, `{"error":"request body SHA-256 checksum mismatch — data may have been corrupted or tampered with"}`, http.StatusBadRequest)
			return
		}

		// Checksum verified — body integrity confirmed
		next(w, r)
	}
}

