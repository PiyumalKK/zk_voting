package api

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// rateLimiter implements IP-based rate limiting with SHA-256 hashed client
// identifiers for privacy protection.
//
// Rate limiting is a NETWORK SECURITY mechanism that protects the
// AVAILABILITY of the system (one of the three CIA triad pillars:
// Confidentiality, Integrity, Availability).
//
// Without rate limiting, an attacker could:
//   - Flood the /vote endpoint to cause Denial of Service (DoS)
//   - Spam the /add-voter endpoint to exhaust server resources
//   - Brute-force the HMAC authentication by trying many signatures
//
// PRIVACY: Client IP addresses are hashed with SHA-256 before storage.
// This means the actual IP addresses are never stored in memory — even
// if an attacker gains access to the server's memory, they cannot
// determine which IP addresses have been rate-limited. SHA-256 is a
// one-way function, making it computationally infeasible to reverse
// the hash back to the original IP address.
type rateLimiter struct {
	mu       sync.Mutex
	requests map[string][]time.Time // key = SHA-256(IP), value = request timestamps
	limit    int                    // max requests per window
	window   time.Duration          // time window for rate counting
}

// newRateLimiter creates a new rate limiter with the specified limit and
// time window. A background goroutine periodically cleans up expired entries
// to prevent memory growth.
//
// Parameters:
//   - limit:  Maximum number of requests allowed within the window
//   - window: Time duration for the sliding window (e.g., 1 minute)
func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	rl := &rateLimiter{
		requests: make(map[string][]time.Time),
		limit:    limit,
		window:   window,
	}

	// Start background cleanup goroutine to evict expired entries
	// This prevents the rate limiter's memory from growing unbounded
	go rl.cleanup()

	return rl
}

// isAllowed checks whether a request from the given IP address should be
// permitted based on the rate limit.
//
// The IP address is first hashed with SHA-256 for privacy:
//   - Input:  "192.168.1.100:54321"
//   - Output: "a7b9c3d1e5f6..." (64 hex characters)
//
// The function then counts how many requests from this hashed IP
// occurred within the sliding time window. If the count is below
// the limit, the request is allowed and the current timestamp is recorded.
func (rl *rateLimiter) isAllowed(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	// Hash the IP address with SHA-256 for privacy protection
	// SHA-256 is a one-way function — the original IP cannot be recovered
	ipHash := sha256.Sum256([]byte(ip))
	key := hex.EncodeToString(ipHash[:])

	now := time.Now()
	windowStart := now.Add(-rl.window)

	// Filter out expired entries (outside the sliding window)
	var valid []time.Time
	for _, t := range rl.requests[key] {
		if t.After(windowStart) {
			valid = append(valid, t)
		}
	}

	// Check if the client has exceeded their rate limit
	if len(valid) >= rl.limit {
		rl.requests[key] = valid
		return false
	}

	// Allow the request and record the timestamp
	rl.requests[key] = append(valid, now)
	return true
}

// cleanup periodically removes expired entries from the rate limiter's
// internal map. This runs as a background goroutine to prevent memory
// from growing unbounded as new clients make requests.
func (rl *rateLimiter) cleanup() {
	ticker := time.NewTicker(rl.window)
	defer ticker.Stop()

	for range ticker.C {
		rl.mu.Lock()
		now := time.Now()
		windowStart := now.Add(-rl.window)

		for key, times := range rl.requests {
			var valid []time.Time
			for _, t := range times {
				if t.After(windowStart) {
					valid = append(valid, t)
				}
			}
			if len(valid) == 0 {
				delete(rl.requests, key)
			} else {
				rl.requests[key] = valid
			}
		}
		rl.mu.Unlock()
	}
}

// rateLimitMiddleware wraps an HTTP handler with IP-based rate limiting.
//
// When a client exceeds the rate limit, they receive a 429 Too Many Requests
// response. The Retry-After header indicates how many seconds they should
// wait before retrying.
//
// This middleware should be applied as the OUTERMOST layer in the middleware
// chain, so rate limiting is checked BEFORE any authentication or processing
// occurs. This prevents attackers from consuming server resources with
// rejected requests.
func rateLimitMiddleware(rl *rateLimiter, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !rl.isAllowed(r.RemoteAddr) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Retry-After", fmt.Sprintf("%d", int(rl.window.Seconds())))
			http.Error(w, `{"error":"rate limit exceeded, try again later"}`, http.StatusTooManyRequests)
			return
		}
		next(w, r)
	}
}
