package gitx

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

func TestWorktreeFileReadWriteAndConflict(t *testing.T) {
	root := initTestRepo(t)
	path := filepath.Join(root, "notes.txt")
	if err := os.WriteFile(path, []byte("before\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	repo := Repository{Root: root}
	loaded, err := repo.ReadWorktreeFile(context.Background(), "notes.txt")
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Content != "before\n" || loaded.Hash == "" {
		t.Fatalf("loaded = %#v", loaded)
	}

	saved, err := repo.WriteWorktreeFile(context.Background(), "notes.txt", "after\n", loaded.Hash)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Content != "after\n" || saved.Hash == loaded.Hash {
		t.Fatalf("saved = %#v", saved)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o640 {
		t.Fatalf("mode = %o, want 640", info.Mode().Perm())
	}
	if _, err := repo.WriteWorktreeFile(context.Background(), "notes.txt", "stale\n", loaded.Hash); !errors.Is(err, protocol.ErrWorktreeConflict) {
		t.Fatalf("stale write error = %v, want ErrWorktreeConflict", err)
	}
}

func TestWorktreeFileRejectsUnsafeAndUnsupportedInputs(t *testing.T) {
	root := initTestRepo(t)
	repo := Repository{Root: root}
	if err := os.WriteFile(filepath.Join(root, "binary.dat"), []byte{'a', 0, 'b'}, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "large.txt"), []byte(strings.Repeat("x", DefaultDiffBytes+1)), 0o644); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "link.txt")); err != nil {
		t.Fatal(err)
	}

	for path, want := range map[string]error{
		"../escape":      protocol.ErrInvalidPath,
		".git/config":    protocol.ErrInvalidPath,
		"link.txt":       protocol.ErrInvalidPath,
		"binary.dat":     protocol.ErrWorktreeBinary,
		"large.txt":      protocol.ErrWorktreeFileTooLarge,
		"missing/file":   protocol.ErrInvalidPath,
		"nested/../file": protocol.ErrInvalidPath,
		`..\escape`:      protocol.ErrInvalidPath,
	} {
		t.Run(path, func(t *testing.T) {
			_, err := repo.ReadWorktreeFile(context.Background(), path)
			if !errors.Is(err, want) {
				t.Fatalf("error = %v, want %v", err, want)
			}
		})
	}
}

func TestCreateAndRenameWorktreeEntries(t *testing.T) {
	root := initTestRepo(t)
	repo := Repository{Root: root}
	ctx := context.Background()
	if err := repo.CreateWorktreeEntry(ctx, "docs", true); err != nil {
		t.Fatal(err)
	}
	if err := repo.CreateWorktreeEntry(ctx, "docs/new.txt", false); err != nil {
		t.Fatal(err)
	}
	if err := repo.CreateWorktreeEntry(ctx, "docs/new.txt", false); !errors.Is(err, protocol.ErrWorktreeEntryExists) {
		t.Fatalf("duplicate error = %v, want ErrWorktreeEntryExists", err)
	}
	if err := repo.RenameWorktreeEntry(ctx, "docs/new.txt", "docs/renamed.txt"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "docs", "renamed.txt")); err != nil {
		t.Fatal(err)
	}
	if err := repo.RenameWorktreeEntry(ctx, "docs", "docs/child"); !errors.Is(err, protocol.ErrInvalidPath) {
		t.Fatalf("recursive rename error = %v, want ErrInvalidPath", err)
	}
}
