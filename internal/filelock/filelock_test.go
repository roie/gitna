package filelock

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func openLockFile(t *testing.T, path string) *os.File {
	t.Helper()
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

func lockAsync(t *testing.T, f *os.File) <-chan error {
	t.Helper()
	acquired := make(chan error, 1)
	go func() { acquired <- Lock(f) }()
	return acquired
}

func TestTryLockDoesNotWait(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.lock")
	first, second := openLockFile(t, path), openLockFile(t, path)
	if held, err := TryLock(first); err != nil || !held {
		t.Fatalf("first: held=%v err=%v", held, err)
	}
	if held, err := TryLock(second); err != nil || held {
		t.Fatalf("contended: held=%v err=%v", held, err)
	}
	if err := Unlock(first); err != nil {
		t.Fatal(err)
	}
	if held, err := TryLock(second); err != nil || !held {
		t.Fatalf("released: held=%v err=%v", held, err)
	}
}

func TestSecondLockWaitsForUnlock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.lock")
	first, second := openLockFile(t, path), openLockFile(t, path)
	if err := Lock(first); err != nil {
		t.Fatal(err)
	}

	acquired := lockAsync(t, second)
	select {
	case err := <-acquired:
		t.Fatalf("second Lock returned while the first was held: %v", err)
	case <-time.After(100 * time.Millisecond):
	}

	if err := Unlock(first); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-acquired:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("second Lock never returned after Unlock")
	}
}

func TestClosingTheFileReleasesTheLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.lock")
	first, second := openLockFile(t, path), openLockFile(t, path)
	if err := Lock(first); err != nil {
		t.Fatal(err)
	}

	acquired := lockAsync(t, second)
	select {
	case err := <-acquired:
		t.Fatalf("second Lock returned while the first was held: %v", err)
	case <-time.After(100 * time.Millisecond):
	}

	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-acquired:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("second Lock never returned after the first file closed")
	}
}
