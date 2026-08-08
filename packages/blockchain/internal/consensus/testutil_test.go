package consensus

import (
	"crypto/ecdsa"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"

	"zk-blockchain/internal/config"
)

const testChainID = 9494

// The four validator names this project deploys. Kept as a slice so tests
// that iterate "every validator" stay in protocol order.
var testValidatorNames = []string{"authority", "jvp", "unp", "sjb"}

// testKeys are Hardhat's well-known accounts #0–#3, from the public
// "test test … junk" mnemonic. Not secrets — they are in Hardhat's own
// documentation and are the same accounts internal/state prefunds at genesis.
// Production validator keys come from GitHub Actions secrets and never enter
// this repository.
var testKeys = []string{
	"ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
	"59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
	"5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
	"7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
}

// outsiderKey is Hardhat account #4 — a valid secp256k1 key that is
// deliberately *not* in the validator set, for testing that a well-formed
// signature from a stranger is still refused.
const outsiderKey = "47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"

func mustKey(t *testing.T, hexKey string) *ecdsa.PrivateKey {
	t.Helper()
	key, err := crypto.HexToECDSA(hexKey)
	if err != nil {
		t.Fatalf("HexToECDSA: %v", err)
	}
	return key
}

// testSet builds the deployed four-validator set with its derived quorum of
// three, along with each member's signing key.
func testSet(t *testing.T) (*ValidatorSet, map[string]*ecdsa.PrivateKey) {
	t.Helper()

	entries := make([]config.ValidatorEntry, 0, len(testValidatorNames))
	keys := make(map[string]*ecdsa.PrivateKey, len(testValidatorNames))
	for i, name := range testValidatorNames {
		key := mustKey(t, testKeys[i])
		keys[name] = key
		entries = append(entries, config.ValidatorEntry{
			Name:    name,
			Address: crypto.PubkeyToAddress(key.PublicKey),
		})
	}

	vs, err := NewValidatorSet(entries, 0)
	if err != nil {
		t.Fatalf("NewValidatorSet: %v", err)
	}
	return vs, keys
}
