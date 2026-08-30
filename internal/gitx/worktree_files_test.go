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

func TestCompareWorktreeFilesReturnsTextImagesAndBoundedPlaceholders(t *testing.T) {
	root := initTestRepo(t)
	repo := Repository{Root: root}
	for path, data := range map[string][]byte{
		"left.txt":   []byte("left\n"),
		"right.txt":  []byte("right\n"),
		"left.png":   []byte("\x89PNG\r\n\x1a\nleft"),
		"right.png":  []byte("\x89PNG\r\n\x1a\nright"),
		"binary.dat": {'a', 0, 'b'},
		"large.txt":  []byte(strings.Repeat("x", DefaultDiffBytes+1)),
	} {
		if err := os.WriteFile(filepath.Join(root, path), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	text, err := repo.CompareWorktreeFiles(context.Background(), "left.txt", "right.txt")
	if err != nil {
		t.Fatal(err)
	}
	if text.Before.Content != "left\n" || text.After.Content != "right\n" || text.Binary || text.TooLarge {
		t.Fatalf("text comparison = %#v", text)
	}
	images, err := repo.CompareWorktreeFiles(context.Background(), "left.png", "right.png")
	if err != nil {
		t.Fatal(err)
	}
	if !images.Binary || images.Before.Image == nil || images.After.Image == nil {
		t.Fatalf("image comparison = %#v", images)
	}
	binary, err := repo.CompareWorktreeFiles(context.Background(), "left.txt", "binary.dat")
	if err != nil {
		t.Fatal(err)
	}
	if !binary.Binary || binary.Before.Image != nil || binary.After.Image != nil {
		t.Fatalf("binary comparison = %#v", binary)
	}
	large, err := repo.CompareWorktreeFiles(context.Background(), "left.txt", "large.txt")
	if err != nil {
		t.Fatal(err)
	}
	if !large.TooLarge {
		t.Fatalf("large comparison = %#v", large)
	}
	if _, err := repo.CompareWorktreeFiles(context.Background(), "../escape", "right.txt"); !errors.Is(err, protocol.ErrInvalidPath) {
		t.Fatalf("unsafe comparison error = %v", err)
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
		"../escape":          protocol.ErrInvalidPath,
		".git/config":        protocol.ErrInvalidPath,
		"nested/.git/config": protocol.ErrInvalidPath,
		"link.txt":           protocol.ErrInvalidPath,
		"binary.dat":         protocol.ErrWorktreeBinary,
		"large.txt":          protocol.ErrWorktreeFileTooLarge,
		"missing/file":       protocol.ErrInvalidPath,
		"nested/../file":     protocol.ErrInvalidPath,
		`..\escape`:          protocol.ErrInvalidPath,
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
