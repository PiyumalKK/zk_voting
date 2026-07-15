package api

import (
	"bytes"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

// newAdminKey installs a fresh RSA keypair into the package-level adminPubKey
// for the duration of the test and returns the private key for signing.
func newAdminKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	prev := adminPubKey
	adminPubKey = &key.PublicKey
	t.Cleanup(func() { adminPubKey = prev })
	return key
}

// signAdmin produces the base64 signature over AdminSignedMessage(ts, path, body),
// mirroring what the Next.js signing proxy does.
func signAdmin(t *testing.T, key *rsa.PrivateKey, ts, path string, body []byte) string {
	t.Helper()
	digest := sha256.Sum256(AdminSignedMessage(ts, path, body))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatalf("SignPKCS1v15: %v", err)
	}
	return base64.StdEncoding.EncodeToString(sig)
}

func adminRequest(path, body, sig, ts string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader([]byte(body)))
	if sig != "" {
		req.Header.Set("X-Admin-Signature", sig)
	}
	if ts != "" {
		req.Header.Set("X-Admin-Timestamp", ts)
	}
	return req
}

func runAdminAuth(req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	handler := AdminAuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler(rec, req)
	return rec
}

func TestAdminAuth_ValidSignatureAccepted(t *testing.T) {
	key := newAdminKey(t)
	body := `{"question":"Q?"}`
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	sig := signAdmin(t, key, ts, "/set-question", []byte(body))

	rec := runAdminAuth(adminRequest("/set-question", body, sig, ts))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for a correctly signed request, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestAdminAuth_CrossEndpointReplayRejected is the regression test for the
// signature-scope fix: under the old body-only scheme, a signature captured for
// POST /end-election (body "{}") was equally valid for POST /reset-election —
// the path is now part of the signed message, so reusing it must fail.
func TestAdminAuth_CrossEndpointReplayRejected(t *testing.T) {
	key := newAdminKey(t)
	body := `{}`
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	sigForEnd := signAdmin(t, key, ts, "/end-election", []byte(body))

	rec := runAdminAuth(adminRequest("/reset-election", body, sigForEnd, ts))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 replaying an /end-election signature against /reset-election, got %d", rec.Code)
	}
}

// TestAdminAuth_BodyOnlySignatureRejected confirms the legacy signing scheme
// (RSA over the raw body alone) is no longer accepted.
func TestAdminAuth_BodyOnlySignatureRejected(t *testing.T) {
	key := newAdminKey(t)
	body := `{"voter_id":"alice@example.com"}`
	digest := sha256.Sum256([]byte(body))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatalf("SignPKCS1v15: %v", err)
	}
	ts := strconv.FormatInt(time.Now().Unix(), 10)

	rec := runAdminAuth(adminRequest("/add-voter", body, base64.StdEncoding.EncodeToString(sig), ts))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for a body-only (legacy) signature, got %d", rec.Code)
	}
}

func TestAdminAuth_StaleTimestampRejected(t *testing.T) {
	key := newAdminKey(t)
	body := `{}`
	stale := strconv.FormatInt(time.Now().Add(-adminSigMaxSkew-time.Minute).Unix(), 10)
	sig := signAdmin(t, key, stale, "/end-election", []byte(body))

	rec := runAdminAuth(adminRequest("/end-election", body, sig, stale))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for a stale timestamp, got %d", rec.Code)
	}
}

func TestAdminAuth_MissingHeaders(t *testing.T) {
	newAdminKey(t)
	ts := strconv.FormatInt(time.Now().Unix(), 10)

	for name, req := range map[string]*http.Request{
		"no signature": adminRequest("/end-election", "{}", "", ts),
		"no timestamp": adminRequest("/end-election", "{}", "c2ln", ""),
	} {
		rec := runAdminAuth(req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s: expected 401, got %d", name, rec.Code)
		}
	}
}

// TestAdminAuth_TamperedBodyRejected: a valid signature over one body must not
// authorize a different body on the same endpoint within the same window.
func TestAdminAuth_TamperedBodyRejected(t *testing.T) {
	key := newAdminKey(t)
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	sig := signAdmin(t, key, ts, "/add-voter", []byte(`{"voter_id":"alice@example.com"}`))

	rec := runAdminAuth(adminRequest("/add-voter", `{"voter_id":"mallory@evil.example"}`, sig, ts))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for a tampered body, got %d", rec.Code)
	}
}
