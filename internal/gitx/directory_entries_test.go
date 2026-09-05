package gitx

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"

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
	hasNoChildren := false
	first, err := repo.DirectoryEntries(context.Background(), "", "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := first.Entries, []protocol.DirectoryEntry{
		{Name: "a.txt", Path: "a.txt", Kind: protocol.DirectoryEntryFile},
		{Name: "folder", Path: "folder/", Kind: protocol.DirectoryEntryDirectory, HasChildren: &hasNoChildren},
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

type syntheticDirectoryEntry string

func (entry syntheticDirectoryEntry) Name() string { return string(entry) }
func (syntheticDirectoryEntry) IsDir() bool        { return false }
func (syntheticDirectoryEntry) Type() fs.FileMode  { return 0 }
func (entry syntheticDirectoryEntry) Info() (fs.FileInfo, error) {
	return syntheticFileInfo(entry), nil
}

type syntheticFileInfo string

func (info syntheticFileInfo) Name() string  { return string(info) }
func (syntheticFileInfo) Size() int64        { return 0 }
func (syntheticFileInfo) Mode() fs.FileMode  { return 0 }
func (syntheticFileInfo) ModTime() time.Time { return time.Time{} }
func (syntheticFileInfo) IsDir() bool        { return false }
func (syntheticFileInfo) Sys() any           { return nil }

func millionWideDirectoryReader() directoryBatchReader {
	const total = 1_000_000
	next := 0
	return func(limit int) ([]fs.DirEntry, error) {
		if next >= total {
			return nil, io.EOF
		}
		count := min(limit, total-next)
		entries := make([]fs.DirEntry, count)
		for index := range count {
			// Descending names exercise replacement in the bounded max-heap.
			entries[index] = syntheticDirectoryEntry(fmt.Sprintf("file-%07d.txt", total-next-index))
		}
		next += count
		return entries, nil
	}
}

func TestDirectoryEntrySelectionBoundsMillionWideDirectoryMemory(t *testing.T) {
	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)
	selected, maxRetained, err := selectDirectoryEntries(
		t.Context(), millionWideDirectoryReader(), "", 2_000,
	)
	if err != nil {
		t.Fatal(err)
	}
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	if maxRetained != 2_001 || len(selected) != 2_001 {
		t.Fatalf("retained max=%d selected=%d, want bounded 2001", maxRetained, len(selected))
	}
	if selected[0].name != "file-0000001.txt" || selected[len(selected)-1].name != "file-0002001.txt" {
		t.Fatalf("selected range = %q..%q", selected[0].name, selected[len(selected)-1].name)
	}
	const practicalAllocationLimit = 256 << 20
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > practicalAllocationLimit {
		t.Fatalf("million-entry scan allocated %d bytes, want <= %d", allocated, practicalAllocationLimit)
	}
}

func BenchmarkDirectoryEntrySelectionMillionWide(b *testing.B) {
	for b.Loop() {
		selected, maxRetained, err := selectDirectoryEntries(
			context.Background(), millionWideDirectoryReader(), "", 2_000,
		)
		if err != nil || len(selected) != 2_001 || maxRetained != 2_001 {
			b.Fatalf("selected=%d max=%d err=%v", len(selected), maxRetained, err)
		}
	}
}

func TestOpenedDirectoryMatchesValidatedIdentity(t *testing.T) {
	root := t.TempDir()
	firstPath := filepath.Join(root, "first")
	secondPath := filepath.Join(root, "second")
	if err := os.Mkdir(firstPath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(secondPath, 0o755); err != nil {
		t.Fatal(err)
	}
	validated, err := os.Lstat(firstPath)
	if err != nil {
		t.Fatal(err)
	}
	first, err := os.Open(firstPath)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := os.Open(secondPath)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()

	if !openedDirectoryMatches(validated, first) {
		t.Fatal("matching opened directory was rejected")
	}
	if openedDirectoryMatches(validated, second) {
		t.Fatal("replacement directory identity was accepted")
	}
}

func TestDirectoryEntriesReportVisibleChildren(t *testing.T) {
	root := t.TempDir()
	for _, directory := range []string{"empty", "metadata-only", "nonempty"} {
		if err := os.Mkdir(filepath.Join(root, directory), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(root, "metadata-only", ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(root, "nonempty", "child.txt"), "child")
	writeFile(t, filepath.Join(root, "root.txt"), "root")

	entries, err := (Repository{Root: root}).DirectoryEntries(t.Context(), "", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	hasChildren := make(map[string]bool, len(entries.Entries))
	for _, entry := range entries.Entries {
		if entry.HasChildren != nil {
			hasChildren[entry.Path] = *entry.HasChildren
		}
	}
	if hasChildren["empty/"] || hasChildren["metadata-only/"] {
		t.Fatalf("children metadata = %#v, want empty and metadata-only directories to be leaves", hasChildren)
	}
	if !hasChildren["nonempty/"] {
		t.Fatalf("children metadata = %#v, want nonempty directory expandable", hasChildren)
	}
	for _, entry := range entries.Entries {
		if entry.Kind == protocol.DirectoryEntryFile && entry.HasChildren != nil {
			t.Fatalf("file entry %#v unexpectedly includes child metadata", entry)
		}
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
