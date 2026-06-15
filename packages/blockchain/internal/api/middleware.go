package api

import (
	"bytes"
	"crypto/rsa"
	"encoding/base64"
	"io"
	"net/http"
	"time"
	"zk-blockchain/internal/security"

	"github.com/rs/zerolog/log"
	"golang.org/x/time/rate"
)

var adminPubKey *rsa.PublicKey

// RequestLogger logs incoming HTTP requests
func RequestLogger(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		// Call the next handler
		next.ServeHTTP(w, r)

		duration := time.Since(start)

		log.Info().
			Str("method", r.Method).
			Str("path", r.URL.Path).
			Str("remote_ip", r.RemoteAddr).
			Dur("duration", duration).
			Msg("HTTP request handled")
	}
}

// InitAuth loads the admin public key for authentication.
func InitAuth(pubKeyPath string) error {
	pub, err := security.LoadPublicKey(pubKeyPath)
	if err != nil {
		return err
	}
	adminPubKey = pub
	return nil
}

// AdminAuthMiddleware ensures the request is signed by the admin.
func AdminAuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sigBase64 := r.Header.Get("X-Admin-Signature")
		if sigBase64 == "" {
			http.Error(w, "Missing X-Admin-Signature header", http.StatusUnauthorized)
			return
		}

		sigBytes, err := base64.StdEncoding.DecodeString(sigBase64)
		if err != nil {
			http.Error(w, "Invalid signature format", http.StatusBadRequest)
			return
		}

		// Read body to verify, then restore it for the next handler
		bodyBytes, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "Cannot read body", http.StatusInternalServerError)
			return
		}
		r.Body = io.NopCloser(bytes.NewBuffer(bodyBytes))

		if err := security.VerifySignature(adminPubKey, bodyBytes, sigBytes); err != nil {
			http.Error(w, "Invalid signature", http.StatusForbidden)
			return
		}

		next.ServeHTTP(w, r)
	}
}

// RateLimiter map limits requests per IP. (1 req/sec, burst of 5)
var limiter = rate.NewLimiter(1, 5)

// RateLimitMiddleware prevents API spam.
func RateLimitMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !limiter.Allow() {
			http.Error(w, "Too many requests", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	}
}
