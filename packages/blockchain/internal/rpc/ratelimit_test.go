package rpc

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRateLimiterAllowsUpToBurstThenBlocks(t *testing.T) {
	l := NewRateLimiter(1, 3) // 1 rps, burst 3
	now := time.Now()
	l.now = func() time.Time { return now }

	for i := 0; i < 3; i++ {
		if !l.Allow("1.2.3.4") {
			t.Fatalf("request %d within burst was denied, want allowed", i)
		}
	}
	if l.Allow("1.2.3.4") {
		t.Fatal("request beyond burst was allowed, want denied")
	}
}

func TestRateLimiterRefillsOverTime(t *testing.T) {
	l := NewRateLimiter(1, 1) // 1 rps, burst 1
	now := time.Now()
	l.now = func() time.Time { return now }

	if !l.Allow("1.2.3.4") {
		t.Fatal("first request denied, want allowed")
	}
	if l.Allow("1.2.3.4") {
		t.Fatal("immediate second request allowed, want denied (bucket empty)")
	}

	now = now.Add(1100 * time.Millisecond) // > 1 token's worth at 1 rps
	if !l.Allow("1.2.3.4") {
		t.Fatal("request after refill window denied, want allowed")
	}
}

func TestRateLimiterTracksIPsIndependently(t *testing.T) {
	l := NewRateLimiter(1, 1)
	now := time.Now()
	l.now = func() time.Time { return now }

	if !l.Allow("1.1.1.1") {
		t.Fatal("first IP's first request denied")
	}
	if l.Allow("1.1.1.1") {
		t.Fatal("first IP's second immediate request allowed, want denied")
	}
	if !l.Allow("2.2.2.2") {
		t.Fatal("second IP's first request denied — buckets should be independent")
	}
}

func TestRateLimitMiddlewareExemptsLoopback(t *testing.T) {
	l := NewRateLimiter(1, 1)
	now := time.Now()
	l.now = func() time.Time { return now }
	handler := RateLimitMiddleware(l, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	for i := 0; i < 5; i++ {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = "127.0.0.1:5555"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("loopback request %d status = %d, want 200 (should never be throttled)", i, rec.Code)
		}
	}
}

func TestRateLimitMiddlewareThrottlesNonLoopback(t *testing.T) {
	l := NewRateLimiter(1, 1)
	now := time.Now()
	l.now = func() time.Time { return now }
	handler := RateLimitMiddleware(l, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req1 := httptest.NewRequest(http.MethodGet, "/", nil)
	req1.RemoteAddr = "203.0.113.9:1111"
	rec1 := httptest.NewRecorder()
	handler.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusOK {
		t.Fatalf("first request status = %d, want 200", rec1.Code)
	}

	req2 := httptest.NewRequest(http.MethodGet, "/", nil)
	req2.RemoteAddr = "203.0.113.9:2222" // same IP, different port
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusTooManyRequests {
		t.Fatalf("second immediate request status = %d, want 429", rec2.Code)
	}
}

func TestClientIPStripsPort(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "198.51.100.5:4321"
	if got := clientIP(req); got != "198.51.100.5" {
		t.Errorf("clientIP = %q, want 198.51.100.5", got)
	}
}

func TestIsLoopback(t *testing.T) {
	tests := []struct {
		ip   string
		want bool
	}{
		{"127.0.0.1", true},
		{"::1", true},
		{"203.0.113.7", false},
		{"not-an-ip", false},
	}
	for _, tt := range tests {
		if got := isLoopback(tt.ip); got != tt.want {
			t.Errorf("isLoopback(%q) = %v, want %v", tt.ip, got, tt.want)
		}
	}
}
