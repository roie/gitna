package gitx

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

func TestResolveRevealPath(t *testing.T) {
	root := initTestRepo(t)
	repo := Repository{Root: root}
	if err := os.Mkdir(filepath.Join(root, "nested"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "nested", "notes.txt"), []byte("notes"), 0644); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"nested/", "nested/notes.txt"} {
		got, err := repo.ResolveRevealPath(context.Background(), path)
		if err != nil || got != filepath.Join(root, filepath.FromSlash(path)) {
			t.Fatalf("%q: %q, %v", path, got, err)
		}
	}
	for _, path := range []string{"", "../outside", ".git/config", "escape", "/tmp/outside"} {
		if _, err := repo.ResolveRevealPath(context.Background(), path); !errors.Is(err, protocol.ErrInvalidPath) {
			t.Fatalf("%q: %v", path, err)
		}
	}
	if _, err := repo.ResolveRevealPath(context.Background(), "escape/notes.txt"); err == nil {
		t.Fatal("accepted escaped ancestor")
	}
	if _, err := repo.ResolveRevealPath(context.Background(), "missing"); err == nil {
		t.Fatal("accepted missing path")
	}
}
