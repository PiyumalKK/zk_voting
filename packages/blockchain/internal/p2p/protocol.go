package p2p

import (
	"fmt"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/rlp"
)

// The P2P wire format (MASTER §3, M10 deliverable 2): HTTPS over mTLS,
// JSON envelopes, blocks carried as RLP hex.
//
// Why RLP inside JSON rather than a JSON block object: RLP is the encoding
// the block hash is defined over. Re-serialising a block into JSON fields
// and back would make the receiving node's view of it depend on this
// package's marshalling choices, and any asymmetry there — a nil versus
// empty withdrawals list, say (see finalizeBlock's note in
// internal/chain/seal.go, where exactly that cost a debugging session) —
// changes the hash. Shipping the canonical encoding removes the question:
// the bytes a replica verifies are the bytes the primary sealed.
//
// The JSON envelope around it is for operability. A `curl` against
// /p2p/head or /p2p/blocks?from=1 returns something legible, and the error
// bodies carry a machine-readable code the follower acts on.

// Endpoint paths.
const (
	PathBlock  = "/p2p/block"
	PathBlocks = "/p2p/blocks"
	PathHead   = "/p2p/head"

	// PathConsensus receives one signed BFT consensus message
	// (CONSENSUS_MODE=bft). Registered only on a validator; a solo node does
	// not serve it, so a stray consensus message to a solo cluster gets a 404
	// rather than being quietly accepted.
	PathConsensus = "/p2p/consensus"
	// PathCommitSeals serves the commit certificates for a range of blocks,
	// so a validator that fell behind can fetch the seals alongside the
	// blocks it pulls from /p2p/blocks.
	PathCommitSeals = "/p2p/commitseals"
)

// DefaultPullLimit is how many blocks one catch-up request asks for when the
// caller does not say (M10 deliverable 2's `limit=500`). MaxPullLimit is the
// server's ceiling: a peer asking for more gets this many, so one request
// can never be made to buffer an unbounded slice of the chain.
const (
	DefaultPullLimit = 500
	MaxPullLimit     = 500
)

// Push outcomes reported by POST /p2p/block.
const (
	// StatusApplied: the block was verified and is now this node's head.
	StatusApplied = "applied"
	// StatusDuplicate: this node already had exactly this block. A success —
	// pushes are at-least-once (see pusher.go's retry queue).
	StatusDuplicate = "duplicate"
)

// Error codes carried in ErrorResponse.Code. They exist so the follower can
// react programmatically (a gap is self-healing, a mismatch never is)
// without parsing prose, and so an operator reading a 409 can tell the two
// apart at a glance.
const (
	// CodeGap: the block is ahead of this node's head; the missing blocks
	// must be pulled. Expected carries the block this node needs next.
	CodeGap = "gap"
	// CodeStateMismatch: re-execution disagreed with the block's header.
	// This is the tamper-evidence signal — never routine.
	CodeStateMismatch = "state-mismatch"
	// CodeFork: a different block already occupies that height here.
	CodeFork = "fork"
	// CodeMalformed: the request body was not a decodable block.
	CodeMalformed = "malformed"
	// CodeRefused: this endpoint is not available in this node's role — a
	// primary does not accept pushed blocks.
	CodeRefused = "refused"
	// CodeInternal: this node failed for reasons of its own (unreadable
	// database, most likely). Not a judgement about the block.
	CodeInternal = "internal"
	// CodeNotAValidator: a consensus message arrived at a node that is not
	// running consensus, or the endpoint was reached on a solo node. Distinct
	// from CodeRefused so an operator can tell "wrong role" from "wrong
	// consensus mode" — the likeliest mistake during a rollout.
	CodeNotAValidator = "not-a-validator"
)

// BlockMessage is one block on the wire: its number, and its canonical RLP
// encoding as a 0x-prefixed hex string.
//
// The number is redundant — it is inside the RLP — and deliberately so. It
// lets the receiver log and route a push without decoding, keeps
// /p2p/blocks responses readable by eye, and is checked against the decoded
// header (Decode below), which turns a confused or malicious sender into an
// error at the edge instead of a mystery later.
type BlockMessage struct {
	Number uint64        `json:"number"`
	RLP    hexutil.Bytes `json:"rlp"`
}

// EncodeBlock renders a block for transmission.
func EncodeBlock(block *types.Block) (BlockMessage, error) {
	encoded, err := rlp.EncodeToBytes(block)
	if err != nil {
		return BlockMessage{}, fmt.Errorf("rlp-encode block %d: %w", block.NumberU64(), err)
	}
	return BlockMessage{Number: block.NumberU64(), RLP: encoded}, nil
}

// Decode turns a received message back into a block, rejecting a payload
// whose header disagrees with the envelope.
func (m BlockMessage) Decode() (*types.Block, error) {
	if len(m.RLP) == 0 {
		return nil, fmt.Errorf("block %d: empty rlp payload", m.Number)
	}
	block := new(types.Block)
	if err := rlp.DecodeBytes(m.RLP, block); err != nil {
		return nil, fmt.Errorf("rlp-decode block %d: %w", m.Number, err)
	}
	if got := block.NumberU64(); got != m.Number {
		return nil, fmt.Errorf("envelope claims block %d but the payload is block %d", m.Number, got)
	}
	return block, nil
}

// HeadResponse is GET /p2p/head. The hash matters as much as the number: two
// nodes can agree on a height and disagree on every block in it, so "am I
// synced?" is a question about the hash.
type HeadResponse struct {
	Number uint64      `json:"number"`
	Hash   common.Hash `json:"hash"`
}

// BlocksResponse is GET /p2p/blocks. Head is the serving node's height at
// the time of the response, so a caller catching up knows how much further
// it has to go without a second round trip.
type BlocksResponse struct {
	Head   uint64         `json:"head"`
	Blocks []BlockMessage `json:"blocks"`
}

// PushResponse is a successful POST /p2p/block.
type PushResponse struct {
	Status string `json:"status"`
	Number uint64 `json:"number"`
}

// SealsResponse is GET /p2p/commitseals?from=&to=. Blocks with no recorded
// certificate are simply absent from Seals rather than present-and-empty: a
// missing certificate is a normal state (blocks sealed before consensus was
// enabled have none) and must not be confused with "this block was finalized
// by nobody".
type SealsResponse struct {
	Head  uint64          `json:"head"`
	Seals []SealsForBlock `json:"seals"`
}

// SealsForBlock is one block's commit certificate on the wire.
type SealsForBlock struct {
	Number    uint64          `json:"number"`
	BlockHash common.Hash     `json:"blockHash"`
	Round     uint32          `json:"round"`
	Seals     []hexutil.Bytes `json:"seals"`
}

// ErrorResponse is the body of every non-2xx P2P response.
type ErrorResponse struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	// Expected is set only for CodeGap: the block number the responding
	// node needs next.
	Expected uint64 `json:"expected,omitempty"`
}
