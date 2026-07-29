package rpc

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthHandler_OK(t *testing.T) {
	h := NewHealthHandler(9494, "primary", func() uint64 { return 0 })

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}

	var got healthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("response is not valid JSON: %v (body: %s)", err, rec.Body.String())
	}

	want := healthResponse{Status: "ok", Role: "primary", ChainID: 9494, Height: 0}
	if got != want {
		t.Errorf("body = %+v, want %+v", got, want)
	}
}

func TestHealthHandler_ReportsCurrentHeight(t *testing.T) {
	h := NewHealthHandler(9494, "replica", func() uint64 { return 42 })

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	var got healthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	if got.Height != 42 {
		t.Errorf("Height = %d, want 42", got.Height)
	}
	if got.Role != "replica" {
		t.Errorf("Role = %q, want replica", got.Role)
	}
}

func TestHealthHandler_NilHeightProviderDefaultsToZero(t *testing.T) {
	h := NewHealthHandler(9494, "primary", nil)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	var got healthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	if got.Height != 0 {
		t.Errorf("Height = %d, want 0", got.Height)
	}
}

func TestHealthHandler_MethodNotAllowed(t *testing.T) {
	h := NewHealthHandler(9494, "primary", nil)

	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		req := httptest.NewRequest(method, "/health", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s: status = %d, want %d", method, rec.Code, http.StatusMethodNotAllowed)
		}
	}
}
