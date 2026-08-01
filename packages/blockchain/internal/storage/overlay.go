package storage

import (
	"errors"
	"fmt"

	"github.com/ethereum/go-ethereum/core/rawdb"
	"github.com/ethereum/go-ethereum/ethdb"
)

// This file provides the copy-on-write database M09's audit replay runs on.
//
// Replaying a block means opening the state trie at the parent's root,
// re-executing, and committing — and committing writes trie nodes. The
// audit tool must not write to the database it is auditing (OpenReadOnly
// above exists for exactly that reason), so those nodes have to land
// somewhere else while reads still reach the historical state that is only
// present in the source.
//
// Hence: reads try the scratch store first and fall back to the source;
// writes only ever reach the scratch store. Two properties make this sound
// rather than merely convenient:
//
//  1. Trie nodes are content-addressed — the key *is* the hash of the value
//     — so reading a node through to the source cannot smuggle in corrupt
//     state: go-ethereum verifies the hash when it decodes the node, and a
//     mismatch surfaces as a decode error rather than as wrong data. The
//     audit's guarantee ("the state root is a pure function of the block
//     list") is therefore preserved even though replay does not copy the
//     source's trie.
//  2. Replay never deletes or rewrites a key. Any node it commits that the
//     source already has is byte-identical to the source's copy, and any
//     node the source lacks is new. So "scratch first, then source" and
//     "source first, then scratch" would return the same bytes for every
//     key replay actually touches — the ordering below is just the cheaper
//     of the two.
//
// The scratch store is in memory. An election chain's whole state is a few
// megabytes (a handful of contracts plus one leaf per registered voter), so
// this is the right trade; if a future chain outgrows it, swap
// rawdb.NewMemoryDatabase() for a temp-dir Open() — nothing else changes.

// ErrOverlayReadOnlySource means replay tried to delete a key. Nothing in
// the replay path does (see property 2 above), so this is reported rather
// than silently applied to the scratch store, where it would produce a
// tombstone that reads then fell *through* to the source, quietly
// resurrecting the deleted value.
var ErrOverlayReadOnlySource = errors.New("replay overlay: the audited database is read-only")

// replayOverlay layers an in-memory scratch database over a read-only
// source.
//
// The source is embedded rather than listed field-by-field on purpose:
// ethdb.Database is a wide, version-sensitive interface (key/value access,
// batching, iteration, compaction, statistics, and the whole ancient-store
// surface), and this type only has an opinion about a handful of those
// methods. Embedding means a go-ethereum upgrade that adds a method to the
// interface keeps compiling here, and every method not overridden below is
// answered by the source exactly as it would be without the overlay.
type replayOverlay struct {
	ethdb.Database // the audited chain, opened read-only; provides everything not overridden

	scratch ethdb.Database // in-memory; absorbs every write
}

// NewReplayOverlay wraps src so that reads see src's contents and writes are
// captured in memory. Closing the returned database releases the scratch
// store only — the caller keeps ownership of src and must close it itself.
func NewReplayOverlay(src ethdb.Database) ethdb.Database {
	return &replayOverlay{Database: src, scratch: rawdb.NewMemoryDatabase()}
}

// Has reports whether key exists in either layer.
func (o *replayOverlay) Has(key []byte) (bool, error) {
	if ok, err := o.scratch.Has(key); err == nil && ok {
		return true, nil
	}
	return o.Database.Has(key)
}

// Get returns key's value from the scratch store, falling back to the
// source. A miss in the scratch store is reported by its backing store as
// an error rather than as (nil, nil), so any error here means "not in the
// scratch layer" and the source is consulted; the source's own error (or
// miss) is then what the caller sees.
func (o *replayOverlay) Get(key []byte) ([]byte, error) {
	if v, err := o.scratch.Get(key); err == nil {
		return v, nil
	}
	return o.Database.Get(key)
}

// Put writes to the scratch store. The source is never modified.
func (o *replayOverlay) Put(key, value []byte) error {
	return o.scratch.Put(key, value)
}

// Delete is refused — see ErrOverlayReadOnlySource.
func (o *replayOverlay) Delete(key []byte) error {
	return fmt.Errorf("%w (attempted delete of key %#x)", ErrOverlayReadOnlySource, key)
}

// NewBatch returns a batch that writes into the scratch store. The scratch
// store's own batch type is returned directly: it already has exactly the
// required semantics (buffer writes, apply them to the scratch store on
// Write), so there is nothing for a wrapper to add.
func (o *replayOverlay) NewBatch() ethdb.Batch {
	return o.scratch.NewBatch()
}

// NewBatchWithSize is NewBatch with a pre-sized buffer.
func (o *replayOverlay) NewBatchWithSize(size int) ethdb.Batch {
	return o.scratch.NewBatchWithSize(size)
}

// NewIterator refuses to iterate.
//
// A correct iterator would have to merge two ordered streams and hide
// shadowed keys. Replay never iterates — the hash-scheme trie database
// reads and writes nodes by key — so rather than carry that machinery, this
// returns an iterator that yields nothing and reports why. Returning the
// scratch store's iterator instead would be worse than useless: it would
// silently skip every key that only exists in the source, which is most of
// them, and a caller would read the empty result as "no such data" rather
// than as "unsupported".
func (o *replayOverlay) NewIterator(prefix, start []byte) ethdb.Iterator {
	return &unsupportedIterator{err: fmt.Errorf("replay overlay: iteration is not supported (prefix %#x, start %#x)", prefix, start)}
}

// Close releases the scratch store. The source belongs to the caller and is
// deliberately left open.
func (o *replayOverlay) Close() error {
	return o.scratch.Close()
}

// unsupportedIterator is an ethdb.Iterator that is immediately exhausted and
// carries an explanatory error, so a caller following the standard
// `for it.Next() { … }; it.Error()` shape finds out why it saw nothing.
type unsupportedIterator struct{ err error }

func (i *unsupportedIterator) Next() bool    { return false }
func (i *unsupportedIterator) Error() error  { return i.err }
func (i *unsupportedIterator) Key() []byte   { return nil }
func (i *unsupportedIterator) Value() []byte { return nil }
func (i *unsupportedIterator) Release()      {}
