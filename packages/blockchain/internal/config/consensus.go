package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// This file holds the CONSENSUS_MODE=bft configuration surface: the validator
// registry, this node's identity and signing key, how to reach its peers, and
// the round timing.
//
// It is a separate file from config.go for the same reason internal/chain
// splits sealing from following: the solo path is load-bearing for everything
// that shipped before consensus existed, and keeping the new parsing beside it
// rather than woven through it makes "does this change affect solo mode?"
// answerable by looking at one file.
//
// The style is config.go's, deliberately: errors accumulate through addf and
// come back joined, so a misconfigured cluster reports every problem in one
// pass instead of one restart at a time.

// ConsensusMode selects how blocks are produced.
type ConsensusMode string

const (
	// ConsensusModeSolo is the single-sequencer model: one writer seals every
	// block, replicas verify and copy, and there is no voting. This is the
	// default and is byte-for-byte the behaviour of every milestone through
	// M14 — a node with CONSENSUS_MODE unset runs exactly as it did before
	// consensus was added, which is what makes a bad rollout revertible by
	// removing one environment variable.
	ConsensusModeSolo ConsensusMode = "solo"
	// ConsensusModeBFT is multi-validator Byzantine-fault-tolerant consensus:
	// a block is final only once a quorum of validators has signed a COMMIT
	// for it. See internal/consensus and CONSENSUS.md.
	ConsensusModeBFT ConsensusMode = "bft"
)

const (
	DefaultConsensusMode = ConsensusModeSolo
	// DefaultRoundTimeoutMS is how long a validator waits for the proposer
	// before calling for a round change. It bounds how long a single failed
	// proposer can stall the chain, so it is also the worst-case extra
	// latency a vote sees when the node it was submitted to is not the
	// proposer.
	DefaultRoundTimeoutMS = 4000
	// MinRoundTimeoutMS floors ROUND_TIMEOUT_MS. Below roughly half a second
	// a cluster spends more time changing rounds than proposing, because a
	// round has to fit a proposal broadcast, a block re-execution on every
	// validator, and two more broadcast rounds.
	MinRoundTimeoutMS = 500
	// MinValidators is the smallest set for which "tolerates one failure"
	// means anything: with N=4, Q=3, f=1. N=3 would give Q=2 and f=0 — a set
	// that halts on any single failure, which is the problem BFT is here to
	// solve.
	MinValidators = 4
)

var validConsensusModes = map[ConsensusMode]bool{
	ConsensusModeSolo: true,
	ConsensusModeBFT:  true,
}

// ValidatorEntry is one member of the validator registry: the name operators
// and logs use, and the address its consensus signatures recover to.
type ValidatorEntry struct {
	Name    string
	Address common.Address
}

// ConsensusPeer is how to reach one other validator's P2P listener.
type ConsensusPeer struct {
	Name   string
	P2PURL string
}

// DeriveQuorum returns the number of signatures a block needs to be final:
// ceil(2N/3), which for N=4 is 3.
//
// This is the classic BFT threshold, and the reason it is 2N/3 rather than a
// simple majority is worth stating where the number is computed. With f
// faulty validators out of N, a quorum must (a) be reachable when f are down,
// so Q <= N-f, and (b) make any two quorums overlap in at least one *honest*
// validator, so 2Q-N > f. Together those give N > 3f, and Q = ceil(2N/3) is
// the smallest threshold satisfying both. For N=4: f=1, Q=3.
func DeriveQuorum(n int) int {
	if n <= 0 {
		return 0
	}
	return (2*n + 2) / 3
}

// EffectiveQuorum reports the quorum this node will actually enforce: the
// QUORUM override when set, otherwise DeriveQuorum over the validator set.
func (c *Config) EffectiveQuorum() int {
	if c.Quorum > 0 {
		return c.Quorum
	}
	return DeriveQuorum(len(c.ValidatorSet))
}

// loadConsensus parses the consensus half of the environment into cfg. It
// reports parse failures only; cross-field rules live in validateConsensus so
// that a hand-built Config (tests, cmd/audit) is checked by the same code.
func loadConsensus(cfg *Config, lookup lookupFunc, get func(key, def string) string, addf func(string, ...any)) {
	cfg.ConsensusMode = ConsensusMode(strings.ToLower(get("CONSENSUS_MODE", string(DefaultConsensusMode))))
	cfg.ValidatorID = strings.TrimSpace(get("VALIDATOR_ID", ""))
	cfg.ValidatorPrivateKey = strings.TrimSpace(get("VALIDATOR_PRIVATE_KEY", ""))
	cfg.ValidatorPrivateKeyFile = strings.TrimSpace(get("VALIDATOR_PRIVATE_KEY_FILE", ""))

	if raw := get("VALIDATOR_SET", ""); raw != "" {
		set, err := parseValidatorSet(raw)
		if err != nil {
			addf("VALIDATOR_SET: %w", err)
		} else {
			cfg.ValidatorSet = set
		}
	}

	if raw := get("CONSENSUS_PEERS", ""); raw != "" {
		peers, err := parseConsensusPeers(raw)
		if err != nil {
			addf("CONSENSUS_PEERS: %w", err)
		} else {
			cfg.ConsensusPeers = peers
		}
	}

	if raw := get("VALIDATOR_RPC_URLS", ""); raw != "" {
		urls, err := parseNamedURLs(raw)
		if err != nil {
			addf("VALIDATOR_RPC_URLS: %w", err)
		} else {
			cfg.ValidatorRPCURLs = urls
		}
	}

	if v, err := strconv.Atoi(get("ROUND_TIMEOUT_MS", strconv.Itoa(DefaultRoundTimeoutMS))); err != nil {
		addf("ROUND_TIMEOUT_MS must be an integer: %w", err)
	} else {
		cfg.RoundTimeoutMS = v
	}

	if raw := get("QUORUM", ""); raw != "" {
		if v, err := strconv.Atoi(raw); err != nil {
			addf("QUORUM must be an integer: %w", err)
		} else {
			cfg.Quorum = v
		}
	}

	_ = lookup // every consensus variable has a default or is optional
}

// parseValidatorSet reads "authority:0xabc…,jvp:0xdef…" into an ordered
// registry. Order is preserved because it is protocol-significant: the
// proposer for height H in round r is validators[(H+r) % N], so two nodes
// with the same members in a different order would disagree about whose turn
// it is and never make progress.
func parseValidatorSet(raw string) ([]ValidatorEntry, error) {
	var set []ValidatorEntry
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name, addr, ok := strings.Cut(part, ":")
		if !ok {
			return nil, fmt.Errorf("entry %q must be name:address", part)
		}
		name = strings.TrimSpace(name)
		addr = strings.TrimSpace(addr)
		if name == "" {
			return nil, fmt.Errorf("entry %q has an empty name", part)
		}
		if !common.IsHexAddress(addr) {
			return nil, fmt.Errorf("validator %q: %q is not a hex address", name, addr)
		}
		set = append(set, ValidatorEntry{Name: name, Address: common.HexToAddress(addr)})
	}
	if len(set) == 0 {
		return nil, fmt.Errorf("no entries found")
	}
	return set, nil
}

// parseConsensusPeers reads "jvp=https://10.0.1.5:4001,unp=https://…".
func parseConsensusPeers(raw string) ([]ConsensusPeer, error) {
	named, err := parseNamedURLs(raw)
	if err != nil {
		return nil, err
	}
	// Rebuild in the order given rather than ranging the map, so logs and
	// error messages are stable across runs.
	var peers []ConsensusPeer
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name, _, _ := strings.Cut(part, "=")
		name = strings.TrimSpace(name)
		peers = append(peers, ConsensusPeer{Name: name, P2PURL: named[name]})
	}
	return peers, nil
}

// parseNamedURLs reads "name=url,name=url" and validates each URL the way
// config.go's validURL does — scheme and host both required.
func parseNamedURLs(raw string) (map[string]string, error) {
	out := make(map[string]string)
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name, rawURL, ok := strings.Cut(part, "=")
		if !ok {
			return nil, fmt.Errorf("entry %q must be name=url", part)
		}
		name = strings.TrimSpace(name)
		rawURL = strings.TrimSpace(rawURL)
		if name == "" {
			return nil, fmt.Errorf("entry %q has an empty name", part)
		}
		if _, dup := out[name]; dup {
			return nil, fmt.Errorf("validator %q appears twice", name)
		}
		if err := validURL(rawURL); err != nil {
			return nil, fmt.Errorf("validator %q: %v", name, err)
		}
		out[name] = rawURL
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no entries found")
	}
	return out, nil
}

// ConsensusPrivateKeyHex returns this node's signing key as hex with no 0x
// prefix, reading VALIDATOR_PRIVATE_KEY_FILE in preference to the inline
// variable.
//
// The 0x prefix is stripped here rather than at the call site because
// crypto.HexToECDSA rejects it, and a key pasted from a wallet or from
// `cast wallet` has one — a mistake that would otherwise surface as
// "invalid hex character 'x'" with no hint about what to do.
func (c *Config) ConsensusPrivateKeyHex() (string, error) {
	raw := c.ValidatorPrivateKey
	if c.ValidatorPrivateKeyFile != "" {
		data, err := os.ReadFile(c.ValidatorPrivateKeyFile)
		if err != nil {
			return "", fmt.Errorf("VALIDATOR_PRIVATE_KEY_FILE: %w", err)
		}
		raw = strings.TrimSpace(string(data))
	}
	if raw == "" {
		return "", fmt.Errorf("no consensus signing key configured")
	}
	return strings.TrimPrefix(strings.TrimPrefix(raw, "0x"), "0X"), nil
}

// validateConsensus enforces every cross-field rule the consensus
// configuration has. Called from Config.Validate.
func (c *Config) validateConsensus(addf func(string, ...any)) {
	// The zero value is solo. load always sets this field, so an empty one
	// means a Config built by hand — a test, or cmd/audit's, which have no
	// interest in consensus — and defaulting rather than erroring keeps
	// "a Config you construct yourself is a solo node" true without every
	// such site having to say so.
	mode := c.ConsensusMode
	if mode == "" {
		mode = ConsensusModeSolo
	}
	if !validConsensusModes[mode] {
		addf("CONSENSUS_MODE must be %q or %q, got %q", ConsensusModeSolo, ConsensusModeBFT, c.ConsensusMode)
		return
	}

	if mode == ConsensusModeSolo {
		c.validateNoConsensusSettings(addf)
		return
	}

	c.validateBFT(addf)
}

// validateNoConsensusSettings rejects a solo node that carries BFT settings.
//
// Ignoring them would be friendlier and is exactly wrong. A node configured
// as a validator but running solo is the worst failure this system has: it
// seals blocks alone, on its own authority, while three peers believe they
// are voting on them — a silent regression from Byzantine fault tolerance to
// a single trusted party, in an election. Refusing to boot makes the mistake
// impossible to miss.
func (c *Config) validateNoConsensusSettings(addf func(string, ...any)) {
	set := map[string]bool{
		"VALIDATOR_ID":               c.ValidatorID != "",
		"VALIDATOR_PRIVATE_KEY":      c.ValidatorPrivateKey != "",
		"VALIDATOR_PRIVATE_KEY_FILE": c.ValidatorPrivateKeyFile != "",
		"VALIDATOR_SET":              len(c.ValidatorSet) > 0,
		"CONSENSUS_PEERS":            len(c.ConsensusPeers) > 0,
		"VALIDATOR_RPC_URLS":         len(c.ValidatorRPCURLs) > 0,
		"QUORUM":                     c.Quorum != 0,
	}
	// Sorted for a stable message; a cluster misconfigured this way is
	// usually misconfigured in several variables at once.
	for _, name := range []string{
		"CONSENSUS_PEERS", "QUORUM", "VALIDATOR_ID", "VALIDATOR_PRIVATE_KEY",
		"VALIDATOR_PRIVATE_KEY_FILE", "VALIDATOR_RPC_URLS", "VALIDATOR_SET",
	} {
		if set[name] {
			addf("%s is set but CONSENSUS_MODE is %q: set CONSENSUS_MODE=bft, or remove %s — a node that carries validator configuration while sealing blocks on its own authority is not what anyone intended", name, c.ConsensusMode, name)
		}
	}
}

func (c *Config) validateBFT(addf func(string, ...any)) {
	// A replica forwards writes and never seals; it has no vote. Allowing
	// ROLE=replica here would produce a node that holds a key, is counted in
	// the quorum, and can never propose — a permanent one-validator-short
	// cluster.
	if c.Role != RolePrimary {
		addf("ROLE must be %q when CONSENSUS_MODE=bft, got %q: every validator is a co-equal writer", RolePrimary, c.Role)
	}

	n := len(c.ValidatorSet)
	if n < MinValidators {
		addf("VALIDATOR_SET must list at least %d validators when CONSENSUS_MODE=bft, got %d: a smaller set cannot tolerate even one failure", MinValidators, n)
		return
	}

	names := make(map[string]bool, n)
	addrs := make(map[common.Address]string, n)
	for _, v := range c.ValidatorSet {
		if names[v.Name] {
			addf("VALIDATOR_SET lists %q twice", v.Name)
		}
		names[v.Name] = true
		if other, dup := addrs[v.Address]; dup {
			addf("VALIDATOR_SET gives %q and %q the same address %s: they would be one vote, not two", other, v.Name, v.Address)
		}
		addrs[v.Address] = v.Name
	}

	if c.ValidatorID == "" {
		addf("VALIDATOR_ID is required when CONSENSUS_MODE=bft")
	} else if !names[c.ValidatorID] {
		addf("VALIDATOR_ID %q is not in VALIDATOR_SET", c.ValidatorID)
	}

	c.validateSigningKey(addf, names)
	c.validateConsensusPeers(addf, names)

	if c.RoundTimeoutMS < MinRoundTimeoutMS {
		addf("ROUND_TIMEOUT_MS must be at least %d, got %d", MinRoundTimeoutMS, c.RoundTimeoutMS)
	}

	if c.Quorum != 0 {
		derived := DeriveQuorum(n)
		f := n - c.Quorum
		switch {
		case c.Quorum > n:
			addf("QUORUM %d exceeds the %d validators in VALIDATOR_SET: no block could ever finalize", c.Quorum, n)
		case c.Quorum <= n/2:
			addf("QUORUM %d is not a majority of %d validators: two disjoint quorums could finalize different blocks at the same height", c.Quorum, n)
		case c.Quorum < derived:
			addf("QUORUM %d is below the Byzantine threshold ceil(2*%d/3) = %d (it would tolerate %d faulty validators, which %d validators cannot): raise it or add validators", c.Quorum, n, derived, f, n)
		}
	}
}

// validateSigningKey checks the key parses and — the check that matters —
// that it is the key this node is *listed* under.
//
// A validator signing with an identity nobody counts is invisible: its
// messages verify as coming from an unknown address and are dropped, so the
// cluster silently runs one validator short. With N=4 that turns a
// fault-tolerant cluster into one that halts on the next single failure, and
// nothing in the logs says why. Catching it at boot costs one ECDSA
// derivation.
func (c *Config) validateSigningKey(addf func(string, ...any), names map[string]bool) {
	if c.ValidatorPrivateKey == "" && c.ValidatorPrivateKeyFile == "" {
		addf("VALIDATOR_PRIVATE_KEY or VALIDATOR_PRIVATE_KEY_FILE is required when CONSENSUS_MODE=bft")
		return
	}

	hexKey, err := c.ConsensusPrivateKeyHex()
	if err != nil {
		addf("%v", err)
		return
	}
	key, err := crypto.HexToECDSA(hexKey)
	if err != nil {
		addf("consensus signing key is not a valid secp256k1 private key: %v", err)
		return
	}

	if c.ValidatorID == "" || !names[c.ValidatorID] {
		return // already reported; nothing to compare against
	}
	derived := crypto.PubkeyToAddress(key.PublicKey)
	for _, v := range c.ValidatorSet {
		if v.Name == c.ValidatorID {
			if v.Address != derived {
				addf("the consensus signing key derives to %s, but VALIDATOR_SET lists %q as %s: this node would sign with an identity no peer counts, leaving the cluster permanently one validator short", derived, v.Name, v.Address)
			}
			return
		}
	}
}

// validateConsensusPeers checks this node can reach every other validator.
// A missing peer is a hard error rather than degraded operation: with N=4 and
// Q=3 there is exactly one failure of slack, and spending it on a typo in
// configuration rather than on a machine that actually died is not a trade
// worth making silently.
func (c *Config) validateConsensusPeers(addf func(string, ...any), names map[string]bool) {
	if len(c.ConsensusPeers) == 0 {
		// Worded as "must list" rather than "is required" because this also
		// fires when CONSENSUS_PEERS was set but failed to parse, in which
		// case the joined error already carries the parse failure and
		// "is required" would contradict it.
		addf("CONSENSUS_PEERS must list every other validator's P2P URL as name=url when CONSENSUS_MODE=bft")
		return
	}

	seen := make(map[string]bool, len(c.ConsensusPeers))
	for _, p := range c.ConsensusPeers {
		if !names[p.Name] {
			addf("CONSENSUS_PEERS names %q, which is not in VALIDATOR_SET", p.Name)
		}
		if p.Name == c.ValidatorID {
			addf("CONSENSUS_PEERS lists this node (%q); it must contain only the *other* validators", p.Name)
		}
		seen[p.Name] = true
	}

	for _, v := range c.ValidatorSet {
		if v.Name == c.ValidatorID || seen[v.Name] {
			continue
		}
		addf("CONSENSUS_PEERS has no entry for validator %q: this node could never receive its votes, so a quorum would need every remaining validator to be up", v.Name)
	}

	for name := range c.ValidatorRPCURLs {
		if !names[name] {
			addf("VALIDATOR_RPC_URLS names %q, which is not in VALIDATOR_SET", name)
		}
	}
}
