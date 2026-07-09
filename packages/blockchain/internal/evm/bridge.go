package evm

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"sync"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	gethvm "github.com/ethereum/go-ethereum/core/vm"
	"github.com/ethereum/go-ethereum/crypto"
)

// AdminAddress is the fixed authority address used as the Voting contract deployer/owner.
// Every admin EVM call (addVoters, getVotingData) originates from this address.
// It is a constant so contract addresses derived via CREATE are always identical
// regardless of which session deploys them.
var AdminAddress = common.HexToAddress("0x0000000000000000000000000000000000001337")

// Solidity library placeholder strings embedded in the Hardhat-compiled bytecode.
// Each placeholder is exactly 40 characters (same width as an address hex) and is
// replaced by the deployed library address before the dependent contract is deployed.
const (
	// leanIMTPlaceholder appears in Voting.sol's creation bytecode.
	// It encodes keccak256("@zk-kit/lean-imt.sol/LeanIMT.sol:LeanIMT")[0:17].
	leanIMTPlaceholder = "__$99c94127c8f73905b08f2d52133ba9abca$__"
	// poseidonT3Placeholder appears in LeanIMT's creation bytecode.
	// It encodes keccak256("poseidon-solidity/PoseidonT3.sol:PoseidonT3")[0:17].
	poseidonT3Placeholder = "__$75f79a42d9bcbdbb69ad79ebd80f556f39$__"
)

// ContractBridge is the single point of integration between the Go blockchain and
// the Solidity contracts running inside the embedded EVM. It deploys the contracts
// on first call and exposes typed methods for each Solidity function.
type ContractBridge struct {
	caller     *ContractCaller
	votingAddr common.Address
	votingABI  abi.ABI

	// mu serializes every call into the EVM. go-ethereum's state.StateDB (the
	// trie/journal backing cc.evm) is built for single-threaded, one-call-at-a-time
	// execution — it is not safe for concurrent Call/Create. Without this lock,
	// concurrent HTTP handlers (vote, register, add-voter) and P2P block replay
	// racing on the same StateDB can corrupt state or panic. Every exported method
	// below acquires mu for the duration of its EVM interaction; internal helpers
	// suffixed "Locked" assume the caller already holds it.
	mu sync.Mutex

	// votingDataCache and voterDataCache memoize the last-read result of
	// getVotingData()/getVoterData() so that repeated reads (e.g. polling
	// GET /voting-data) don't re-run an EVM call every time. Both are guarded
	// by mu, so no separate cache lock is needed. Entries are invalidated
	// (never eagerly recomputed for voterDataCache, eagerly recomputed for
	// votingDataCache) by the write method that changed the underlying state —
	// see AddVoter/Register/Vote below for the exact invalidation rules.
	votingDataCache *VotingData
	voterDataCache  map[string]*VoterData // keyed by voterID (not address)
}

// Phase mirrors Voting.sol's Phase enum (uint8 on the wire).
type Phase uint8

const (
	PhaseSetup Phase = iota
	PhaseRegistration
	PhaseVoting
	PhaseEnded
)

// String returns the human-readable phase name, matching the frontend's
// PHASE_LABELS array (packages/nextjs/app/voting/admin/page.tsx).
func (p Phase) String() string {
	switch p {
	case PhaseSetup:
		return "Setup"
	case PhaseRegistration:
		return "Registration"
	case PhaseVoting:
		return "Voting"
	case PhaseEnded:
		return "Ended"
	default:
		return "Unknown"
	}
}

// MarshalJSON encodes Phase as its numeric value, matching the raw uint8 the
// Solidity ABI returns — callers that want the label use PhaseLabel below.
func (p Phase) MarshalJSON() ([]byte, error) {
	return []byte(fmt.Sprintf("%d", uint8(p))), nil
}

// VotingData mirrors the return value of Voting.getVotingData().
type VotingData struct {
	Question            string         `json:"question"`
	Owner               common.Address `json:"owner"`
	Phase               Phase          `json:"phase"`
	PhaseLabel          string         `json:"phase_label"`
	RegistrationEndTime *big.Int       `json:"registration_end_time"`
	VotingEndTime       *big.Int       `json:"voting_end_time"`
	TreeSize            *big.Int       `json:"tree_size"`
	Depth               *big.Int       `json:"depth"`
	Root                *big.Int       `json:"root"`
	CandidateCount      *big.Int       `json:"candidate_count"`
}

// VoterData mirrors the return value of Voting.getVoterData().
type VoterData struct {
	Allowed    bool `json:"allowed"`
	Registered bool `json:"registered"`
}

// NewContractBridge deploys all required contracts into the EVM and returns a
// bridge ready for use. assetsDir must contain HonkVerifier.json, PoseidonT3.json,
// LeanIMT.json, and Voting.json (Hardhat artifact format).
//
// candidates seeds the contract's initial candidate list (may be empty — the
// election then starts with none configured, until SetCandidates is called).
// This mirrors packages/hardhat/deploy/00_deploy_your_contract.ts, which passes
// ["Yes", "No"] as the default initialCandidates at deploy time.
//
// Deployment order (deterministic because AdminAddress and nonce are fixed):
//
//	nonce 0 → HonkVerifier  (no library deps, no constructor args)
//	nonce 1 → PoseidonT3    (no library deps, no constructor args)
//	nonce 2 → LeanIMT       (links PoseidonT3, no constructor args)
//	nonce 3 → Voting        (links LeanIMT, constructor: admin, verifier, question, candidates)
func NewContractBridge(caller *ContractCaller, assetsDir, question string, candidates []string) (*ContractBridge, error) {
	// ── 1. Deploy HonkVerifier (no library deps) ──────────────────────────────
	verifierArtifact, err := loadArtifact(assetsDir, "HonkVerifier.json")
	if err != nil {
		return nil, fmt.Errorf("HonkVerifier artifact: %w", err)
	}
	verifierBytecode, err := verifierArtifact.decodedBytecode()
	if err != nil {
		return nil, fmt.Errorf("HonkVerifier bytecode: %w", err)
	}
	verifierAddr, _, err := caller.Deploy(AdminAddress, verifierBytecode)
	if err != nil {
		return nil, fmt.Errorf("deploy HonkVerifier: %w", err)
	}

	// ── 2. Deploy PoseidonT3 (no library deps) ────────────────────────────────
	poseidonArtifact, err := loadArtifact(assetsDir, "PoseidonT3.json")
	if err != nil {
		return nil, fmt.Errorf("PoseidonT3 artifact: %w", err)
	}
	poseidonBytecode, err := poseidonArtifact.decodedBytecode()
	if err != nil {
		return nil, fmt.Errorf("PoseidonT3 bytecode: %w", err)
	}
	poseidonAddr, _, err := caller.Deploy(AdminAddress, poseidonBytecode)
	if err != nil {
		return nil, fmt.Errorf("deploy PoseidonT3: %w", err)
	}

	// ── 3. Link PoseidonT3 → deploy LeanIMT ──────────────────────────────────
	leanIMTArtifact, err := loadArtifact(assetsDir, "LeanIMT.json")
	if err != nil {
		return nil, fmt.Errorf("LeanIMT artifact: %w", err)
	}
	leanIMTBytecode, err := leanIMTArtifact.decodedLinkedBytecode(map[string]string{
		poseidonT3Placeholder: hex.EncodeToString(poseidonAddr.Bytes()),
	})
	if err != nil {
		return nil, fmt.Errorf("LeanIMT linked bytecode: %w", err)
	}
	leanIMTAddr, _, err := caller.Deploy(AdminAddress, leanIMTBytecode)
	if err != nil {
		return nil, fmt.Errorf("deploy LeanIMT: %w", err)
	}

	// ── 4. Link LeanIMT → deploy Voting(admin, verifier, question) ───────────
	votingArtifact, err := loadArtifact(assetsDir, "Voting.json")
	if err != nil {
		return nil, fmt.Errorf("Voting artifact: %w", err)
	}
	votingABI, err := votingArtifact.parsedABI()
	if err != nil {
		return nil, fmt.Errorf("parse Voting ABI: %w", err)
	}
	votingBytecode, err := votingArtifact.decodedLinkedBytecode(map[string]string{
		leanIMTPlaceholder: hex.EncodeToString(leanIMTAddr.Bytes()),
	})
	if err != nil {
		return nil, fmt.Errorf("Voting linked bytecode: %w", err)
	}
	constructorArgs, err := votingABI.Pack("", AdminAddress, verifierAddr, question, candidates)
	if err != nil {
		return nil, fmt.Errorf("encode Voting constructor: %w", err)
	}
	initCode := append(votingBytecode, constructorArgs...)
	votingAddr, _, err := caller.Deploy(AdminAddress, initCode)
	if err != nil {
		return nil, fmt.Errorf("deploy Voting: %w", err)
	}

	return &ContractBridge{
		caller:         caller,
		votingAddr:     votingAddr,
		votingABI:      votingABI,
		voterDataCache: make(map[string]*VoterData),
	}, nil
}

// VotingAddress returns the address of the deployed Voting contract.
func (b *ContractBridge) VotingAddress() common.Address { return b.votingAddr }

// ─── Voter identity ───────────────────────────────────────────────────────────

// VoterIDToAddress derives a deterministic Ethereum address from a string voter ID.
// The mapping is: keccak256(voterID)[12:], which produces a unique 20-byte address.
// The same voter ID always produces the same address across sessions, enabling
// the Solidity address-based identity model to work with our string voter IDs.
func VoterIDToAddress(voterID string) common.Address {
	hash := crypto.Keccak256([]byte(voterID))
	var addr common.Address
	copy(addr[:], hash[12:])
	return addr
}

// ─── Write methods ────────────────────────────────────────────────────────────

// AddVoter calls addVoters([voterAddr], [allowed]) on the Voting contract as the
// admin. This adds or revokes a voter's eligibility to register.
func (b *ContractBridge) AddVoter(voterID string, allowed bool) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	voterAddr := VoterIDToAddress(voterID)
	data, err := b.votingABI.Pack("addVoters",
		[]common.Address{voterAddr},
		[]bool{allowed},
	)
	if err != nil {
		return fmt.Errorf("encode addVoters: %w", err)
	}
	ret, _, evmErr := b.caller.Call(AdminAddress, b.votingAddr, data)
	if err := b.wrapErr(evmErr, ret, "addVoters"); err != nil {
		return err
	}

	// addVoters only changes s_voters[voterAddr] (the Allowed flag), which is
	// not part of VotingData, so only this voter's cache entry is stale.
	delete(b.voterDataCache, voterID)
	return nil
}

// Register calls register(commitment) on the Voting contract. The call originates
// from the voter's derived address so that Voting.sol's msg.sender checks pass.
// commitmentHex is a hex-encoded Poseidon field element (with or without 0x prefix).
//
// On success it returns the leaf's index in the Merkle tree (s_tree.size-1 at the
// moment of insertion), read from the EVM while still holding the bridge lock so
// the value is exact even under concurrent registrations — it is never derived
// from a count of blockchain transactions, which could include entries that were
// later rejected by EVM replay.
func (b *ContractBridge) Register(voterID, commitmentHex string) (uint64, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	commitment, err := hexToBigInt(commitmentHex)
	if err != nil {
		return 0, fmt.Errorf("decode commitment hex: %w", err)
	}
	data, err := b.votingABI.Pack("register", commitment)
	if err != nil {
		return 0, fmt.Errorf("encode register: %w", err)
	}
	voterAddr := VoterIDToAddress(voterID)
	ret, _, evmErr := b.caller.Call(voterAddr, b.votingAddr, data)
	if err := b.wrapErr(evmErr, ret, "register"); err != nil {
		return 0, err
	}

	// register() changes s_hasRegistered[voterAddr] (this voter's cache entry)
	// and s_tree (TreeSize/Depth/Root, part of VotingData) — invalidate both.
	// votingDataCache is invalidated (not just deleted) by getVotingDataLocked
	// unconditionally re-fetching below, which also re-populates it.
	delete(b.voterDataCache, voterID)
	b.votingDataCache = nil

	votingData, err := b.getVotingDataLocked()
	if err != nil {
		return 0, fmt.Errorf("register succeeded but failed to read tree size: %w", err)
	}
	if votingData.TreeSize.Sign() <= 0 {
		return 0, fmt.Errorf("register succeeded but tree size is %s (expected >= 1)", votingData.TreeSize)
	}
	return votingData.TreeSize.Uint64() - 1, nil
}

// Vote calls vote(_proof, _nullifierHash, _root, _vote, _depth) on the Voting
// contract. The EVM executes the embedded HonkVerifier to check the ZK proof.
// candidateIndex is the 0-based index into the candidate list (bound-checked by
// the contract against getCandidates()'s length; also range-checked to 8 bits by
// the Noir circuit itself — see packages/circuits/src/main.nr).
// Returns a descriptive error if the proof is invalid, the nullifier is already
// used, the Merkle root is stale, or the candidate index is out of range.
// Returns nil if the vote is accepted.
func (b *ContractBridge) Vote(proofHex, nullifierHashHex, rootHex string, candidateIndex uint64, depth uint32) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	proofBytes, err := hexToBytes(proofHex)
	if err != nil {
		return fmt.Errorf("decode proof hex: %w", err)
	}
	nullifierHash, err := hexToBytes32(nullifierHashHex)
	if err != nil {
		return fmt.Errorf("decode nullifier_hash: %w", err)
	}
	root, err := hexToBytes32(rootHex)
	if err != nil {
		return fmt.Errorf("decode root: %w", err)
	}

	// Solidity `bytes32 _vote` encodes the candidate index as a 32-byte
	// big-endian value (same encoding style as `_depth` below).
	var voteB32 [32]byte
	binary.BigEndian.PutUint64(voteB32[24:], candidateIndex)

	// Solidity `bytes32 _depth` encodes the uint32 depth as a 32-byte big-endian value.
	var depthB32 [32]byte
	binary.BigEndian.PutUint32(depthB32[28:], depth)

	data, err := b.votingABI.Pack("vote", proofBytes, nullifierHash, root, voteB32, depthB32)
	if err != nil {
		return fmt.Errorf("encode vote: %w", err)
	}
	ret, _, evmErr := b.caller.Call(AdminAddress, b.votingAddr, data)
	if err := b.wrapErr(evmErr, ret, "vote"); err != nil {
		return err
	}

	// vote() changes s_voteCounts, not part of VotingData directly but read via
	// GetVoteCounts (always live, uncached — see below). It is not tied to a
	// specific voterID (anonymous by design), so no voterDataCache entry needs
	// invalidating, and VotingData itself (question/phase/tree/etc.) is unaffected
	// by a vote, so votingDataCache does NOT need invalidating either.
	return nil
}

// SetQuestion calls setQuestion(question) on the Voting contract as the admin.
// Only effective during Phase.Setup; reverts with Voting__WrongPhase otherwise.
func (b *ContractBridge) SetQuestion(question string) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	data, err := b.votingABI.Pack("setQuestion", question)
	if err != nil {
		return fmt.Errorf("encode setQuestion: %w", err)
	}
	ret, _, evmErr := b.caller.Call(AdminAddress, b.votingAddr, data)
	if err := b.wrapErr(evmErr, ret, "setQuestion"); err != nil {
		return err
	}
	b.votingDataCache = nil
	return nil
}

// SetCandidates calls setCandidates(candidates) on the Voting contract as the
// admin, replacing the entire candidate list. Only effective during Phase.Setup.
func (b *ContractBridge) SetCandidates(candidates []string) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	data, err := b.votingABI.Pack("setCandidates", candidates)
	if err != nil {
		return fmt.Errorf("encode setCandidates: %w", err)
	}
	ret, _, evmErr := b.caller.Call(AdminAddress, b.votingAddr, data)
	if err := b.wrapErr(evmErr, ret, "setCandidates"); err != nil {
		return err
	}
	b.votingDataCache = nil
	return nil
}

// StartRegistration calls startRegistration(durationSec) on the Voting contract
// as the admin, moving Setup → Registration and opening a registration window of
// the given length. Reverts if not in Setup, if durationSec is 0, or if no
// candidates are configured yet.
func (b *ContractBridge) StartRegistration(durationSec uint64) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	data, err := b.votingABI.Pack("startRegistration", new(big.Int).SetUint64(durationSec))
	if err != nil {
		return fmt.Errorf("encode startRegistration: %w", err)
	}
	ret, _, evmErr := b.caller.Call(AdminAddress, b.votingAddr, data)
	if err := b.wrapErr(evmErr, ret, "startRegistration"); err != nil {
		return err
	}
	b.votingDataCache = nil
	return nil
}

// StartVoting calls startVoting(durationSec) on the Voting contract as the
// admin, moving Registration → Voting and opening a voting window of the given
// length. Reverts if not in Registration or if durationSec is 0.
func (b *ContractBridge) StartVoting(durationSec uint64) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	data, err := b.votingABI.Pack("startVoting", new(big.Int).SetUint64(durationSec))
	if err != nil {
		return fmt.Errorf("encode startVoting: %w", err)
	}
	ret, _, evmErr := b.caller.Call(AdminAddress, b.votingAddr, data)
	if err := b.wrapErr(evmErr, ret, "startVoting"); err != nil {
		return err
	}
	b.votingDataCache = nil
	return nil
}

// EndElection calls endElection() on the Voting contract as the admin, ending
// the election early (Registration or Voting → Ended). Reverts if already in
// Setup or Ended.
func (b *ContractBridge) EndElection() error {
	b.mu.Lock()
	defer b.mu.Unlock()

	data, err := b.votingABI.Pack("endElection")
	if err != nil {
		return fmt.Errorf("encode endElection: %w", err)
	}
	ret, _, evmErr := b.caller.Call(AdminAddress, b.votingAddr, data)
	if err := b.wrapErr(evmErr, ret, "endElection"); err != nil {
		return err
	}
	b.votingDataCache = nil
	return nil
}

// ResetElection calls resetElection() on the Voting contract as the admin.
// Callable from any phase; clears the question, candidates, voter allowlist,
// registrations, commitments, nullifiers, votes, and Merkle tree, bumps the
// contract's internal electionId, and returns to Phase.Setup.
//
// Unlike the other write methods, this invalidates the ENTIRE voterDataCache
// (not a per-voter delete) because every previously cached voter's
// allowed/registered flags belong to the now-dead election — the contract's
// electionId bump means a fresh getVoterData call for the same address would
// read back false/false until re-added in the new election.
func (b *ContractBridge) ResetElection() error {
	b.mu.Lock()
	defer b.mu.Unlock()

	data, err := b.votingABI.Pack("resetElection")
	if err != nil {
		return fmt.Errorf("encode resetElection: %w", err)
	}
	ret, _, evmErr := b.caller.Call(AdminAddress, b.votingAddr, data)
	if err := b.wrapErr(evmErr, ret, "resetElection"); err != nil {
		return err
	}
	b.votingDataCache = nil
	b.voterDataCache = make(map[string]*VoterData)
	return nil
}

// ─── Read methods ─────────────────────────────────────────────────────────────

// GetCandidates calls getCandidates() and returns the current candidate list.
// Always a live EVM call — not cached, since it's cheap and changes only during
// Setup (a narrow, low-traffic window compared to VotingData/VoterData reads).
func (b *ContractBridge) GetCandidates() ([]string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	data, err := b.votingABI.Pack("getCandidates")
	if err != nil {
		return nil, fmt.Errorf("encode getCandidates: %w", err)
	}
	ret, _, evmErr := b.caller.Call(AdminAddress, b.votingAddr, data)
	if evmErr != nil {
		return nil, b.wrapErr(evmErr, ret, "getCandidates")
	}
	result, err := b.votingABI.Unpack("getCandidates", ret)
	if err != nil {
		return nil, fmt.Errorf("decode getCandidates result: %w", err)
	}
	if len(result) != 1 {
		return nil, fmt.Errorf("getCandidates: expected 1 return value, got %d", len(result))
	}
	return result[0].([]string), nil
}

// GetVoteCounts calls getVoteCounts() and returns the current tally, indexed the
// same as GetCandidates (counts[i] is the vote count for candidate i). Always a
// live EVM call — not cached, since tallies change on every accepted vote and a
// stale cache here would be directly user-visible on the results page.
func (b *ContractBridge) GetVoteCounts() ([]*big.Int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	data, err := b.votingABI.Pack("getVoteCounts")
	if err != nil {
		return nil, fmt.Errorf("encode getVoteCounts: %w", err)
	}
	ret, _, evmErr := b.caller.Call(AdminAddress, b.votingAddr, data)
	if evmErr != nil {
		return nil, b.wrapErr(evmErr, ret, "getVoteCounts")
	}
	result, err := b.votingABI.Unpack("getVoteCounts", ret)
	if err != nil {
		return nil, fmt.Errorf("decode getVoteCounts result: %w", err)
	}
	if len(result) != 1 {
		return nil, fmt.Errorf("getVoteCounts: expected 1 return value, got %d", len(result))
	}
	return result[0].([]*big.Int), nil
}

// GetVotingData calls getVotingData() and returns the current state of the election.
func (b *ContractBridge) GetVotingData() (*VotingData, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.getVotingDataLocked()
}

// getVotingDataLocked is the caching, lock-free implementation of GetVotingData.
// Callers must already hold b.mu (used internally by Register to read back
// the tree size within the same critical section as the insert). Returns the
// cached value if present; write methods (AddVoter/Register/Vote) are
// responsible for setting b.votingDataCache = nil whenever they change any of
// VotingData's underlying fields.
func (b *ContractBridge) getVotingDataLocked() (*VotingData, error) {
	if b.votingDataCache != nil {
		return b.votingDataCache, nil
	}
	votingData, err := b.fetchVotingDataLocked()
	if err != nil {
		return nil, err
	}
	b.votingDataCache = votingData
	return votingData, nil
}

// fetchVotingDataLocked always performs a live EVM call, bypassing the cache.
func (b *ContractBridge) fetchVotingDataLocked() (*VotingData, error) {
	data, err := b.votingABI.Pack("getVotingData")
	if err != nil {
		return nil, fmt.Errorf("encode getVotingData: %w", err)
	}
	ret, _, evmErr := b.caller.Call(AdminAddress, b.votingAddr, data)
	if evmErr != nil {
		return nil, b.wrapErr(evmErr, ret, "getVotingData")
	}
	result, err := b.votingABI.Unpack("getVotingData", ret)
	if err != nil {
		return nil, fmt.Errorf("decode getVotingData result: %w", err)
	}
	if len(result) != 9 {
		return nil, fmt.Errorf("getVotingData: expected 9 return values, got %d", len(result))
	}
	return &VotingData{
		Question:            result[0].(string),
		Owner:               result[1].(common.Address),
		Phase:               Phase(result[2].(uint8)),
		PhaseLabel:          Phase(result[2].(uint8)).String(),
		RegistrationEndTime: result[3].(*big.Int),
		VotingEndTime:       result[4].(*big.Int),
		TreeSize:            result[5].(*big.Int),
		Depth:               result[6].(*big.Int),
		Root:                result[7].(*big.Int),
		CandidateCount:      result[8].(*big.Int),
	}, nil
}

// GetVoterData calls getVoterData(voterAddr) and returns the voter's on-chain status.
// Results are cached per voterID; AddVoter and Register invalidate the entry for
// the voter they touched.
func (b *ContractBridge) GetVoterData(voterID string) (*VoterData, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if cached, ok := b.voterDataCache[voterID]; ok {
		return cached, nil
	}

	voterAddr := VoterIDToAddress(voterID)
	data, err := b.votingABI.Pack("getVoterData", voterAddr)
	if err != nil {
		return nil, fmt.Errorf("encode getVoterData: %w", err)
	}
	ret, _, evmErr := b.caller.Call(AdminAddress, b.votingAddr, data)
	if evmErr != nil {
		return nil, b.wrapErr(evmErr, ret, "getVoterData")
	}
	result, err := b.votingABI.Unpack("getVoterData", ret)
	if err != nil {
		return nil, fmt.Errorf("decode getVoterData result: %w", err)
	}
	if len(result) != 2 {
		return nil, fmt.Errorf("getVoterData: expected 2 return values, got %d", len(result))
	}
	voterData := &VoterData{
		Allowed:    result[0].(bool),
		Registered: result[1].(bool),
	}
	b.voterDataCache[voterID] = voterData
	return voterData, nil
}

// ─── Error decoding ───────────────────────────────────────────────────────────

// wrapErr converts an EVM error into a human-readable Go error.
// When the EVM reverts, `ret` holds the ABI-encoded revert reason — either a
// standard Error(string), a Panic(uint256), or a custom error defined in the ABI.
func (b *ContractBridge) wrapErr(evmErr error, ret []byte, callSite string) error {
	if evmErr == nil {
		return nil
	}

	// Only attempt to decode revert data if the EVM actually reverted.
	// Other failures (out-of-gas, invalid opcode) don't carry ABI-encoded reasons.
	if errors.Is(evmErr, gethvm.ErrExecutionReverted) && len(ret) > 0 {
		// Standard Error(string) / Panic(uint256)
		if msg, err := abi.UnpackRevert(ret); err == nil {
			return fmt.Errorf("%s reverted: %s", callSite, msg)
		}

		// Custom Solidity errors from the Voting ABI
		if len(ret) >= 4 {
			selector := ret[:4]
			for name, errDef := range b.votingABI.Errors {
				if bytes.Equal(errDef.ID[:4], selector) {
					if len(ret) > 4 && len(errDef.Inputs) > 0 {
						vals, err := errDef.Inputs.Unpack(ret[4:])
						if err == nil && len(vals) > 0 {
							return fmt.Errorf("%s reverted: %s(%v)", callSite, name, vals[0])
						}
					}
					return fmt.Errorf("%s reverted: %s", callSite, name)
				}
			}
			// Unknown selector — return raw hex for debugging
			return fmt.Errorf("%s reverted (0x%x)", callSite, ret)
		}
	}

	return fmt.Errorf("%s: %w", callSite, evmErr)
}

// ─── Hex helpers ──────────────────────────────────────────────────────────────

// hexToBigInt converts a hex string (with or without 0x prefix) to *big.Int.
func hexToBigInt(h string) (*big.Int, error) {
	h = strings.TrimPrefix(h, "0x")
	b, err := hex.DecodeString(normalizeHex(h))
	if err != nil {
		return nil, err
	}
	return new(big.Int).SetBytes(b), nil
}

// hexToBytes converts a hex string (with or without 0x prefix) to []byte.
func hexToBytes(h string) ([]byte, error) {
	h = strings.TrimPrefix(h, "0x")
	return hex.DecodeString(normalizeHex(h))
}

// hexToBytes32 converts a hex string to a right-aligned [32]byte (big-endian).
func hexToBytes32(h string) ([32]byte, error) {
	b, err := hexToBytes(h)
	if err != nil {
		return [32]byte{}, err
	}
	if len(b) > 32 {
		return [32]byte{}, fmt.Errorf("value is %d bytes, max 32", len(b))
	}
	var out [32]byte
	copy(out[32-len(b):], b) // right-align in big-endian
	return out, nil
}

// normalizeHex ensures a hex string has an even number of characters.
func normalizeHex(h string) string {
	if len(h)%2 != 0 {
		return "0" + h
	}
	return h
}
