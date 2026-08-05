package storage

import (
	"errors"
	"testing"

	"github.com/ethereum/go-ethereum/core/rawdb"
	"github.com/ethereum/go-ethereum/ethdb"
)

// The overlay's contract is small but load-bearing: M09's audit replay
// depends on being able to commit trie nodes somewhere while still reading
// the historical state that only exists in the audited (read-only)
// database. These tests pin every clause of that contract, and — because
// the overlay implements a wide, version-sensitive go-ethereum interface by
// embedding — they are also what turns a future interface change from a
// silent behavioural drift into a compile or test failure.

// newTestOverlay returns an overlay over a source pre-loaded with the given
// key/value pairs, plus the source itself so a test can assert the source
// was left untouched.
func newTestOverlay(t *testing.T, seed map[string]string) (ethdb.Database, ethdb.Database) {
	t.Helper()

	src := rawdb.NewMemoryDatabase()
	for k, v := range seed {
		if err := src.Put([]byte(k), []byte(v)); err != nil {
			t.Fatalf("seeding source with %q: %v", k, err)
		}
	}

	overlay := NewReplayOverlay(src)
	t.Cleanup(func() {
		if err := overlay.Close(); err != nil {
			t.Errorf("overlay.Close() error = %v", err)
		}
	})
	return overlay, src
}

func TestOverlayReadsFallThroughToTheSource(t *testing.T) {
	overlay, _ := newTestOverlay(t, map[string]string{"historic": "value"})

	got, err := overlay.Get([]byte("historic"))
	if err != nil {
		t.Fatalf("Get(historic) error = %v", err)
	}
	if string(got) != "value" {
		t.Errorf("Get(historic) = %q, want %q", got, "value")
	}

	has, err := overlay.Has([]byte("historic"))
	if err != nil {
		t.Fatalf("Has(historic) error = %v", err)
	}
	if !has {
		t.Error("Has(historic) = false, want true — a key present only in the source must be visible")
	}
}

func TestOverlayWritesStayOutOfTheSource(t *testing.T) {
	overlay, src := newTestOverlay(t, nil)

	if err := overlay.Put([]byte("fresh"), []byte("node")); err != nil {
		t.Fatalf("Put(fresh) error = %v", err)
	}

	got, err := overlay.Get([]byte("fresh"))
	if err != nil {
		t.Fatalf("Get(fresh) error = %v", err)
	}
	if string(got) != "node" {
		t.Errorf("Get(fresh) = %q, want %q", got, "node")
	}

	if has, _ := src.Has([]byte("fresh")); has {
		t.Error("the audited database gained a key written through the overlay — the audit is not read-only")
	}
}

func TestOverlayBatchWritesStayOutOfTheSource(t *testing.T) {
	// The batch path is the one replay actually uses: triedb.Commit writes
	// its nodes through a batch, not through Put.
	overlay, src := newTestOverlay(t, map[string]string{"historic": "value"})

	batch := overlay.NewBatch()
	if err := batch.Put([]byte("batched"), []byte("node")); err != nil {
		t.Fatalf("batch.Put error = %v", err)
	}
	if err := batch.Write(); err != nil {
		t.Fatalf("batch.Write error = %v", err)
	}

	got, err := overlay.Get([]byte("batched"))
	if err != nil {
		t.Fatalf("Get(batched) error = %v", err)
	}
	if string(got) != "node" {
		t.Errorf("Get(batched) = %q, want %q", got, "node")
	}

	if has, _ := src.Has([]byte("batched")); has {
		t.Error("a batched write reached the audited database")
	}

	// NewBatchWithSize is the same path with a pre-sized buffer; replay's
	// larger commits take it, so it gets the same assertion.
	sized := overlay.NewBatchWithSize(64)
	if err := sized.Put([]byte("sized"), []byte("node")); err != nil {
		t.Fatalf("sizedBatch.Put error = %v", err)
	}
	if err := sized.Write(); err != nil {
		t.Fatalf("sizedBatch.Write error = %v", err)
	}
	if has, _ := src.Has([]byte("sized")); has {
		t.Error("a pre-sized batched write reached the audited database")
	}
}

func TestOverlayScratchShadowsTheSource(t *testing.T) {
	// Replay only ever rewrites a key with the identical value (trie nodes
	// are content-addressed), so this case does not arise in practice — but
	// the resolution has to be defined, and "scratch wins" is the only one
	// consistent with the overlay being where replay's own work lives.
	overlay, _ := newTestOverlay(t, map[string]string{"key": "from-source"})

	if err := overlay.Put([]byte("key"), []byte("from-scratch")); err != nil {
		t.Fatalf("Put error = %v", err)
	}

	got, err := overlay.Get([]byte("key"))
	if err != nil {
		t.Fatalf("Get error = %v", err)
	}
	if string(got) != "from-scratch" {
		t.Errorf("Get = %q, want %q — the scratch layer must shadow the source", got, "from-scratch")
	}
}

func TestOverlayRefusesDeletes(t *testing.T) {
	overlay, src := newTestOverlay(t, map[string]string{"historic": "value"})

	err := overlay.Delete([]byte("historic"))
	if !errors.Is(err, ErrOverlayReadOnlySource) {
		t.Errorf("Delete error = %v, want ErrOverlayReadOnlySource", err)
	}

	if has, _ := src.Has([]byte("historic")); !has {
		t.Error("the refused delete still removed the key from the audited database")
	}
}

func TestOverlayIterationIsRefusedRatherThanSilentlyPartial(t *testing.T) {
	overlay, _ := newTestOverlay(t, map[string]string{"a": "1", "b": "2"})

	it := overlay.NewIterator(nil, nil)
	defer it.Release()

	if it.Next() {
		t.Error("iterator yielded an entry; it must be empty")
	}
	if it.Error() == nil {
		t.Error("iterator reported no error — an empty result with no error reads as 'no such data'")
	}
}

func TestOverlayCloseLeavesTheSourceUsable(t *testing.T) {
	// The audit tool closes the overlay and then closes the source itself;
	// double-closing the source would fail, and closing it early would break
	// any later read.
	src := rawdb.NewMemoryDatabase()
	if err := src.Put([]byte("historic"), []byte("value")); err != nil {
		t.Fatalf("Put error = %v", err)
	}

	overlay := NewReplayOverlay(src)
	if err := overlay.Close(); err != nil {
		t.Fatalf("overlay.Close() error = %v", err)
	}

	if _, err := src.Get([]byte("historic")); err != nil {
		t.Errorf("source unusable after overlay.Close(): %v", err)
	}
	if err := src.Close(); err != nil {
		t.Errorf("src.Close() error = %v", err)
	}
}

func TestOpenReadOnlyRejectsAnEmptyDirectory(t *testing.T) {
	// An auditor pointed at the wrong path must say so rather than report a
	// zero-block chain as verified.
	if _, err := OpenReadOnly(t.TempDir()); err == nil {
		t.Fatal("OpenReadOnly() on a directory with no chain in it succeeded, want an error")
	}
}

func TestOpenReadOnlyReadsAnExistingChain(t *testing.T) {
	dir := t.TempDir()

	db, err := Open(dir)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	if err := db.Put([]byte("key"), []byte("value")); err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	ro, err := OpenReadOnly(dir)
	if err != nil {
		t.Fatalf("OpenReadOnly() error = %v", err)
	}
	defer ro.Close()

	got, err := ro.Get([]byte("key"))
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if string(got) != "value" {
		t.Errorf("Get() = %q, want %q", got, "value")
	}
}
