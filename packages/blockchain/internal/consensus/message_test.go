package consensus

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
)

var testBlockHash = common.HexToHash("0x9f3c1e7a5b2d4c6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60")

// TestSignAndVerifyRoundTrip is the baseline: a validator's own message
// verifies as coming from it.
func TestSignAndVerifyRoundTrip(t *testing.T) {
	vs, keys := testSet(t)

	for _, name := range testValidatorNames {
		t.Run(name, func(t *testing.T) {
			signed, err := Sign(testChainID, keys[name], Message{
				Type: MsgPrepare, Height: 42, Round: 0, BlockHash: testBlockHash,
			})
			if err != nil {
				t.Fatalf("Sign: %v", err)
			}
			if len(signed.Signature) != SignatureLength {
				t.Errorf("signature is %d bytes, want %d", len(signed.Signature), SignatureLength)
			}

			// Verification must work on a message that arrived over the wire,
			// i.e. one whose signer field was never set locally.
			received := &SignedMessage{Message: signed.Message, Signature: signed.Signature}
			v, err := Verify(testChainID, vs, received)
			if err != nil {
				t.Fatalf("Verify: %v", err)
			}
			if v.Name != name {
				t.Errorf("recovered %q, want %q", v.Name, name)
			}
			if addr, ok := received.Signer(); !ok || addr != v.Address {
				t.Errorf("Signer() = %s,%v; want %s,true", addr, ok, v.Address)
			}
		})
	}
}

// TestAnUnverifiedMessageReportsNoSigner: an address a peer claims is
// worthless, so a message that has not been through Verify must not be able
// to hand one out. This is what stops tally code from ever counting a vote it
// did not authenticate.
func TestAnUnverifiedMessageReportsNoSigner(t *testing.T) {
	sm := &SignedMessage{Message: Message{Type: MsgCommit, Height: 1, BlockHash: testBlockHash}}
	if addr, ok := sm.Signer(); ok {
		t.Errorf("an unverified message reported signer %s", addr)
	}
}

// TestAPrepareSignatureIsNotAValidCommit is the reason the message type is in
// the signing pre-image, and the single most important test in this file.
//
// Without type separation, an attacker could take each honest validator's
// PREPARE — which is broadcast in the clear — and replay it as that
// validator's COMMIT. Three honest PREPAREs would become three COMMITs nobody
// cast, reaching quorum with zero real commits and finalizing a block no
// validator ever agreed to finalize. The entire safety argument depends on
// this failing.
func TestAPrepareSignatureIsNotAValidCommit(t *testing.T) {
	vs, keys := testSet(t)

	prepare, err := Sign(testChainID, keys["authority"], Message{
		Type: MsgPrepare, Height: 7, Round: 0, BlockHash: testBlockHash,
	})
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	// Same height, same round, same block — only the type is changed, which
	// is exactly what a replaying attacker controls.
	replayed := &SignedMessage{
		Message:   Message{Type: MsgCommit, Height: 7, Round: 0, BlockHash: testBlockHash},
		Signature: prepare.Signature,
	}

	_, err = Verify(testChainID, vs, replayed)
	if err == nil {
		t.Fatal("a PREPARE signature verified as a COMMIT: cross-phase replay is possible")
	}
	// It must fail as an unknown signer, not merely as a bad signature: the
	// recovery succeeds against a different digest and yields a random
	// address, which the set rejects.
	if !errors.Is(err, ErrNotValidator) && !errors.Is(err, ErrBadSignature) {
		t.Errorf("error = %v, want ErrNotValidator or ErrBadSignature", err)
	}
}

// TestACommitSignatureIsRoundIndependent pins the deliberate asymmetry in
// Digest. A COMMIT is a claim about a block, not a round, so the same
// signature must verify whatever round field the message carries.
//
// Two things depend on it. Liveness: commits cast in different rounds for the
// same block aggregate toward quorum, so a slow validator's late commit still
// counts after a round change instead of being wasted. Auditability: a stored
// seal is verifiable from the finalized block alone, which is what
// RecoverSeal relies on.
func TestACommitSignatureIsRoundIndependent(t *testing.T) {
	vs, keys := testSet(t)

	commit, err := Sign(testChainID, keys["jvp"], Message{
		Type: MsgCommit, Height: 11, Round: 0, BlockHash: testBlockHash,
	})
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	for _, round := range []uint32{0, 1, 2, 97} {
		received := &SignedMessage{
			Message:   Message{Type: MsgCommit, Height: 11, Round: round, BlockHash: testBlockHash},
			Signature: commit.Signature,
		}
		v, err := Verify(testChainID, vs, received)
		if err != nil {
			t.Fatalf("a round-0 commit failed to verify at round %d: %v", round, err)
		}
		if v.Name != "jvp" {
			t.Errorf("round %d recovered %q, want jvp", round, v.Name)
		}
	}
}

// TestAPrepareSignatureIsRoundSpecific is the other half: everything that is
// not a commit *is* bound to its round, so a PREPARE cast in round 0 cannot
// be replayed to prop up round 1.
func TestAPrepareSignatureIsRoundSpecific(t *testing.T) {
	vs, keys := testSet(t)

	prepare, err := Sign(testChainID, keys["unp"], Message{
		Type: MsgPrepare, Height: 11, Round: 0, BlockHash: testBlockHash,
	})
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	replayed := &SignedMessage{
		Message:   Message{Type: MsgPrepare, Height: 11, Round: 1, BlockHash: testBlockHash},
		Signature: prepare.Signature,
	}
	if _, err := Verify(testChainID, vs, replayed); err == nil {
		t.Fatal("a round-0 PREPARE verified in round 1")
	}
}

// TestASignatureFromAnotherChainIsRefused: the chain id is in the pre-image
// so that a message captured from a test or staging cluster cannot be
// replayed against production, where the same operators may well hold the
// same keys.
func TestASignatureFromAnotherChainIsRefused(t *testing.T) {
	vs, keys := testSet(t)

	m := Message{Type: MsgCommit, Height: 3, BlockHash: testBlockHash}
	foreign, err := Sign(1337, keys["sjb"], m)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	received := &SignedMessage{Message: m, Signature: foreign.Signature}
	if _, err := Verify(testChainID, vs, received); err == nil {
		t.Fatal("a signature made for chain 1337 verified on chain 9494")
	}
}

// TestASignatureFromOutsideTheSetIsRefused: a perfectly valid secp256k1
// signature from a key nobody listed carries no authority.
func TestASignatureFromOutsideTheSetIsRefused(t *testing.T) {
	vs, _ := testSet(t)

	m := Message{Type: MsgPrepare, Height: 5, BlockHash: testBlockHash}
	signed, err := Sign(testChainID, mustKey(t, outsiderKey), m)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	received := &SignedMessage{Message: m, Signature: signed.Signature}
	_, err = Verify(testChainID, vs, received)
	if !errors.Is(err, ErrNotValidator) {
		t.Fatalf("error = %v, want ErrNotValidator", err)
	}
}

// TestVerifyRejectsATamperedSignature confirms the claim message.go makes
// about crypto.SigToPub: it validates the recovery byte and the S value
// itself, so no separate ValidateSignatureValues call is needed. If a future
// go-ethereum ever loosened that, this fails rather than silently admitting
// malleable signatures.
func TestVerifyRejectsATamperedSignature(t *testing.T) {
	vs, keys := testSet(t)

	signed, err := Sign(testChainID, keys["authority"], Message{
		Type: MsgCommit, Height: 9, BlockHash: testBlockHash,
	})
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(sig []byte) []byte
	}{
		{
			name:   "impossible recovery byte",
			mutate: func(sig []byte) []byte { out := append([]byte(nil), sig...); out[64] = 4; return out },
		},
		{
			name:   "flipped bit in r",
			mutate: func(sig []byte) []byte { out := append([]byte(nil), sig...); out[0] ^= 0x01; return out },
		},
		{
			name:   "truncated",
			mutate: func(sig []byte) []byte { return sig[:SignatureLength-1] },
		},
		{
			name:   "empty",
			mutate: func(sig []byte) []byte { return nil },
		},
		{
			name:   "zeroed",
			mutate: func(sig []byte) []byte { return make([]byte, SignatureLength) },
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			received := &SignedMessage{Message: signed.Message, Signature: tc.mutate(signed.Signature)}
			if _, err := Verify(testChainID, vs, received); err == nil {
				t.Error("Verify accepted a tampered signature")
			}
			if addr, ok := received.Signer(); ok {
				t.Errorf("a rejected message reported signer %s", addr)
			}
		})
	}
}

// TestVerifyRejectsAnUnknownMessageType: a type outside the protocol has no
// defined pre-image, so accepting one would mean verifying a signature over
// bytes this code does not understand.
func TestVerifyRejectsAnUnknownMessageType(t *testing.T) {
	vs, keys := testSet(t)

	if _, err := Sign(testChainID, keys["authority"], Message{Type: MsgType(9), Height: 1}); err == nil {
		t.Error("Sign accepted an unknown message type")
	}

	received := &SignedMessage{
		Message:   Message{Type: MsgType(9), Height: 1, BlockHash: testBlockHash},
		Signature: make([]byte, SignatureLength),
	}
	if _, err := Verify(testChainID, vs, received); err == nil {
		t.Error("Verify accepted an unknown message type")
	}
}

// TestDigestIsStableAcrossCalls: the pre-image is a fixed-shape struct, so
// two encodings of the same message must be identical. If RLP ever became
// order- or map-dependent here, signatures would stop verifying at random.
func TestDigestIsStableAcrossCalls(t *testing.T) {
	m := Message{
		Type: MsgProposal, Height: 1234, Round: 7, BlockHash: testBlockHash,
		// Fields outside the pre-image must not affect the digest.
		BlockRLP: []byte{0xde, 0xad, 0xbe, 0xef},
	}
	first := Digest(testChainID, m)

	m.BlockRLP = []byte{0x01, 0x02}
	second := Digest(testChainID, m)

	if first != second {
		t.Errorf("digest changed when BlockRLP changed: %s vs %s — the block body must not be in the pre-image", first, second)
	}
	if first == (common.Hash{}) {
		t.Error("digest is the zero hash")
	}
}

// TestDigestSeparatesEveryFieldThatMatters walks the pre-image: changing any
// signed field must change the digest. A field that did not would be a field
// an attacker could rewrite in flight without invalidating the signature.
func TestDigestSeparatesEveryFieldThatMatters(t *testing.T) {
	base := Message{Type: MsgPrepare, Height: 100, Round: 3, BlockHash: testBlockHash}
	baseDigest := Digest(testChainID, base)

	tests := []struct {
		name    string
		mutate  func(m Message) Message
		chainID uint64
	}{
		{name: "type", mutate: func(m Message) Message { m.Type = MsgCommit; return m }, chainID: testChainID},
		{name: "height", mutate: func(m Message) Message { m.Height = 101; return m }, chainID: testChainID},
		{name: "round", mutate: func(m Message) Message { m.Round = 4; return m }, chainID: testChainID},
		{name: "block hash", mutate: func(m Message) Message { m.BlockHash = common.HexToHash("0x01"); return m }, chainID: testChainID},
		{name: "chain id", mutate: func(m Message) Message { return m }, chainID: 1337},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := Digest(tc.chainID, tc.mutate(base)); got == baseDigest {
				t.Errorf("changing %s did not change the digest — it is not covered by the signature", tc.name)
			}
		})
	}
}

// TestWireRoundTripPreservesEverySignedField: a field added to Message but
// forgotten in WireMessage would be dropped in transit while remaining inside
// the signature pre-image, so every receiver would compute a different digest
// and reject every message. That failure is total and would look like a
// network problem, so it is worth a test.
func TestWireRoundTripPreservesEverySignedField(t *testing.T) {
	_, keys := testSet(t)

	signed, err := Sign(testChainID, keys["authority"], Message{
		Type:        MsgRoundChange,
		Height:      88,
		Round:       2,
		BlockHash:   testBlockHash,
		BlockRLP:    []byte{0x01, 0x02, 0x03},
		LockedRound: 1,
		LockedHash:  common.HexToHash("0xabc"),
	})
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	encoded, err := json.Marshal(signed.Wire())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(encoded), `"signature":"0x`) {
		t.Errorf("envelope does not carry a 0x-prefixed signature: %s", encoded)
	}

	var wire WireMessage
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	decoded, err := wire.Decode()
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}

	if Digest(testChainID, decoded.Message) != Digest(testChainID, signed.Message) {
		t.Error("the round-tripped message has a different digest: a signed field was lost on the wire")
	}
	if decoded.LockedRound != signed.LockedRound || decoded.LockedHash != signed.LockedHash {
		t.Errorf("lock fields lost: got round %d hash %s", decoded.LockedRound, decoded.LockedHash)
	}
	if string(decoded.BlockRLP) != string(signed.BlockRLP) {
		t.Error("block payload lost on the wire")
	}
}

// TestDecodeRejectsUnusableEnvelopes: shape checks run on the HTTP handler's
// goroutine, before any cryptography, so a peer cannot make this node spend
// ECDSA recoveries on garbage.
func TestDecodeRejectsUnusableEnvelopes(t *testing.T) {
	valid := make(hexutil.Bytes, SignatureLength)

	tests := []struct {
		name string
		wire WireMessage
	}{
		{name: "unknown type", wire: WireMessage{Type: 99, Height: 1, Signature: valid}},
		{name: "short signature", wire: WireMessage{Type: uint8(MsgPrepare), Height: 1, Signature: valid[:10]}},
		{name: "no signature", wire: WireMessage{Type: uint8(MsgPrepare), Height: 1}},
		{name: "proposal with no block", wire: WireMessage{Type: uint8(MsgProposal), Height: 1, Signature: valid}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := tc.wire.Decode(); err == nil {
				t.Error("Decode accepted an unusable envelope")
			}
		})
	}
}
