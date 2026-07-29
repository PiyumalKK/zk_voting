package config

import (
	"strings"
	"testing"
)

func TestLoad(t *testing.T) {
	tests := []struct {
		name    string
		env     map[string]string
		wantErr string // substring expected in the returned error; empty means no error
		check   func(t *testing.T, cfg *Config)
	}{
		{
			name: "defaults",
			env:  map[string]string{},
			check: func(t *testing.T, cfg *Config) {
				if cfg.ChainID != DefaultChainID {
					t.Errorf("ChainID = %d, want %d", cfg.ChainID, DefaultChainID)
				}
				if cfg.RPCPort != DefaultRPCPort {
					t.Errorf("RPCPort = %d, want %d", cfg.RPCPort, DefaultRPCPort)
				}
				if cfg.P2PPort != DefaultP2PPort {
					t.Errorf("P2PPort = %d, want %d", cfg.P2PPort, DefaultP2PPort)
				}
				if cfg.DataDir != DefaultDataDir {
					t.Errorf("DataDir = %q, want %q", cfg.DataDir, DefaultDataDir)
				}
				if cfg.Role != RolePrimary {
					t.Errorf("Role = %q, want %q", cfg.Role, RolePrimary)
				}
				if cfg.BlockGasLimit != DefaultBlockGasLimit {
					t.Errorf("BlockGasLimit = %d, want %d", cfg.BlockGasLimit, DefaultBlockGasLimit)
				}
				if cfg.DevRPC {
					t.Error("DevRPC = true, want false")
				}
				if len(cfg.CORSOrigins) != 1 || cfg.CORSOrigins[0] != "*" {
					t.Errorf("CORSOrigins = %v, want [*]", cfg.CORSOrigins)
				}
				if cfg.LogLevel != DefaultLogLevel {
					t.Errorf("LogLevel = %q, want %q", cfg.LogLevel, DefaultLogLevel)
				}
				if cfg.LogFormat != DefaultLogFormat {
					t.Errorf("LogFormat = %q, want %q", cfg.LogFormat, DefaultLogFormat)
				}
				if len(cfg.Peers) != 0 {
					t.Errorf("Peers = %v, want empty", cfg.Peers)
				}
			},
		},
		{
			name: "overrides applied",
			env: map[string]string{
				"CHAIN_ID":        "1337",
				"RPC_PORT":        "8080",
				"P2P_PORT":        "8081",
				"DATA_DIR":        "/var/lib/zk",
				"ROLE":            "primary",
				"BLOCK_GAS_LIMIT": "30000000",
				"DEV_RPC":         "true",
				"LOG_LEVEL":       "DEBUG", // case-insensitive
				"LOG_FORMAT":      "json",
				"PEERS":           "https://node2:9546, https://node3:9546",
			},
			check: func(t *testing.T, cfg *Config) {
				if cfg.ChainID != 1337 {
					t.Errorf("ChainID = %d, want 1337", cfg.ChainID)
				}
				if cfg.RPCPort != 8080 || cfg.P2PPort != 8081 {
					t.Errorf("ports = %d/%d, want 8080/8081", cfg.RPCPort, cfg.P2PPort)
				}
				if cfg.DataDir != "/var/lib/zk" {
					t.Errorf("DataDir = %q, want /var/lib/zk", cfg.DataDir)
				}
				if cfg.BlockGasLimit != 30_000_000 {
					t.Errorf("BlockGasLimit = %d, want 30000000", cfg.BlockGasLimit)
				}
				if !cfg.DevRPC {
					t.Error("DevRPC = false, want true")
				}
				if cfg.LogLevel != "debug" {
					t.Errorf("LogLevel = %q, want lowercased debug", cfg.LogLevel)
				}
				if cfg.LogFormat != "json" {
					t.Errorf("LogFormat = %q, want json", cfg.LogFormat)
				}
				want := []string{"https://node2:9546", "https://node3:9546"}
				if len(cfg.Peers) != len(want) {
					t.Fatalf("Peers = %v, want %v", cfg.Peers, want)
				}
				for i := range want {
					if cfg.Peers[i] != want[i] {
						t.Errorf("Peers[%d] = %q, want %q", i, cfg.Peers[i], want[i])
					}
				}
			},
		},
		{
			name:    "invalid RPC_PORT out of range",
			env:     map[string]string{"RPC_PORT": "70000"},
			wantErr: "RPC_PORT must be between",
		},
		{
			name:    "invalid RPC_PORT not a number",
			env:     map[string]string{"RPC_PORT": "abc"},
			wantErr: "RPC_PORT must be an integer",
		},
		{
			name:    "RPC_PORT and P2P_PORT collide",
			env:     map[string]string{"RPC_PORT": "9545", "P2P_PORT": "9545"},
			wantErr: "must be different",
		},
		{
			name:    "invalid ROLE value",
			env:     map[string]string{"ROLE": "sequencer"},
			wantErr: `ROLE must be "primary" or "replica"`,
		},
		{
			name:    "replica missing PRIMARY_RPC_URL and REPLICA_PULL_URL",
			env:     map[string]string{"ROLE": "replica"},
			wantErr: "PRIMARY_RPC_URL is required",
		},
		{
			name: "replica with malformed PRIMARY_RPC_URL",
			env: map[string]string{
				"ROLE":             "replica",
				"PRIMARY_RPC_URL":  "not-a-url",
				"REPLICA_PULL_URL": "https://primary:9546",
			},
			wantErr: "PRIMARY_RPC_URL:",
		},
		{
			name: "replica with valid URLs passes",
			env: map[string]string{
				"ROLE":             "replica",
				"PRIMARY_RPC_URL":  "http://primary:9545",
				"REPLICA_PULL_URL": "https://primary:9546",
			},
			check: func(t *testing.T, cfg *Config) {
				if cfg.Role != RoleReplica {
					t.Errorf("Role = %q, want replica", cfg.Role)
				}
			},
		},
		{
			name:    "BLOCK_GAS_LIMIT at the mobile vote floor is rejected",
			env:     map[string]string{"BLOCK_GAS_LIMIT": "15000000"},
			wantErr: "BLOCK_GAS_LIMIT must be greater than",
		},
		{
			name:    "DEV_RPC not a boolean",
			env:     map[string]string{"DEV_RPC": "yes-please"},
			wantErr: "DEV_RPC must be a boolean",
		},
		{
			name:    "LOG_LEVEL invalid",
			env:     map[string]string{"LOG_LEVEL": "verbose"},
			wantErr: "LOG_LEVEL must be one of",
		},
		{
			name:    "LOG_FORMAT invalid",
			env:     map[string]string{"LOG_FORMAT": "yaml"},
			wantErr: `LOG_FORMAT must be "console" or "json"`,
		},
		{
			name: "CORS_ORIGINS explicit list is trimmed and split",
			env: map[string]string{
				"CORS_ORIGINS": " https://a.example, https://b.example ,",
			},
			check: func(t *testing.T, cfg *Config) {
				want := []string{"https://a.example", "https://b.example"}
				if len(cfg.CORSOrigins) != len(want) {
					t.Fatalf("CORSOrigins = %v, want %v", cfg.CORSOrigins, want)
				}
				for i := range want {
					if cfg.CORSOrigins[i] != want[i] {
						t.Errorf("CORSOrigins[%d] = %q, want %q", i, cfg.CORSOrigins[i], want[i])
					}
				}
			},
		},
		{
			name:    "PEERS with a malformed entry",
			env:     map[string]string{"PEERS": "https://ok:9546,not-a-url"},
			wantErr: "PEERS:",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg, err := FromEnv(tt.env)
			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("error = %q, want substring %q", err.Error(), tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tt.check != nil {
				tt.check(t, cfg)
			}
		})
	}
}

// TestValidateJoinsAllErrors exercises Validate directly against a
// maximally-invalid Config to prove every distinct problem is reported at
// once (errors.Join), not just the first — the explicit MASTER §7 spec
// requirement.
func TestValidateJoinsAllErrors(t *testing.T) {
	cfg := &Config{
		ChainID:       0,
		RPCPort:       0,
		P2PPort:       0,
		DataDir:       "",
		Role:          "bogus",
		BlockGasLimit: 0,
		CORSOrigins:   nil,
		TLSCert:       "",
		TLSKey:        "",
		TLSCA:         "",
		LogLevel:      "bogus",
		LogFormat:     "bogus",
	}

	err := cfg.Validate()
	if err == nil {
		t.Fatal("expected error, got nil")
	}

	wantSubstrings := []string{
		"CHAIN_ID must be greater than 0",
		"RPC_PORT must be between",
		"P2P_PORT must be between",
		"DATA_DIR must not be blank",
		"ROLE must be",
		"BLOCK_GAS_LIMIT must be greater than",
		"CORS_ORIGINS must not resolve",
		"TLS_CERT must not be blank",
		"TLS_KEY must not be blank",
		"TLS_CA must not be blank",
		"LOG_LEVEL must be one of",
		"LOG_FORMAT must be",
	}
	for _, s := range wantSubstrings {
		if !strings.Contains(err.Error(), s) {
			t.Errorf("Validate() error missing %q; full error: %v", s, err)
		}
	}
}

func TestParseCORSOrigins(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want []string
	}{
		{"wildcard", "*", []string{"*"}},
		{"empty falls back to wildcard", "", []string{"*"}},
		{"single origin", "https://a.example", []string{"https://a.example"}},
		{"multiple origins trimmed", " https://a.example ,https://b.example", []string{"https://a.example", "https://b.example"}},
		{"trailing comma ignored", "https://a.example,", []string{"https://a.example"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseCORSOrigins(tt.in)
			if len(got) != len(tt.want) {
				t.Fatalf("parseCORSOrigins(%q) = %v, want %v", tt.in, got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("parseCORSOrigins(%q) = %v, want %v", tt.in, got, tt.want)
				}
			}
		})
	}
}
