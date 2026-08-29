package gitx

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

func TestDirectoryEntriesPagesImmediateChildren(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"z.txt", "a.txt", "middle.txt"} {
		writeFile(t, filepath.Join(root, name), name)
	}
	if err := os.Mkdir(filepath.Join(root, "folder"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	repo := Repository{Root: root}
	first, err := repo.DirectoryEntries(context.Background(), "", "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := first.Entries, []protocol.DirectoryEntry{
		{Name: "a.txt", Path: "a.txt", Kind: protocol.DirectoryEntryFile},
		{Name: "folder", Path: "folder/", Kind: protocol.DirectoryEntryDirectory},
	}; !reflect.DeepEqual(got, want) {
		t.Fatalf("first entries = %#v, want %#v", got, want)
	}
	if !first.Truncated || first.NextCursor != "folder" {
		t.Fatalf("first page = %#v", first)
	}
	second, err := repo.DirectoryEntries(context.Background(), "", first.NextCursor, 2)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := second.Entries, []protocol.DirectoryEntry{
		{Name: "middle.txt", Path: "middle.txt", Kind: protocol.DirectoryEntryFile},
		{Name: "z.txt", Path: "z.txt", Kind: protocol.DirectoryEntryFile},
	}; !reflect.DeepEqual(got, want) {
		t.Fatalf("second entries = %#v, want %#v", got, want)
	}
	if second.Truncated {
		t.Fatalf("second page unexpectedly truncated: %#v", second)
	}
}

func TestDirectoryEntriesRejectsSymlinkDirectory(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	writeFile(t, filepath.Join(outside, "secret.txt"), "secret")
	if err := os.Symlink(outside, filepath.Join(root, "linked")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	repo := Repository{Root: root}
	if _, err := repo.DirectoryEntries(context.Background(), "linked", "", 10); err == nil {
		t.Fatal("DirectoryEntries followed a directory symlink")
	}
}
