package gitx

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

func TestOpenWorktreeMedia(t *testing.T) {
	root := t.TempDir()
	repo := Repository{Root: root}
	path := filepath.Join(root, "large.mp4")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(2 << 30); err != nil {
		t.Fatal(err)
	}
	file.Close()
	opened, err := repo.OpenWorktreeMedia(context.Background(), "large.mp4")
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Close()
	if _, err := opened.Seek((2<<30)-1, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	var last [1]byte
	if _, err := opened.Read(last[:]); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"../outside.mp4", "/outside.mp4", "a\\b.mp4", ".git/config", ".GIT/config", ".", ""} {
		f, err := repo.OpenWorktreeMedia(context.Background(), path)
		if f != nil {
			f.Close()
		}
		if !errors.Is(err, protocol.ErrInvalidPath) {
			t.Errorf("%q: got %v, want invalid path", path, err)
		}
	}
	if _, err := repo.OpenWorktreeMedia(context.Background(), "missing.mp4"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := repo.OpenWorktreeMedia(ctx, "large.mp4"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
	if err := os.Mkdir(filepath.Join(root, "directory.mp4"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.OpenWorktreeMedia(context.Background(), "directory.mp4"); !errors.Is(err, protocol.ErrInvalidPath) {
		t.Fatalf("directory: %v", err)
	}
}

func TestOpenWorktreeMediaRejectsSymlinkAliases(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.mp4"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".git", "secret.mp4"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, link := range []struct{ name, target, path string }{
		{"escape", outside, "escape/secret.mp4"},
		{"alias", filepath.Join(root, ".git"), "alias/secret.mp4"},
		{"leaf.mp4", filepath.Join(outside, "secret.mp4"), "leaf.mp4"},
	} {
		if err := os.Symlink(link.target, filepath.Join(root, link.name)); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		if f, err := (Repository{Root: root}).OpenWorktreeMedia(context.Background(), link.path); err == nil {
			f.Close()
			t.Fatalf("accepted alias %q", link.path)
		}
	}
}
