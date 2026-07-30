package storage

import (
	"strings"
	"testing"
)

func TestOpenCreatesAndCloses(t *testing.T) {
	dir := t.TempDir()

	db, err := Open(dir)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	if db == nil {
		t.Fatal("Open() returned nil database with nil error")
	}
	if err := db.Close(); err != nil {
		t.Fatalf("db.Close() error = %v", err)
	}
}

func TestOpenIsReopenable(t *testing.T) {
	dir := t.TempDir()

	db, err := Open(dir)
	if err != nil {
		t.Fatalf("first Open() error = %v", err)
	}

	const key = "storage-smoke-test-key"
	want := []byte("value")
	if err := db.Put([]byte(key), want); err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("first Close() error = %v", err)
	}

	db2, err := Open(dir)
	if err != nil {
		t.Fatalf("second Open() error = %v", err)
	}
	defer db2.Close()

	got, err := db2.Get([]byte(key))
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if string(got) != string(want) {
		t.Errorf("Get() = %q, want %q", got, want)
	}
}

func TestOpenTwiceWithoutClosingFails(t *testing.T) {
	dir := t.TempDir()

	db, err := Open(dir)
	if err != nil {
		t.Fatalf("first Open() error = %v", err)
	}
	defer db.Close()

	_, err = Open(dir)
	if err == nil {
		t.Fatal("second Open() on a still-open data dir succeeded, want a lock error")
	}
	if !strings.Contains(err.Error(), "zk-blockchain process") {
		t.Errorf("error = %q, want it to explain the lock conflict", err.Error())
	}
}
