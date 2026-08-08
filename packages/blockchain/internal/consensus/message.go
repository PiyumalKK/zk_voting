package consensus

import (
	"crypto/ecdsa"
	"fmt"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/rlp"
)

// MsgType identifies which phase of the protocol a message belongs to.
type MsgType uint8

const (
	// MsgProposal is PRE-PREPARE: the round's proposer offers a block.
	MsgProposal MsgType = 1
	// MsgPrepare says "I re-executed this block and it is valid".
	MsgPrepare MsgType = 2
	// MsgCommit says "I have seen a quorum of prepares; this block is the one
	// for this height". Commit signatures are the seals stored beside a
	// finalized block.
	MsgCommit MsgType = 3
	// MsgRoundChange says "this round is not progressing; move on".
	MsgRoundChange MsgType = 4
)

func (t MsgType) String() string {
	switch t {
	case MsgProposal:
		return "PROPOSAL"
	case MsgPrepare:
		return "PREPARE"
	case MsgCommit:
		return "COMMIT"
	case MsgRoundChange:
		return "ROUND-CHANGE"
	default:
		return fmt.Sprintf("UNKNOWN(%d)", uint8(t))
	}
}

var validMsgTypes = map[MsgType]bool{
	MsgProposal: true, MsgPrepare: true, MsgCommit: true, MsgRoundChange: true,
}

// SignatureLength is what crypto.Sign returns: 65 bytes, [R‖S‖V] with V in
// {0,1}. Verified against go-ethereum v1.16.8 (crypto/signature_nocgo.go).
const SignatureLength = 65

// Message is the signed content of one consensus vote.
type Message struct {
	Type      MsgType
	Height    uint64
	Round     uint32
	BlockHash common.Hash

	// BlockRLP carries the block itself on a PROPOSAL, and on a ROUND-CHANGE
	// that reports a lock (so the next proposer can re-propose a block it may
	// never have seen).
	//
	// It is deliberately *not* part of the signature pre-image. The receiver
	// decodes it and requires block.Hash() == BlockHash, so the body is bound
	// by the hash the signature does cover — the same argument
	// p2p.BlockMessage.Decode already makes — and the pre-image stays a
	// fixed-size, cheaply-hashed struct rather than a variable-length blob.
	BlockRLP []byte

	// LockedRound and LockedHash appear only on a ROUND-CHANGE, reporting
	// that the sender has already committed to a block at this height. The
	// next proposer must re-propose the locked block with the highest
	// LockedRound; see the round-change handling in engine.go.
	LockedRound uint32
	LockedHash  common.Hash
}

// SignedMessage is a Message plus the signature over its digest.
type SignedMessage struct {
	Message

	// Signature is 65 bytes of secp256k1, exactly as crypto.Sign produces.
	Signature []byte

	// signer is filled in by Verify and is deliberately unexported and absent
	// from the wire. An address a peer *claims* is worthless; having a field
	// that could hold one invites code that reads it before the signature has
	// been checked. The only way to learn who sent a message is to verify it.
	signer common.Address
	// verified guards against a SignedMessage built by hand reaching the
	// tally with a zero signer.
	verified bool
}

// Signer returns the recovered signer, and false if this message has not been
// through Verify.
func (sm *SignedMessage) Signer() (common.Address, bool) {
	return sm.signer, sm.verified
}

// Block decodes the carried block and checks it against the signed hash.
//
// This is the join between the signed and unsigned halves of a message: the
// signature covers BlockHash, and this refuses any body that does not hash to
// it, so a valid signature on a message whose block was swapped in transit is
// worth nothing.
func (sm *SignedMessage) Block() (*types.Block, error) {
	if len(sm.BlockRLP) == 0 {
		return nil, fmt.Errorf("%s for height %d carries no block", sm.Type, sm.Height)
	}
	block := new(types.Block)
	if err := rlp.DecodeBytes(sm.BlockRLP, block); err != nil {
		return nil, fmt.Errorf("decode block in %s for height %d: %w", sm.Type, sm.Height, err)
	}
	if got := block.Hash(); got != sm.BlockHash {
		return nil, fmt.Errorf("%s claims block %s but carries %s", sm.Type, sm.BlockHash, got)
	}
	if got := block.NumberU64(); got != sm.Height {
		return nil, fmt.Errorf("%s claims height %d but carries block %d", sm.Type, sm.Height, got)
	}
	return block, nil
}

// sigDomain separates this chain's consensus signatures from every other
// signature a validator's key could ever produce: an Ethereum transaction, an
// EIP-191 personal_sign message, a signature on another zk-blockchain
// deployment, or a different phase of this same protocol.
//
// Domain separation is cheap and its absence is catastrophic, so it is not
// optional here. The version suffix exists so that a future protocol change
// which alters the meaning of a field can bump it and make old signatures
// unusable rather than reinterpreted.
const sigDomain = "zkbft/v1"

// sigPayload is exactly what gets hashed. Fixed shape, fixed field order.
type sigPayload struct {
	Domain    string
	ChainID   uint64
	Type      uint8
	Height    uint64
	Round     uint32
	BlockHash common.Hash
	Locked    common.Hash
}

// Digest returns the 32 bytes a message's signature covers.
//
// Every field in the pre-image earns its place:
//
//   - Domain and ChainID: a signature from a test cluster must not be valid
//     on production, and a consensus vote must not be reinterpretable as
//     anything else the key could have signed.
//   - Type: without it a PREPARE could be replayed as a COMMIT. That is not a
//     theoretical concern — it would let an attacker turn each honest
//     validator's PREPARE into a COMMIT it never cast, reaching quorum with
//     fewer real commits than Q and breaking the entire safety argument.
//   - Height and BlockHash: what is being voted on.
//
// *** Round is deliberately zeroed for MsgCommit. ***
//
// A COMMIT is a claim about a *block* ("this block is final at its height"),
// not about a round, and the block hash already binds the height through the
// header. Zeroing the round makes commit signatures round-independent, which
// buys two things:
//
//  1. Liveness: commits for the same block cast in different rounds
//     aggregate toward Q. When a round change races a slow validator, its
//     late commit still counts instead of being wasted.
//  2. Auditability: a seal stored on disk is verifiable years later from the
//     block alone, with no need to also record which round produced it.
//
// This is Besu's IBFT2 behaviour, and it is why the safety argument in
// CONSENSUS.md is phrased per-height rather than per-round: "an honest
// validator commits to at most one block per height" is a statement the
// signature scheme itself makes meaningful.
func Digest(chainID uint64, m Message) common.Hash {
	round := m.Round
	if m.Type == MsgCommit {
		round = 0
	}
	locked := common.Hash{}
	if m.Type == MsgRoundChange {
		locked = m.LockedHash
	}

	enc, err := rlp.EncodeToBytes(&sigPayload{
		Domain:    sigDomain,
		ChainID:   chainID,
		Type:      uint8(m.Type),
		Height:    m.Height,
		Round:     round,
		BlockHash: m.BlockHash,
		Locked:    locked,
	})
	if err != nil {
		// sigPayload is a fixed struct of RLP-encodable scalar and array
		// types. If this ever fails, the encoder is broken, and silently
		// signing a different pre-image would be far worse than crashing.
		panic(fmt.Sprintf("consensus: encoding a fixed-shape signing payload cannot fail: %v", err))
	}
	return crypto.Keccak256Hash(enc)
}

// Sign produces a SignedMessage. The returned message is already marked
// verified with the signer's own address: a node's own votes go straight into
// its tally without a round trip through recovery.
func Sign(chainID uint64, key *ecdsa.PrivateKey, m Message) (*SignedMessage, error) {
	if !validMsgTypes[m.Type] {
		return nil, fmt.Errorf("refusing to sign unknown message type %d", uint8(m.Type))
	}
	digest := Digest(chainID, m)
	sig, err := crypto.Sign(digest.Bytes(), key)
	if err != nil {
		return nil, fmt.Errorf("sign %s for height %d: %w", m.Type, m.Height, err)
	}
	return &SignedMessage{
		Message:   m,
		Signature: sig,
		signer:    crypto.PubkeyToAddress(key.PublicKey),
		verified:  true,
	}, nil
}

// Verify recovers the signer and checks it is a member of vs, recording the
// result on the message.
//
// It returns the Validator rather than just an error so that callers cannot
// accidentally use an address they have not checked membership for: there is
// no way to obtain a signer from this package without also having been told
// it is in the set.
func Verify(chainID uint64, vs *ValidatorSet, sm *SignedMessage) (Validator, error) {
	if !validMsgTypes[sm.Type] {
		return Validator{}, fmt.Errorf("%w: unknown message type %d", ErrBadSignature, uint8(sm.Type))
	}
	if len(sm.Signature) != SignatureLength {
		return Validator{}, fmt.Errorf("%w: signature is %d bytes, want %d", ErrBadSignature, len(sm.Signature), SignatureLength)
	}

	digest := Digest(chainID, sm.Message)
	// SigToPub rejects a malformed recovery byte and a non-canonical S value
	// itself, so no separate ValidateSignatureValues call is needed — pinned
	// by TestVerifyRejectsATamperedSignature.
	pub, err := crypto.SigToPub(digest.Bytes(), sm.Signature)
	if err != nil {
		return Validator{}, fmt.Errorf("%w: %v", ErrBadSignature, err)
	}

	addr := crypto.PubkeyToAddress(*pub)
	v, ok := vs.Lookup(addr)
	if !ok {
		return Validator{}, fmt.Errorf("%w: %s signed a %s for height %d", ErrNotValidator, addr, sm.Type, sm.Height)
	}

	sm.signer = addr
	sm.verified = true
	return v, nil
}

// RecoverSeal recovers the validator that produced one stored commit seal.
//
// Seals are bare signatures with no message around them, so this rebuilds the
// COMMIT pre-image from the block's own height and hash. That reconstruction
// is only possible because Digest zeroes the round for commits: a seal is
// verifiable from the finalized block alone, with nothing else recorded.
func RecoverSeal(chainID uint64, vs *ValidatorSet, height uint64, blockHash common.Hash, seal []byte) (Validator, error) {
	sm := &SignedMessage{
		Message:   Message{Type: MsgCommit, Height: height, BlockHash: blockHash},
		Signature: seal,
	}
	return Verify(chainID, vs, sm)
}
