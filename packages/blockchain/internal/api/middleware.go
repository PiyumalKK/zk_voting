package api

import (
	"bytes"
	"crypto/rsa"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"sync"
	"time"
	"zk-blockchain/internal/security"

	"github.com/rs/zerolog/log"
	"golang.org/x/time/rate"
)

var adminPubKey *rsa.PublicKey

// RequestLogger logs method, path, remote IP, and latency for every request.
func RequestLogger(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Info().
			Str("method", r.Method).
			Str("path", r.URL.Path).
			Str("remote_ip", r.RemoteAddr).
			Dur("duration", time.Since(start)).
			Msg("HTTP request handled")
	}
}

// InitAuth loads the RSA public key used to verify admin requests.
// Returns an error if the key file is missing or malformed — the caller
// decides whether this is fatal.
func InitAuth(pubKeyPath string) error {
	pub, err := security.LoadPublicKey(pubKeyPath)
	if err != nil {
		return err
	}
	adminPubKey = pub
	return nil
}

// AdminAuthMiddleware verifies that the request body is signed with the admin
// private key. Returns 503 if auth is not configured, 401/403 otherwise.
func AdminAuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if adminPubKey == nil {
			http.Error(w, "Admin authentication not configured on this node", http.StatusServiceUnavailable)
			return
		}

		sigBase64 := r.Header.Get("X-Admin-Signature")
		if sigBase64 == "" {
			http.Error(w, "Missing X-Admin-Signature header", http.StatusUnauthorized)
			return
		}

		sigBytes, err := base64.StdEncoding.DecodeString(sigBase64)
		if err != nil {
			http.Error(w, "Invalid signature encoding", http.StatusBadRequest)
			return
		}

		// Read the body for signature verification, then restore it for the handler.
		bodyBytes, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "Cannot read body", http.StatusInternalServerError)
			return
		}
		r.Body = io.NopCloser(bytes.NewBuffer(bodyBytes))

		if err := security.VerifySignature(adminPubKey, bodyBytes, sigBytes); err != nil {
			http.Error(w, "Invalid admin signature", http.StatusForbidden)
			return
		}

		next.ServeHTTP(w, r)
	}
}

// ipLimiters keeps one rate limiter per client IP address.
var (
	ipLimitersMu sync.Mutex
	ipLimiters   = make(map[string]*rate.Limiter)
)

// getIPLimiter returns the rate limiter for the given IP, creating one if needed.
func getIPLimiter(ip string) *rate.Limiter {
	ipLimitersMu.Lock()
	defer ipLimitersMu.Unlock()
	if l, ok := ipLimiters[ip]; ok {
		return l
	}
	l := rate.NewLimiter(1, 5) // 1 request/sec sustained, burst of 5
	ipLimiters[ip] = l
	return l
}

// RateLimitMiddleware enforces per-IP rate limits to prevent DoS on public endpoints.
func RateLimitMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			ip = r.RemoteAddr // fallback for unusual address formats
		}
		if !getIPLimiter(ip).Allow() {
			http.Error(w, "Too many requests", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	}
}

// CORSMiddleware adds CORS headers so the browser frontend can call the API.
// It wraps the entire ServeMux rather than individual handlers.
func CORSMiddleware(allowedOrigin string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Signature")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}
