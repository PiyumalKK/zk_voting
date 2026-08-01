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

// ReplicaStatusProvider reports how far behind the primary a replica is
// (internal/p2p.Follower.Status). M10 deliverable 3 requires /health on a
// replica to answer {role, height, primaryHeight, synced}, because "is this
// node up?" and "is this node current?" are different questions and only the
// second one tells an operator whether it is safe to read from.
type ReplicaStatusProvider func() (primaryHeight uint64, synced bool)

// HealthHandler serves GET /health with the node's liveness/identity info:
//
//	primary: {"status":"ok","role":"primary","chainId":9494,"height":787}
//	replica: {"status":"ok","role":"replica","chainId":9494,"height":787,
//	          "primaryHeight":787,"synced":true}
type HealthHandler struct {
	chainID uint64
	role    string
	height  HeightProvider
	replica ReplicaStatusProvider
}

// NewHealthHandler builds a HealthHandler. A nil height defaults to a
// provider that always reports 0.
func NewHealthHandler(chainID uint64, role string, height HeightProvider) *HealthHandler {
	if height == nil {
		height = func() uint64 { return 0 }
	}
	return &HealthHandler{chainID: chainID, role: role, height: height}
}

// WithReplicaStatus adds the replication fields to this handler's output and
// returns it, so cmd/node can write
// NewHealthHandler(...).WithReplicaStatus(follower.Status) in one expression.
// Nil is accepted and leaves the fields absent.
func (h *HealthHandler) WithReplicaStatus(provider ReplicaStatusProvider) *HealthHandler {
	h.replica = provider
	return h
}

// healthResponse's replica fields are pointers so they are omitted entirely
// on a primary rather than reported as a misleading
// "primaryHeight":0,"synced":false.
type healthResponse struct {
	Status  string `json:"status"`
	Role    string `json:"role"`
	ChainID uint64 `json:"chainId"`
	Height  uint64 `json:"height"`

	PrimaryHeight *uint64 `json:"primaryHeight,omitempty"`
	Synced        *bool   `json:"synced,omitempty"`
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
	if h.replica != nil {
		primaryHeight, synced := h.replica()
		resp.PrimaryHeight = &primaryHeight
		resp.Synced = &synced
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp) // headers are already sent; nothing to recover from here
}
