package consensus

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"sort"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethdb"
	"github.com/ethereum/go-ethereum/rlp"
)

// Commit seals: the Q signatures that made a block final.
//
// *** Why these are stored beside the chain and not inside the header ***
//
// IBFT chains normally pack commit seals into the block header's extraData,
// which makes the certificate part of the block and is elegant. This chain
// cannot do that. Its header and extraData are already spoken for: extraData
// carries system-op encodings (internal/chain/sysop.go), and — decisively —
// the block hash and state root are what internal/chain/replay.go,
// cmd/audit and every existing replica verify against. Putting seals in the
// hashed header would change the hash of every block, so the same
// transactions would produce a different chain, `cmd/audit` would need a
// second code path, and a solo-mode replica could no longer follow a BFT
// primary during a rollout.
//
// So the certificate lives in a sidecar keyed by (height, block hash), in the
// same database, under a prefix nothing else uses. The block stays byte-for-
// byte what it would have been without consensus, which is exactly what makes
// CONSENSUS_MODE reversible and acceptance criteria 6 and 7 hold without
// argument.
//
// The cost is honest and worth stating: a block's validity does not depend on
// its seals. Anyone re-executing the chain proves the *state* is right; the
// seals prove *who agreed to it*. Losing a seal record loses the audit trail
// for that block, not the block.

// sealPrefix namespaces the sidecar inside the shared key/value store.
//
// It is a long ASCII prefix rather than a single byte on purpose.
// go-ethereum's core/rawdb/schema.go uses single-byte prefixes densely
// (h/H/b/r/l/B/a/o/c/S/A/O/L/m/v) and adds new ones between releases, so
// picking a free byte today is a collision waiting for an upgrade. Its own
// namespaced additions use long prefixes for the same reason — "clique-",
// "secure-key-", "ethereum-config-". Verified against v1.16.8: no rawdb key
// or prefix begins with 'z'.
var sealPrefix = []byte("zkbft-seals-")

// sealKey is sealPrefix ‖ big-endian height ‖ block hash.
//
// Height comes first and big-endian so records sort by height — an operator
// dumping the namespace reads the chain in order. The hash is in the key, not
// just the value, because a seal set is a statement about one specific block:
// keyed by height alone, a record from an abandoned proposal at that height
// could shadow the canonical one and a reader would have no way to tell. With
// the hash included, a lookup for the block this node actually holds either
// finds that block's seals or finds nothing.
func sealKey(height uint64, hash common.Hash) []byte {
	key := make([]byte, 0, len(sealPrefix)+8+common.HashLength)
	key = append(key, sealPrefix...)
	key = binary.BigEndian.AppendUint64(key, height)
	key = append(key, hash.Bytes()...)
	return key
}

// CommitSeals is one finalized block's certificate.
type CommitSeals struct {
	// Round the block finalized in. Not part of the signed pre-image — Digest
	// zeroes the round for commits — and recorded only so operators and
	// zk_getCommitSeals can see that a height took three rounds.
	Round uint32
	// Seals are the 65-byte COMMIT signatures, sorted by recovered signer
	// address. Sorting makes the stored bytes a function of the *set* rather
	// than of the order votes happened to arrive in, so two validators' stores
	// are byte-comparable — which is what lets the cluster test assert that a
	// node which rejoined after a restart holds identical certificates.
	Seals [][]byte
}

// SealStore is the engine's view of seal persistence.
type SealStore interface {
	// Put records the certificate for a block.
	Put(height uint64, hash common.Hash, seals *CommitSeals) error
	// Get returns the certificate, or (nil, nil) when there is none. A
	// missing certificate is not an error: blocks sealed before consensus was
	// enabled have none, and neither do blocks a node synced from a peer with
	// a truncated store.
	Get(height uint64, hash common.Hash) (*CommitSeals, error)
}

// Store is the ethdb-backed SealStore.
//
// It takes an ethdb.KeyValueStore rather than a Sequencer so that a read-only
// consumer — a future `audit --verify-seals`, say — can open the certificates
// without linking the write path.
type Store struct {
	db ethdb.KeyValueStore
}

func NewStore(db ethdb.KeyValueStore) *Store { return &Store{db: db} }

// Put writes the certificate.
//
// *** Why this is not part of chain.persist's atomic batch ***
//
// It would be easy to add a seventh write to the batch in seal.go and get
// atomicity for free. It is the wrong trade, for three reasons in order of
// weight:
//
//  1. That batch is a contract, not an implementation detail. Its six writes
//     are precisely what internal/state.VerifyHead asserts at every boot and
//     what TestChainRecoversFromAPartialWrite exercises. A seventh, BFT-only
//     key would make the atomic unit differ between solo and BFT mode, so
//     "solo mode is unchanged" would stop being obviously true.
//  2. Ordering seals-then-block is strictly better than the reverse. A crash
//     between them leaves an orphan certificate keyed by a block hash that
//     never became canonical: unreferenced, harmless, and overwritten
//     byte-identically when the block is re-applied — the same argument
//     persist's own doc comment makes about crash-orphaned trie nodes. The
//     opposite order would leave a canonical block whose seals are missing
//     forever, a permanent hole in the audit trail.
//  3. It is free. Pebble's SyncKeyValue writes a sync-mode WAL record that
//     flushes every preceding write with it, so because this write precedes
//     persist, persist's existing single fsync makes the certificate durable
//     at the same instant the block is.
//
// The engine therefore calls Put and only then ApplyExternalBlock. A failure
// here aborts the commit: a node that cannot record why a block is final
// should not adopt it.
func (s *Store) Put(height uint64, hash common.Hash, seals *CommitSeals) error {
	if seals == nil || len(seals.Seals) == 0 {
		return fmt.Errorf("refusing to store an empty commit certificate for block %d (%s)", height, hash)
	}

	// Copy before sorting: the caller's slice is the engine's live tally, and
	// reordering it underneath would be a surprising side effect.
	sorted := make([][]byte, len(seals.Seals))
	copy(sorted, seals.Seals)
	sort.Slice(sorted, func(i, j int) bool { return bytes.Compare(sorted[i], sorted[j]) < 0 })

	enc, err := rlp.EncodeToBytes(&CommitSeals{Round: seals.Round, Seals: sorted})
	if err != nil {
		return fmt.Errorf("encode commit seals for block %d: %w", height, err)
	}
	if err := s.db.Put(sealKey(height, hash), enc); err != nil {
		return fmt.Errorf("store commit seals for block %d (%s): %w", height, hash, err)
	}
	return nil
}

// Get reads the certificate, returning (nil, nil) when there is none.
func (s *Store) Get(height uint64, hash common.Hash) (*CommitSeals, error) {
	enc, err := s.db.Get(sealKey(height, hash))
	if err != nil || len(enc) == 0 {
		// ethdb reports a missing key as an error whose type varies by
		// backend, so absence is inferred rather than matched. That is safe
		// here because a read failure and a missing record lead to the same
		// honest answer — "no certificate recorded" — and because the block's
		// validity never depended on this record.
		return nil, nil
	}
	seals := new(CommitSeals)
	if err := rlp.DecodeBytes(enc, seals); err != nil {
		return nil, fmt.Errorf("decode commit seals for block %d (%s): %w", height, hash, err)
	}
	return seals, nil
}

// SealedBy recovers the validator behind every seal in a certificate.
//
// It is the read-path check: zk_getCommitSeals runs it before answering, so a
// corrupt or truncated record surfaces as an explicit error rather than as a
// short list that a caller might innocently read as "quorum was two". A
// duplicate signer is an error for the same reason — three seals from two
// validators is not a quorum of three, and reporting it as one would defeat
// the point of publishing the certificate at all.
func SealedBy(chainID uint64, vs *ValidatorSet, height uint64, hash common.Hash, seals *CommitSeals) ([]Validator, error) {
	if seals == nil {
		return nil, nil
	}

	signers := make([]Validator, 0, len(seals.Seals))
	seen := make(map[common.Address]bool, len(seals.Seals))
	for i, seal := range seals.Seals {
		v, err := RecoverSeal(chainID, vs, height, hash, seal)
		if err != nil {
			return nil, fmt.Errorf("commit seal %d of block %d (%s): %w", i, height, hash, err)
		}
		if seen[v.Address] {
			return nil, fmt.Errorf("block %d (%s) carries two seals from %s: a certificate with duplicates is not a quorum", height, hash, v)
		}
		seen[v.Address] = true
		signers = append(signers, v)
	}
	return signers, nil
}

// MemorySealStore is an in-memory SealStore for tests and for the in-process
// four-validator harness, where each engine needs its own store but no test
// asserts anything about durability.
type MemorySealStore struct {
	records map[string]*CommitSeals
}

func NewMemorySealStore() *MemorySealStore {
	return &MemorySealStore{records: make(map[string]*CommitSeals)}
}

func (m *MemorySealStore) Put(height uint64, hash common.Hash, seals *CommitSeals) error {
	sorted := make([][]byte, len(seals.Seals))
	copy(sorted, seals.Seals)
	sort.Slice(sorted, func(i, j int) bool { return bytes.Compare(sorted[i], sorted[j]) < 0 })
	m.records[string(sealKey(height, hash))] = &CommitSeals{Round: seals.Round, Seals: sorted}
	return nil
}

func (m *MemorySealStore) Get(height uint64, hash common.Hash) (*CommitSeals, error) {
	return m.records[string(sealKey(height, hash))], nil
}
