// Package rpc will host the JSON-RPC server and its method handlers
// (M04 onward). M01 only adds the health endpoint here so the real server
// built in M04 can mount the same handler instead of duplicating it.
package rpc

import (
	"encoding/json"
	"net/http"
)

// HeightProvider reports the current chain head height. M01 has no chain
// yet, so cmd/node/main.go wires in a provider that always returns 0;
// M02+ will replace it with the real chain's head.
type HeightProvider func() uint64

// HealthHandler serves GET /health with the node's liveness/identity info:
// {"status":"ok","role":"primary","chainId":9494,"height":0}
type HealthHandler struct {
	chainID uint64
	role    string
	height  HeightProvider
}

// NewHealthHandler builds a HealthHandler. A nil height defaults to a
// provider that always reports 0.
func NewHealthHandler(chainID uint64, role string, height HeightProvider) *HealthHandler {
	if height == nil {
		height = func() uint64 { return 0 }
	}
	return &HealthHandler{chainID: chainID, role: role, height: height}
}

type healthResponse struct {
	Status  string `json:"status"`
	Role    string `json:"role"`
	ChainID uint64 `json:"chainId"`
	Height  uint64 `json:"height"`
}

func (h *HealthHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	resp := healthResponse{
		Status:  "ok",
		Role:    h.role,
		ChainID: h.chainID,
		Height:  h.height(),
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp) // headers are already sent; nothing to recover from here
}
