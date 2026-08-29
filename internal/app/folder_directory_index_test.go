package app

import (
	"fmt"
	"os"
	"testing"
)

func TestDirectoryIndexPreservesEntryKindsAcrossSortedChunks(t *testing.T) {
	indexPath, sparse, err := buildDirectoryIndexFromScan(t.Context(), "", func(visit func(string, bool) error) error {
		for _, entry := range []struct {
			name      string
			directory bool
		}{{"a-directory", true}, {"b-file.txt", false}, {"c-file.txt", false}} {
			if err := visit(entry.name, entry.directory); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(indexPath) })
	page, err := readDirectoryIndexPage(&cachedDirectoryIndex{path: indexPath, sparse: sparse}, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Entries) != 3 || page.Entries[0].Kind != "directory" || page.Entries[1].Kind != "file" || page.Entries[2].Kind != "file" {
		t.Fatalf("entries = %#v", page.Entries)
	}
}

func TestMillionEntryDirectoryIndexBuildsOnceAndPagesFromDisk(t *testing.T) {
	if testing.Short() {
		t.Skip("million-entry external-sort regression")
	}
	const total = 1_000_000
	scans := 0
	indexPath, sparse, err := buildDirectoryIndexFromScan(t.Context(), "", func(visit func(string, bool) error) error {
		scans++
		// Reverse input proves paging does not depend on filesystem iteration order.
		for index := total - 1; index >= 0; index-- {
			if err := visit(fmt.Sprintf("file-%07d.txt", index), false); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(indexPath) })
	if scans != 1 {
		t.Fatalf("scans = %d, want 1", scans)
	}
	if len(sparse) > total/directoryIndexSparseStep+1 {
		t.Fatalf("sparse entries = %d, want bounded metadata", len(sparse))
	}
	index := &cachedDirectoryIndex{path: indexPath, sparse: sparse}
	first, err := readDirectoryIndexPage(index, "", 2_000)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Entries) != 2_000 || !first.Truncated || first.NextCursor != "file-0001999.txt" {
		t.Fatalf("first page = %d truncated=%v cursor=%q", len(first.Entries), first.Truncated, first.NextCursor)
	}
	second, err := readDirectoryIndexPage(index, first.NextCursor, 2_000)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Entries) != 2_000 || second.Entries[0].Name != "file-0002000.txt" {
		t.Fatalf("second page = %d first=%q", len(second.Entries), second.Entries[0].Name)
	}
	if scans != 1 {
		t.Fatalf("pagination rescanned directory: scans = %d", scans)
	}
}
