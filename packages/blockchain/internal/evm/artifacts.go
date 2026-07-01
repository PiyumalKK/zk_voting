package evm

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
)

// contractArtifact is the subset of a Hardhat JSON artifact that we need.
// Hardhat emits the full artifact; we only care about the ABI and creation bytecode.
type contractArtifact struct {
	ABI      json.RawMessage `json:"abi"`
	Bytecode string          `json:"bytecode"` // hex string, 0x-prefixed
}

func loadArtifact(assetsDir, filename string) (*contractArtifact, error) {
	data, err := os.ReadFile(filepath.Join(assetsDir, filename))
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", filename, err)
	}
	var a contractArtifact
	if err := json.Unmarshal(data, &a); err != nil {
		return nil, fmt.Errorf("parse %s: %w", filename, err)
	}
	if len(a.ABI) == 0 || string(a.ABI) == "null" || string(a.ABI) == "[]" {
		return nil, fmt.Errorf("%s: empty ABI — was the contract compiled?", filename)
	}
	if a.Bytecode == "" || a.Bytecode == "0x" {
		return nil, fmt.Errorf("%s: empty bytecode — is this a library/interface artifact?", filename)
	}
	return &a, nil
}

func (a *contractArtifact) parsedABI() (abi.ABI, error) {
	return abi.JSON(strings.NewReader(string(a.ABI)))
}

func (a *contractArtifact) decodedBytecode() ([]byte, error) {
	h := strings.TrimPrefix(a.Bytecode, "0x")
	b, err := hex.DecodeString(h)
	if err != nil {
		return nil, fmt.Errorf("decode bytecode hex: %w", err)
	}
	return b, nil
}

// decodedLinkedBytecode replaces Solidity library placeholders with deployed
// addresses, then hex-decodes the result. libraries maps each 40-char
// placeholder string (e.g. "__$abcd1234....$__") to the deployed library's
// address as 40 lowercase hex chars (no 0x prefix).
func (a *contractArtifact) decodedLinkedBytecode(libraries map[string]string) ([]byte, error) {
	h := strings.TrimPrefix(a.Bytecode, "0x")
	for placeholder, addrHex := range libraries {
		h = strings.ReplaceAll(h, placeholder, addrHex)
	}
	b, err := hex.DecodeString(h)
	if err != nil {
		return nil, fmt.Errorf("decode linked bytecode: %w", err)
	}
	return b, nil
}
