package api

import (
	"bytes"
	"crypto/rsa"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
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

// adminSigMaxSkew is the maximum tolerated difference between the signed
// X-Admin-Timestamp and the node's clock. Within this window an intercepted
// request could still be re-sent verbatim, but it can no longer be replayed
// hours later or against a different endpoint (the path is signed too).
const adminSigMaxSkew = 5 * time.Minute

// adminMaxBodyBytes caps the request body read for signature verification so a
// hostile client cannot exhaust memory with an unbounded body. Admin payloads
// (voter IDs, questions, candidate lists) are tiny; 1 MiB is generous.
const adminMaxBodyBytes = 1 << 20

// AdminSignedMessage builds the exact byte string the admin must sign:
// "<unix-seconds>\n<request-path>\n<raw-body>". Binding the path prevents a
// signature captured for one endpoint (e.g. /end-election) from being replayed
// against another (e.g. /reset-election — both have empty "{}" bodies, so a
// body-only signature would be valid for either). Binding the timestamp bounds
// the replay window. The same string is constructed by the Next.js signing
// proxy (app/api/admin/[action]/route.ts) and the integration test.
func AdminSignedMessage(unixTimestamp, path string, body []byte) []byte {
	return append([]byte(unixTimestamp+"\n"+path+"\n"), body...)
}

// AdminAuthMiddleware verifies that the request is signed with the admin
// private key. The signature (X-Admin-Signature, base64 RSA-SHA256/PKCS#1v1.5)
// must cover timestamp + path + body as built by AdminSignedMessage, and the
// timestamp (X-Admin-Timestamp, unix seconds) must be within adminSigMaxSkew
// of the node's clock. Returns 503 if auth is not configured, 401/403 otherwise.
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

		tsStr := r.Header.Get("X-Admin-Timestamp")
		if tsStr == "" {
			http.Error(w, "Missing X-Admin-Timestamp header", http.StatusUnauthorized)
			return
		}
		ts, err := strconv.ParseInt(tsStr, 10, 64)
		if err != nil {
			http.Error(w, "Invalid X-Admin-Timestamp (want unix seconds)", http.StatusBadRequest)
			return
		}
		if skew := time.Since(time.Unix(ts, 0)); skew > adminSigMaxSkew || skew < -adminSigMaxSkew {
			http.Error(w, fmt.Sprintf("Admin request timestamp outside ±%s window", adminSigMaxSkew), http.StatusForbidden)
			return
		}

		sigBytes, err := base64.StdEncoding.DecodeString(sigBase64)
		if err != nil {
			http.Error(w, "Invalid signature encoding", http.StatusBadRequest)
			return
		}

		// Read the (size-capped) body for signature verification, then restore
		// it for the handler.
		bodyBytes, err := io.ReadAll(http.MaxBytesReader(w, r.Body, adminMaxBodyBytes))
		if err != nil {
			http.Error(w, "Cannot read body (too large?)", http.StatusRequestEntityTooLarge)
			return
		}
		r.Body = io.NopCloser(bytes.NewBuffer(bodyBytes))

		signed := AdminSignedMessage(tsStr, r.URL.Path, bodyBytes)
		if err := security.VerifySignature(adminPubKey, signed, sigBytes); err != nil {
			http.Error(w, "Invalid admin signature", http.StatusForbidden)
			return
		}

		next.ServeHTTP(w, r)
	}
}

// ipLimiters keeps one rate limiter per client IP address, with the last time
// that IP was seen so idle entries can be evicted (otherwise the map grows
// without bound — one entry per unique client IP ever seen, a slow memory leak
// an attacker with many source addresses could accelerate deliberately).
type ipLimiterEntry struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

var (
	ipLimitersMu sync.Mutex
	ipLimiters   = make(map[string]*ipLimiterEntry)
)

// ipLimiterPruneThreshold is the map size above which idle entries are pruned,
// and ipLimiterIdleTTL is how long an IP must be quiet to count as idle. An
// idle limiter is back at full burst capacity anyway, so evicting and later
// recreating it is behaviorally identical for that IP.
const (
	ipLimiterPruneThreshold = 10_000
	ipLimiterIdleTTL        = 10 * time.Minute
)

// getIPLimiter returns the rate limiter for the given IP, creating one if needed.
func getIPLimiter(ip string) *rate.Limiter {
	ipLimitersMu.Lock()
	defer ipLimitersMu.Unlock()

	now := time.Now()
	if e, ok := ipLimiters[ip]; ok {
		e.lastSeen = now
		return e.limiter
	}

	// Prune idle entries only when the map has grown suspiciously large, so the
	// common case (a handful of clients) never pays the scan cost.
	if len(ipLimiters) >= ipLimiterPruneThreshold {
		for k, e := range ipLimiters {
			if now.Sub(e.lastSeen) > ipLimiterIdleTTL {
				delete(ipLimiters, k)
			}
		}
	}

	e := &ipLimiterEntry{
		limiter:  rate.NewLimiter(1, 5), // 1 request/sec sustained, burst of 5
		lastSeen: now,
	}
	ipLimiters[ip] = e
	return e.limiter
}

// publicMaxBodyBytes caps request bodies on the public write endpoints
// (/register, /vote). The largest legitimate payload is a hex-encoded
// UltraHonk proof (tens of KB); 4 MiB leaves ample headroom while stopping a
// client from feeding the JSON decoder an unbounded body.
const publicMaxBodyBytes = 4 << 20

// RateLimitMiddleware enforces per-IP rate limits to prevent DoS on public
// endpoints, and caps the request body size before the handler's JSON decode.
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
		r.Body = http.MaxBytesReader(w, r.Body, publicMaxBodyBytes)
		next.ServeHTTP(w, r)
	}
}

// CORSMiddleware adds CORS headers so the browser frontend can call the API.
// It wraps the entire ServeMux rather than individual handlers.
func CORSMiddleware(allowedOrigin string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Signature, X-Admin-Timestamp")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}
