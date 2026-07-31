package rpc

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
}

func TestCORSWildcardEchoesAnyOrigin(t *testing.T) {
	handler := CORSMiddleware([]string{"*"}, okHandler())

	req := httptest.NewRequest(http.MethodPost, "/", nil)
	req.Header.Set("Origin", "https://example.com")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want *", got)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200 (request should still reach the handler)", rec.Code)
	}
}

func TestCORSAllowlistEchoesOnlyKnownOrigins(t *testing.T) {
	handler := CORSMiddleware([]string{"https://a.example"}, okHandler())

	allowed := httptest.NewRequest(http.MethodPost, "/", nil)
	allowed.Header.Set("Origin", "https://a.example")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, allowed)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://a.example" {
		t.Errorf("allowed origin: header = %q, want https://a.example", got)
	}

	denied := httptest.NewRequest(http.MethodPost, "/", nil)
	denied.Header.Set("Origin", "https://evil.example")
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, denied)
	if got := rec2.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("denied origin: header = %q, want empty", got)
	}
	// A disallowed Origin still isn't itself an auth mechanism — the
	// request reaches the handler (the browser is what enforces CORS using
	// the missing header), matching real CORS semantics.
	if rec2.Code != http.StatusOK {
		t.Errorf("denied-origin request status = %d, want 200", rec2.Code)
	}
}

func TestCORSPreflightShortCircuits(t *testing.T) {
	reached := false
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true })
	handler := CORSMiddleware([]string{"*"}, next)

	req := httptest.NewRequest(http.MethodOptions, "/", nil)
	req.Header.Set("Origin", "https://example.com")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("preflight status = %d, want 204", rec.Code)
	}
	if reached {
		t.Error("preflight request reached the wrapped handler, want short-circuited")
	}
}

func TestHealthEndpointReachableThroughMux(t *testing.T) {
	seq := newTestSequencer(t)
	handler := newTestMux(t, seq)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("/health through the full mux status = %d, want 200", rec.Code)
	}
}
