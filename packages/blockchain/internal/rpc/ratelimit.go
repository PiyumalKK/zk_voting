package rpc

import (
	"net"
	"net/http"
	"sync"
	"time"
)

// RateLimiter is a per-IP token-bucket limiter (M04 deliverable 1: "100
// rps, burst 200 — generous; env-tunable"). Implemented from scratch on
// sync/time only rather than pulling in golang.org/x/time/rate: this
// sandbox frequently has no network access to fetch a new module (the same
// constraint M02's go.mod note already recorded for go-ethereum itself),
// so avoiding a new dependency here means this file needs no `go mod tidy`
// run before it compiles.
type RateLimiter struct {
	rps   float64
	burst float64

	mu      sync.Mutex
	buckets map[string]*bucket
	now     func() time.Time // overridable in tests
}

type bucket struct {
	tokens   float64
	lastSeen time.Time
}

// staleBucketAfter bounds how long an idle IP's bucket is kept around —
// without this, a long-running node fielding traffic from many distinct
// IPs (or a churn of ephemeral source ports, though clientIP strips the
// port) would grow buckets unboundedly.
const staleBucketAfter = 10 * time.Minute

// NewRateLimiter builds a limiter refilling at rps tokens/sec up to a
// burst-token capacity per distinct client IP.
func NewRateLimiter(rps float64, burst int) *RateLimiter {
	return &RateLimiter{
		rps:     rps,
		burst:   float64(burst),
		buckets: make(map[string]*bucket),
		now:     time.Now,
	}
}

// Allow reports whether a request from ip may proceed right now, consuming
// one token from ip's bucket if so.
func (l *RateLimiter) Allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	b, ok := l.buckets[ip]
	if !ok {
		// A brand-new bucket starts full minus the token this call
		// consumes, exactly like a bucket that has been idle long enough
		// to refill to capacity.
		l.buckets[ip] = &bucket{tokens: l.burst - 1, lastSeen: now}
		l.sweepLocked(now)
		return true
	}

	elapsed := now.Sub(b.lastSeen).Seconds()
	b.tokens += elapsed * l.rps
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.lastSeen = now

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// sweepLocked evicts buckets idle longer than staleBucketAfter. Called
// opportunistically whenever a brand-new IP is seen (piggybacking on an
// already-held lock and an already-happening map write, rather than
// running a separate background goroutine/ticker) — bounded, cheap, and
// needs no extra lifecycle management (no goroutine to stop on shutdown).
func (l *RateLimiter) sweepLocked(now time.Time) {
	for ip, b := range l.buckets {
		if now.Sub(b.lastSeen) > staleBucketAfter {
			delete(l.buckets, ip)
		}
	}
}

// RateLimitMiddleware rejects requests over the limit with 429, exempting
// loopback callers entirely (trusted local tooling: hardhat-deploy, the
// differential harness, curl during development — MASTER M04 deliverable 1
// says "exempting localhost").
func RateLimitMiddleware(limiter *RateLimiter, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)
		if isLoopback(ip) {
			next.ServeHTTP(w, r)
			return
		}
		if !limiter.Allow(ip) {
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// clientIP extracts the request's source IP, stripping the port
// net/http.Request.RemoteAddr always includes. Falls back to the raw
// RemoteAddr string if it isn't a "host:port" pair (defensive; net/http
// always sets it in that shape for a real connection) so a limiter bucket
// still gets created per distinct raw value instead of panicking.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func isLoopback(ip string) bool {
	parsed := net.ParseIP(ip)
	return parsed != nil && parsed.IsLoopback()
}
