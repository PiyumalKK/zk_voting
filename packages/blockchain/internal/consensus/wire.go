package consensus

import (
	"fmt"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
)

// WireMessage is a consensus message as it travels between validators: a JSON
// envelope with the block and signature as 0x-hex.
//
// The JSON lives beside the domain type rather than in internal/p2p so the
// two cannot drift — a field added to Message and forgotten here would be
// silently dropped in transit, and because it would still be inside the
// signature pre-image, every receiver would compute a different digest and
// reject every message. internal/p2p imports this package; never the reverse.
//
// The envelope shape follows internal/p2p/protocol.go's: JSON for
// operability (a curl against the endpoint returns something legible), with
// the parts whose exact bytes matter carried as hex rather than re-serialised.
type WireMessage struct {
	Type      uint8         `json:"type"`
	Height    uint64        `json:"height"`
	Round     uint32        `json:"round"`
	BlockHash common.Hash   `json:"blockHash"`
	BlockRLP  hexutil.Bytes `json:"blockRlp,omitempty"`

	LockedRound uint32      `json:"lockedRound,omitempty"`
	LockedHash  common.Hash `json:"lockedHash,omitempty"`

	Signature hexutil.Bytes `json:"signature"`
}

// Wire renders a signed message for transmission.
func (sm *SignedMessage) Wire() WireMessage {
	return WireMessage{
		Type:        uint8(sm.Type),
		Height:      sm.Height,
		Round:       sm.Round,
		BlockHash:   sm.BlockHash,
		BlockRLP:    sm.BlockRLP,
		LockedRound: sm.LockedRound,
		LockedHash:  sm.LockedHash,
		Signature:   sm.Signature,
	}
}

// Decode turns a received envelope back into a SignedMessage.
//
// It checks shape only — that the type is one this protocol has and that the
// signature is the right length. It deliberately performs no cryptography:
// this runs on the HTTP handler's goroutine, where a peer could otherwise
// make this node do unbounded ECDSA recovery by sending garbage. Verification
// happens on the engine's own goroutine, after the message has survived the
// height window and the per-sender dedup.
func (w WireMessage) Decode() (*SignedMessage, error) {
	typ := MsgType(w.Type)
	if !validMsgTypes[typ] {
		return nil, fmt.Errorf("unknown consensus message type %d", w.Type)
	}
	if len(w.Signature) != SignatureLength {
		return nil, fmt.Errorf("%s for height %d: signature is %d bytes, want %d", typ, w.Height, len(w.Signature), SignatureLength)
	}
	// A proposal with no block is unusable and would otherwise fail much
	// later, after this node had already spent a recovery on it.
	if typ == MsgProposal && len(w.BlockRLP) == 0 {
		return nil, fmt.Errorf("PROPOSAL for height %d carries no block", w.Height)
	}

	return &SignedMessage{
		Message: Message{
			Type:        typ,
			Height:      w.Height,
			Round:       w.Round,
			BlockHash:   w.BlockHash,
			BlockRLP:    w.BlockRLP,
			LockedRound: w.LockedRound,
			LockedHash:  w.LockedHash,
		},
		Signature: w.Signature,
	}, nil
}
