// Package config parses and validates the Go node's runtime configuration.
//
// Precedence is env-only — no flags, no config files — matching the rest of
// the monorepo (see MASTER §7). Call Load to read the real process
// environment, or FromEnv with an explicit map for tests.
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
)

// Role identifies whether a node is the write sequencer or a read replica.
type Role string

const (
	RolePrimary Role = "primary"
	RoleReplica Role = "replica"
)

// Defaults mirror the table in MASTER §7.
const (
	DefaultChainID       uint64 = 9494
	DefaultRPCPort       int    = 9545
	DefaultP2PPort       int    = 9546
	DefaultDataDir       string = "./data"
	DefaultRole          Role   = RolePrimary
	DefaultBlockGasLimit uint64 = 60_000_000
	DefaultDevRPC        bool   = false
	DefaultCORSOrigins   string = "*"
	DefaultTLSCert       string = "./certs/server.crt"
	DefaultTLSKey        string = "./certs/server.key"
	DefaultTLSCA         string = "./certs/ca.crt"
	DefaultLogLevel      string = "info"
	// DefaultLogFormat is not in MASTER §7's original table. It was added
	// here (M01) so main.go can pick console (human-friendly, dev) vs JSON
	// (aggregation-friendly, prod/replica) output — see Agent Rule 8 (new
	// env vars must be documented in MASTER §7 and .env.example). Documented
	// in .env.example.
	DefaultLogFormat string = "console"

	// DefaultRPCRateLimitRPS and DefaultRPCRateLimitBurst are not in MASTER
	// §7's original table either — added here (M04) so internal/rpc's
	// per-IP token-bucket limiter (MASTER M04 deliverable 1: "100 rps,
	// burst 200 — generous; env-tunable") has somewhere to read its
	// defaults from. Documented in .env.example and MASTER §7 (Agent Rule
	// 8: new env vars must be documented in both places).
	DefaultRPCRateLimitRPS   float64 = 100
	DefaultRPCRateLimitBurst int     = 200

	// MinBlockGasLimit: the mobile app submits vote() with a fixed
	// 15,000,000 gas limit (MASTER §2, "Facts the plan depends on"), so
	// BLOCK_GAS_LIMIT must stay strictly greater than this.
	MinBlockGasLimit uint64 = 15_000_000

	minPort = 1
	maxPort = 65535
)

var (
	validLogLevels = map[string]bool{
		"trace": true, "debug": true, "info": true, "warn": true,
		"error": true, "fatal": true, "panic": true, "disabled": true,
	}
	validLogFormats = map[string]bool{"console": true, "json": true}
)

// Config is the fully parsed runtime configuration for one node. Values
// produced by Load have already passed Validate; a Config built by hand
// (e.g. in tests) should call Validate explicitly before use.
type Config struct {
	ChainID uint64
	RPCPort int
	P2PPort int
	DataDir string
	Role    Role

	// PrimaryRPCURL and ReplicaPullURL are required when Role == RoleReplica.
	PrimaryRPCURL  string
	ReplicaPullURL string

	// Peers is primary-only; empty is valid for a standalone single node.
	Peers []string

	BlockGasLimit uint64
	DevRPC        bool
	// CORSOrigins is either exactly []string{"*"} or a list of explicit
	// origins; never empty.
	CORSOrigins []string

	// RPCRateLimitRPS and RPCRateLimitBurst configure internal/rpc's
	// per-IP token-bucket limiter (M04). RPS is the steady-state refill
	// rate; Burst is the bucket capacity (how many requests a single IP
	// can fire instantly before it starts being throttled to RPS).
	RPCRateLimitRPS   float64
	RPCRateLimitBurst int

	TLSCert string
	TLSKey  string
	TLSCA   string

	LogLevel  string
	LogFormat string
}

// lookupFunc mirrors os.LookupEnv's signature so tests can inject a
// hermetic environment instead of mutating process-global state.
type lookupFunc func(key string) (string, bool)

// Load reads, parses, and validates configuration from the real process
// environment. It returns every problem found — both parse errors (e.g.
// "RPC_PORT must be an integer") and Validate's semantic errors — joined
// into a single error, so a misconfigured deployment can be fixed in one
// pass instead of one failure at a time.
func Load() (*Config, error) {
	return load(os.LookupEnv)
}

// FromEnv builds and validates a Config from an explicit map, bypassing the
// real process environment. Exported for tests.
func FromEnv(env map[string]string) (*Config, error) {
	return load(func(key string) (string, bool) {
		v, ok := env[key]
		return v, ok
	})
}

func load(lookup lookupFunc) (*Config, error) {
	var errs []error
	addf := func(format string, args ...any) { errs = append(errs, fmt.Errorf(format, args...)) }

	get := func(key, def string) string {
		if v, ok := lookup(key); ok && strings.TrimSpace(v) != "" {
			return v
		}
		return def
	}

	cfg := &Config{}

	if v, err := strconv.ParseUint(get("CHAIN_ID", strconv.FormatUint(DefaultChainID, 10)), 10, 64); err != nil {
		addf("CHAIN_ID must be a non-negative integer: %w", err)
	} else {
		cfg.ChainID = v
	}

	if v, err := strconv.Atoi(get("RPC_PORT", strconv.Itoa(DefaultRPCPort))); err != nil {
		addf("RPC_PORT must be an integer: %w", err)
	} else {
		cfg.RPCPort = v
	}

	if v, err := strconv.Atoi(get("P2P_PORT", strconv.Itoa(DefaultP2PPort))); err != nil {
		addf("P2P_PORT must be an integer: %w", err)
	} else {
		cfg.P2PPort = v
	}

	cfg.DataDir = get("DATA_DIR", DefaultDataDir)
	cfg.Role = Role(get("ROLE", string(DefaultRole)))
	cfg.PrimaryRPCURL, _ = lookup("PRIMARY_RPC_URL")
	cfg.ReplicaPullURL, _ = lookup("REPLICA_PULL_URL")

	if raw, ok := lookup("PEERS"); ok && strings.TrimSpace(raw) != "" {
		for _, p := range strings.Split(raw, ",") {
			if p = strings.TrimSpace(p); p != "" {
				cfg.Peers = append(cfg.Peers, p)
			}
		}
	}

	if v, err := strconv.ParseUint(get("BLOCK_GAS_LIMIT", strconv.FormatUint(DefaultBlockGasLimit, 10)), 10, 64); err != nil {
		addf("BLOCK_GAS_LIMIT must be a non-negative integer: %w", err)
	} else {
		cfg.BlockGasLimit = v
	}

	if v, err := strconv.ParseBool(get("DEV_RPC", strconv.FormatBool(DefaultDevRPC))); err != nil {
		addf("DEV_RPC must be a boolean: %w", err)
	} else {
		cfg.DevRPC = v
	}

	cfg.CORSOrigins = parseCORSOrigins(get("CORS_ORIGINS", DefaultCORSOrigins))

	if v, err := strconv.ParseFloat(get("RPC_RATE_LIMIT_RPS", strconv.FormatFloat(DefaultRPCRateLimitRPS, 'f', -1, 64)), 64); err != nil {
		addf("RPC_RATE_LIMIT_RPS must be a number: %w", err)
	} else {
		cfg.RPCRateLimitRPS = v
	}

	if v, err := strconv.Atoi(get("RPC_RATE_LIMIT_BURST", strconv.Itoa(DefaultRPCRateLimitBurst))); err != nil {
		addf("RPC_RATE_LIMIT_BURST must be an integer: %w", err)
	} else {
		cfg.RPCRateLimitBurst = v
	}

	cfg.TLSCert = get("TLS_CERT", DefaultTLSCert)
	cfg.TLSKey = get("TLS_KEY", DefaultTLSKey)
	cfg.TLSCA = get("TLS_CA", DefaultTLSCA)
	cfg.LogLevel = strings.ToLower(get("LOG_LEVEL", DefaultLogLevel))
	cfg.LogFormat = strings.ToLower(get("LOG_FORMAT", DefaultLogFormat))

	if err := cfg.Validate(); err != nil {
		errs = append(errs, err)
	}

	if len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
	return cfg, nil
}

// Validate checks every semantic invariant implied by MASTER §7 (port
// ranges, role-dependent required fields, the gas-limit floor, enum
// membership, …) and returns every violation joined into one error, or nil.
// It is safe to call directly on a hand-built Config, which is how the test
// suite exercises validation rules in isolation from env parsing.
func (c *Config) Validate() error {
	var errs []error
	addf := func(format string, args ...any) { errs = append(errs, fmt.Errorf(format, args...)) }

	if c.ChainID == 0 {
		addf("CHAIN_ID must be greater than 0")
	}

	rpcOK := validPort(c.RPCPort)
	if !rpcOK {
		addf("RPC_PORT must be between %d and %d, got %d", minPort, maxPort, c.RPCPort)
	}
	p2pOK := validPort(c.P2PPort)
	if !p2pOK {
		addf("P2P_PORT must be between %d and %d, got %d", minPort, maxPort, c.P2PPort)
	}
	if rpcOK && p2pOK && c.RPCPort == c.P2PPort {
		addf("RPC_PORT and P2P_PORT must be different, both are %d", c.RPCPort)
	}

	if strings.TrimSpace(c.DataDir) == "" {
		addf("DATA_DIR must not be blank")
	}

	switch c.Role {
	case RolePrimary:
		for _, p := range c.Peers {
			if err := validURL(p); err != nil {
				addf("PEERS: %v", err)
			}
		}
	case RoleReplica:
		if strings.TrimSpace(c.PrimaryRPCURL) == "" {
			addf("PRIMARY_RPC_URL is required when ROLE=replica")
		} else if err := validURL(c.PrimaryRPCURL); err != nil {
			addf("PRIMARY_RPC_URL: %v", err)
		}
		if strings.TrimSpace(c.ReplicaPullURL) == "" {
			addf("REPLICA_PULL_URL is required when ROLE=replica")
		} else if err := validURL(c.ReplicaPullURL); err != nil {
			addf("REPLICA_PULL_URL: %v", err)
		}
	default:
		addf("ROLE must be %q or %q, got %q", RolePrimary, RoleReplica, c.Role)
	}

	if c.BlockGasLimit <= MinBlockGasLimit {
		addf("BLOCK_GAS_LIMIT must be greater than %d (mobile vote tx gas), got %d", MinBlockGasLimit, c.BlockGasLimit)
	}

	if len(c.CORSOrigins) == 0 {
		addf("CORS_ORIGINS must not resolve to an empty list")
	}

	if c.RPCRateLimitRPS <= 0 {
		addf("RPC_RATE_LIMIT_RPS must be greater than 0, got %v", c.RPCRateLimitRPS)
	}
	if c.RPCRateLimitBurst <= 0 {
		addf("RPC_RATE_LIMIT_BURST must be greater than 0, got %d", c.RPCRateLimitBurst)
	}

	if strings.TrimSpace(c.TLSCert) == "" {
		addf("TLS_CERT must not be blank")
	}
	if strings.TrimSpace(c.TLSKey) == "" {
		addf("TLS_KEY must not be blank")
	}
	if strings.TrimSpace(c.TLSCA) == "" {
		addf("TLS_CA must not be blank")
	}

	if !validLogLevels[c.LogLevel] {
		addf("LOG_LEVEL must be one of trace|debug|info|warn|error|fatal|panic|disabled, got %q", c.LogLevel)
	}
	if !validLogFormats[c.LogFormat] {
		addf("LOG_FORMAT must be %q or %q, got %q", "console", "json", c.LogFormat)
	}

	if len(errs) == 0 {
		return nil
	}
	return errors.Join(errs...)
}

func validPort(p int) bool { return p >= minPort && p <= maxPort }

func validURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid URL %q: %w", raw, err)
	}
	if u.Scheme == "" || u.Host == "" {
		return fmt.Errorf("invalid URL %q: must include scheme and host, e.g. https://host:9546", raw)
	}
	return nil
}

// parseCORSOrigins turns a comma-separated CORS_ORIGINS value into a
// slice. "*" (the default) yields []string{"*"}; anything blank falls back
// to the same wildcard so callers never see an empty slice.
func parseCORSOrigins(raw string) []string {
	if strings.TrimSpace(raw) == "*" {
		return []string{"*"}
	}
	var origins []string
	for _, p := range strings.Split(raw, ",") {
		if p = strings.TrimSpace(p); p != "" {
			origins = append(origins, p)
		}
	}
	if len(origins) == 0 {
		return []string{"*"}
	}
	return origins
}
