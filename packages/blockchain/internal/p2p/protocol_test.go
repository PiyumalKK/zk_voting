package p2p

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestBlockSurvivesTheWireFormat is the property the whole protocol rests
// on: what a replica verifies must be exactly what the primary sealed. If
// encoding and decoding a block could change any field the header commits
// to, every state root comparison downstream would be comparing the wrong
// thing.
func TestBlockSurvivesTheWireFormat(t *testing.T) {
	seq := newChain(t)
	blocks := mineBlocks(t, seq, 2)
	original := blocks[1]

	msg, err := EncodeBlock(original)
	if err != nil {
		t.Fatalf("EncodeBlock: %v", err)
	}

	// Through JSON as well as RLP — the envelope is what actually travels.
	encoded, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	if !strings.Contains(string(encoded), `"rlp":"0x`) {
		t.Errorf("envelope does not carry 0x-prefixed rlp: %s", encoded)
	}

	var received BlockMessage
	if err := json.Unmarshal(encoded, &received); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	decoded, err := received.Decode()
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}

	if decoded.Hash() != original.Hash() {
		t.Errorf("round-tripped hash = %s, want %s", decoded.Hash(), original.Hash())
	}
	if decoded.Root() != original.Root() {
		t.Errorf("round-tripped state root = %s, want %s", decoded.Root(), original.Root())
	}
	if decoded.NumberU64() != original.NumberU64() {
		t.Errorf("round-tripped number = %d, want %d", decoded.NumberU64(), original.NumberU64())
	}
	if decoded.Time() != original.Time() {
		t.Errorf("round-tripped timestamp = %d, want %d", decoded.Time(), original.Time())
	}
}

// TestDecodeRejectsAnEnvelopeThatContradictsItsPayload: the number is
// carried twice (once in the envelope, once inside the RLP) so that routing
// and logging need no decode. That redundancy is only safe if a
// disagreement is an error — otherwise a sender could have a block logged as
// one height and applied at another.
func TestDecodeRejectsAnEnvelopeThatContradictsItsPayload(t *testing.T) {
	seq := newChain(t)
	block := mineBlocks(t, seq, 1)[0]

	msg, err := EncodeBlock(block)
	if err != nil {
		t.Fatalf("EncodeBlock: %v", err)
	}
	msg.Number = block.NumberU64() + 99

	if _, err := msg.Decode(); err == nil {
		t.Fatal("Decode accepted an envelope whose number contradicts its payload")
	}
}

func TestDecodeRejectsUnusablePayloads(t *testing.T) {
	tests := []struct {
		name string
		msg  BlockMessage
	}{
		{name: "empty payload", msg: BlockMessage{Number: 1}},
		{name: "not rlp at all", msg: BlockMessage{Number: 1, RLP: []byte{0xde, 0xad, 0xbe, 0xef}}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := tc.msg.Decode(); err == nil {
				t.Error("Decode accepted an unusable payload")
			}
		})
	}
}
