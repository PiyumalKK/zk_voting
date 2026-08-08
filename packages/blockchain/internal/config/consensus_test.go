package config

import (
	"os"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// writeFile is os.WriteFile with the 0600 mode production uses for the key
// file, so the test exercises the same permissions the deployment sets.
func writeFile(path, content string) error {
	return os.WriteFile(path, []byte(content), 0o600)
}

// Four fixed keys for the tests below and for the local four-validator
// cluster (e2e/cluster.mjs). They are Hardhat's well-known accounts #0–#3,
// derived from the public "test test … junk" mnemonic that every Hardhat
// project ships — the same keys internal/state prefunds at genesis. They are
// published in Hardhat's documentation and are not secrets. Production keys
// come from GitHub Actions secrets and never enter this repository; see
// CONSENSUS.md.
const (
	testKeyAuthority = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
	testKeyJVP       = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
	testKeyUNP       = "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
	testKeySJB       = "7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"

	testAddrAuthority = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
	testAddrJVP       = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
	testAddrUNP       = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
	testAddrSJB       = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"
)

// bftEnv is a complete, valid four-validator environment as seen by the
// `authority` node. Tests copy it and break one thing.
func bftEnv() map[string]string {
	return map[string]string{
		"CONSENSUS_MODE":        "bft",
		"VALIDATOR_ID":          "authority",
		"VALIDATOR_PRIVATE_KEY": testKeyAuthority,
		"VALIDATOR_SET": "authority:" + testAddrAuthority +
			",jvp:" + testAddrJVP +
			",unp:" + testAddrUNP +
			",sjb:" + testAddrSJB,
		"CONSENSUS_PEERS": "jvp=https://10.0.1.2:4001,unp=https://10.0.1.3:4001,sjb=https://10.0.1.4:4001",
	}
}

func withEnv(base map[string]string, overrides map[string]string) map[string]string {
	out := make(map[string]string, len(base)+len(overrides))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range overrides {
		if v == "" {
			delete(out, k)
			continue
		}
		out[k] = v
	}
	return out
}

// TestDeriveQuorum pins the threshold arithmetic the whole protocol's safety
// argument rests on. The 4-validator row is the one this project deploys:
// three signatures required, one failure tolerated.
func TestDeriveQuorum(t *testing.T) {
	tests := []struct {
		n, want, tolerates int
	}{
		{n: 1, want: 1, tolerates: 0},
		{n: 3, want: 2, tolerates: 1}, // 2 of 3 is a majority but tolerates no *Byzantine* fault
		{n: 4, want: 3, tolerates: 1}, // the deployed set
		{n: 5, want: 4, tolerates: 1},
		{n: 7, want: 5, tolerates: 2},
		{n: 10, want: 7, tolerates: 3},
	}

	for _, tc := range tests {
		if got := DeriveQuorum(tc.n); got != tc.want {
			t.Errorf("DeriveQuorum(%d) = %d, want %d", tc.n, got, tc.want)
		}
		if f := tc.n - tc.want; f != tc.tolerates {
			t.Errorf("N=%d Q=%d tolerates %d failures, want %d", tc.n, tc.want, f, tc.tolerates)
		}
	}
}

// TestDefaultsToSoloWithNoConsensusEnvironment is acceptance criterion 7's
// first line of defence: an existing deployment that has never heard of
// CONSENSUS_MODE must keep behaving exactly as it did.
func TestDefaultsToSoloWithNoConsensusEnvironment(t *testing.T) {
	cfg, err := FromEnv(map[string]string{})
	if err != nil {
		t.Fatalf("FromEnv: %v", err)
	}
	if cfg.ConsensusMode != ConsensusModeSolo {
		t.Errorf("ConsensusMode = %q, want %q", cfg.ConsensusMode, ConsensusModeSolo)
	}
	if len(cfg.ValidatorSet) != 0 {
		t.Errorf("ValidatorSet = %v, want empty", cfg.ValidatorSet)
	}
	if cfg.RoundTimeoutMS != DefaultRoundTimeoutMS {
		t.Errorf("RoundTimeoutMS = %d, want %d", cfg.RoundTimeoutMS, DefaultRoundTimeoutMS)
	}
}

// TestSoloRefusesValidatorSettings covers the failure mode this validation
// exists for. A node holding a key and a validator set, but sealing on its
// own authority because CONSENSUS_MODE was forgotten, is a silent regression
// from Byzantine fault tolerance to a single trusted party — in an election.
// Ignoring the stray variables would be friendlier and much worse.
func TestSoloRefusesValidatorSettings(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{name: "validator id", env: map[string]string{"VALIDATOR_ID": "authority"}},
		{name: "private key", env: map[string]string{"VALIDATOR_PRIVATE_KEY": testKeyAuthority}},
		{name: "private key file", env: map[string]string{"VALIDATOR_PRIVATE_KEY_FILE": "/etc/keys/validator.key"}},
		{name: "validator set", env: map[string]string{"VALIDATOR_SET": "authority:" + testAddrAuthority}},
		{name: "consensus peers", env: map[string]string{"CONSENSUS_PEERS": "jvp=https://10.0.1.2:4001"}},
		{name: "quorum", env: map[string]string{"QUORUM": "3"}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := FromEnv(tc.env)
			if err == nil {
				t.Fatal("a solo node accepted validator configuration")
			}
			if !strings.Contains(err.Error(), "CONSENSUS_MODE") {
				t.Errorf("error does not mention CONSENSUS_MODE, so it does not say how to fix it: %v", err)
			}
		})
	}
}

func TestValidBFTConfiguration(t *testing.T) {
	cfg, err := FromEnv(bftEnv())
	if err != nil {
		t.Fatalf("FromEnv: %v", err)
	}

	if cfg.ConsensusMode != ConsensusModeBFT {
		t.Errorf("ConsensusMode = %q, want %q", cfg.ConsensusMode, ConsensusModeBFT)
	}
	if len(cfg.ValidatorSet) != 4 {
		t.Fatalf("ValidatorSet has %d entries, want 4", len(cfg.ValidatorSet))
	}
	// Order is protocol-significant — proposer = validators[(H+round) % N] —
	// so it must survive parsing exactly as written.
	wantOrder := []string{"authority", "jvp", "unp", "sjb"}
	for i, want := range wantOrder {
		if cfg.ValidatorSet[i].Name != want {
			t.Errorf("ValidatorSet[%d].Name = %q, want %q", i, cfg.ValidatorSet[i].Name, want)
		}
	}
	if got := cfg.ValidatorSet[0].Address; got != common.HexToAddress(testAddrAuthority) {
		t.Errorf("authority address = %s, want %s", got, testAddrAuthority)
	}
	if got := cfg.EffectiveQuorum(); got != 3 {
		t.Errorf("EffectiveQuorum() = %d, want 3", got)
	}
	if len(cfg.ConsensusPeers) != 3 {
		t.Errorf("ConsensusPeers has %d entries, want the 3 other validators", len(cfg.ConsensusPeers))
	}

	hexKey, err := cfg.ConsensusPrivateKeyHex()
	if err != nil {
		t.Fatalf("ConsensusPrivateKeyHex: %v", err)
	}
	key, err := crypto.HexToECDSA(hexKey)
	if err != nil {
		t.Fatalf("HexToECDSA: %v", err)
	}
	if got := crypto.PubkeyToAddress(key.PublicKey); got != common.HexToAddress(testAddrAuthority) {
		t.Errorf("configured key derives to %s, want %s", got, testAddrAuthority)
	}
}

// TestSigningKeyMustMatchTheListedIdentity guards the failure that would
// otherwise be almost undiagnosable. A validator signing with a key nobody
// has listed produces messages that verify as coming from an unknown address
// and are silently dropped, so the cluster runs one validator short — turning
// a fault-tolerant set of four into one that halts on the next single
// failure, with nothing in any log to say why.
func TestSigningKeyMustMatchTheListedIdentity(t *testing.T) {
	// Correct set, but this node holds jvp's key while calling itself
	// authority.
	_, err := FromEnv(withEnv(bftEnv(), map[string]string{"VALIDATOR_PRIVATE_KEY": testKeyJVP}))
	if err == nil {
		t.Fatal("accepted a signing key that does not match VALIDATOR_ID's listed address")
	}
	for _, want := range []string{"derives to", testAddrJVP, "one validator short"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error is missing %q, so it does not explain the consequence: %v", want, err)
		}
	}
}

// TestSigningKeyAcceptsA0xPrefix: crypto.HexToECDSA rejects the prefix, and a
// key copied from a wallet or `cast wallet` has one. Stripping it here turns
// a confusing "invalid hex character 'x'" into no error at all.
func TestSigningKeyAcceptsA0xPrefix(t *testing.T) {
	cfg, err := FromEnv(withEnv(bftEnv(), map[string]string{"VALIDATOR_PRIVATE_KEY": "0x" + testKeyAuthority}))
	if err != nil {
		t.Fatalf("FromEnv with a 0x-prefixed key: %v", err)
	}
	hexKey, err := cfg.ConsensusPrivateKeyHex()
	if err != nil {
		t.Fatalf("ConsensusPrivateKeyHex: %v", err)
	}
	if strings.HasPrefix(hexKey, "0x") {
		t.Errorf("ConsensusPrivateKeyHex kept the 0x prefix: %q", hexKey)
	}
	if _, err := crypto.HexToECDSA(hexKey); err != nil {
		t.Errorf("HexToECDSA rejected the stripped key: %v", err)
	}
}

// TestPrivateKeyFileWinsOverTheEnvironmentVariable: production writes the key
// to a 0600 file precisely so it is not in the process environment, where
// `ps -e` would show it.
func TestPrivateKeyFileWinsOverTheEnvironmentVariable(t *testing.T) {
	path := t.TempDir() + "/validator.key"
	// A trailing newline is what `echo key > file` produces, so it must be
	// tolerated.
	if err := writeFile(path, testKeyAuthority+"\n"); err != nil {
		t.Fatalf("write key file: %v", err)
	}

	cfg, err := FromEnv(withEnv(bftEnv(), map[string]string{
		"VALIDATOR_PRIVATE_KEY":      testKeyJVP, // wrong on purpose: the file must win
		"VALIDATOR_PRIVATE_KEY_FILE": path,
	}))
	if err != nil {
		t.Fatalf("FromEnv: %v", err)
	}
	hexKey, err := cfg.ConsensusPrivateKeyHex()
	if err != nil {
		t.Fatalf("ConsensusPrivateKeyHex: %v", err)
	}
	if hexKey != testKeyAuthority {
		t.Errorf("key = %q, want the file's contents %q", hexKey, testKeyAuthority)
	}
}

func TestBFTRejectsIncompleteConfiguration(t *testing.T) {
	tests := []struct {
		name      string
		overrides map[string]string
		wantErr   string
	}{
		{
			name:      "no validator id",
			overrides: map[string]string{"VALIDATOR_ID": ""},
			wantErr:   "VALIDATOR_ID is required",
		},
		{
			name:      "validator id not in the set",
			overrides: map[string]string{"VALIDATOR_ID": "greens"},
			wantErr:   `"greens" is not in VALIDATOR_SET`,
		},
		{
			name:      "no signing key",
			overrides: map[string]string{"VALIDATOR_PRIVATE_KEY": ""},
			wantErr:   "VALIDATOR_PRIVATE_KEY or VALIDATOR_PRIVATE_KEY_FILE is required",
		},
		{
			name:      "set too small to tolerate a failure",
			overrides: map[string]string{"VALIDATOR_SET": "authority:" + testAddrAuthority + ",jvp:" + testAddrJVP},
			wantErr:   "at least 4 validators",
		},
		{
			name: "two validators share an address",
			overrides: map[string]string{"VALIDATOR_SET": "authority:" + testAddrAuthority +
				",jvp:" + testAddrJVP + ",unp:" + testAddrJVP + ",sjb:" + testAddrSJB},
			wantErr: "one vote, not two",
		},
		{
			name:      "malformed validator entry",
			overrides: map[string]string{"VALIDATOR_SET": "authority,jvp:" + testAddrJVP},
			wantErr:   "must be name:address",
		},
		{
			name:      "validator address is not hex",
			overrides: map[string]string{"VALIDATOR_SET": "authority:not-an-address,jvp:" + testAddrJVP},
			wantErr:   "is not a hex address",
		},
		{
			name:      "no consensus peers",
			overrides: map[string]string{"CONSENSUS_PEERS": ""},
			wantErr:   "CONSENSUS_PEERS must list every other validator",
		},
		{
			name:      "a validator has no peer entry",
			overrides: map[string]string{"CONSENSUS_PEERS": "jvp=https://10.0.1.2:4001,unp=https://10.0.1.3:4001"},
			wantErr:   `no entry for validator "sjb"`,
		},
		{
			name:      "peers include this node",
			overrides: map[string]string{"CONSENSUS_PEERS": "authority=https://10.0.1.1:4001,jvp=https://10.0.1.2:4001,unp=https://10.0.1.3:4001,sjb=https://10.0.1.4:4001"},
			wantErr:   "lists this node",
		},
		{
			name:      "peer url has no scheme",
			overrides: map[string]string{"CONSENSUS_PEERS": "jvp=10.0.1.2,unp=https://10.0.1.3:4001,sjb=https://10.0.1.4:4001"},
			wantErr:   "must include scheme and host",
		},
		{
			// "host:port" without a scheme does not even parse as a URL — a
			// different branch, and the likeliest way to get this wrong.
			name:      "peer url is a bare host and port",
			overrides: map[string]string{"CONSENSUS_PEERS": "jvp=10.0.1.2:4001,unp=https://10.0.1.3:4001,sjb=https://10.0.1.4:4001"},
			wantErr:   `validator "jvp": invalid URL`,
		},
		{
			name:      "a replica cannot be a validator",
			overrides: map[string]string{"ROLE": "replica", "PRIMARY_RPC_URL": "http://x:3001", "REPLICA_PULL_URL": "https://x:4001"},
			wantErr:   "ROLE must be \"primary\"",
		},
		{
			name:      "round timeout too small to complete a round",
			overrides: map[string]string{"ROUND_TIMEOUT_MS": "50"},
			wantErr:   "ROUND_TIMEOUT_MS must be at least 500",
		},
		{
			name:      "quorum below the byzantine threshold",
			overrides: map[string]string{"QUORUM": "3", "VALIDATOR_SET": "authority:" + testAddrAuthority + ",jvp:" + testAddrJVP + ",unp:" + testAddrUNP + ",sjb:" + testAddrSJB + ",greens:0x976EA74026E726554dB657fA54763abd0C3a0aa9"},
			wantErr:   "below the Byzantine threshold",
		},
		{
			name:      "quorum is not even a majority",
			overrides: map[string]string{"QUORUM": "2"},
			wantErr:   "not a majority",
		},
		{
			name:      "quorum exceeds the validator set",
			overrides: map[string]string{"QUORUM": "5"},
			wantErr:   "no block could ever finalize",
		},
		{
			name:      "unknown consensus mode",
			overrides: map[string]string{"CONSENSUS_MODE": "raft"},
			wantErr:   "CONSENSUS_MODE must be",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := FromEnv(withEnv(bftEnv(), tc.overrides))
			if err == nil {
				t.Fatalf("configuration accepted, want error containing %q", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error = %v\nwant it to contain %q", err, tc.wantErr)
			}
		})
	}
}

// TestBFTAcceptsAQuorumOverrideThatIsStricter: QUORUM exists as an escape
// hatch, so raising it above the derived threshold must work — a set of four
// requiring all four is safe (it just tolerates no failures).
func TestBFTAcceptsAQuorumOverrideThatIsStricter(t *testing.T) {
	cfg, err := FromEnv(withEnv(bftEnv(), map[string]string{"QUORUM": "4"}))
	if err != nil {
		t.Fatalf("FromEnv with QUORUM=4 over 4 validators: %v", err)
	}
	if got := cfg.EffectiveQuorum(); got != 4 {
		t.Errorf("EffectiveQuorum() = %d, want the override 4", got)
	}
}
