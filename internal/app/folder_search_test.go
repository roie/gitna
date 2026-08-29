package app

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
	"unsafe"

	"github.com/roie/gitna/internal/folder"
	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
)

func waitForFolderSearch(
	t *testing.T,
	adapter *repoAdapter,
	query string,
	recent []string,
	limit int,
) protocol.FileSearchResults {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		results, err := adapter.SearchFiles(t.Context(), query, recent, false, limit)
		if err != nil {
			t.Fatal(err)
		}
		if results.Complete {
			return results
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("search index did not complete")
	return protocol.FileSearchResults{}
}

func TestFolderSearchIndexesAndRanksOrdinaryFiles(t *testing.T) {
	root := t.TempDir()
	for path, contents := range map[string]string{
		"src/main.go":   "package main\n",
		"docs/main.go":  "package docs\n",
		"src/helper.go": "package main\n",
	} {
		full := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	adapter := &repoAdapter{ctx: ctx, repo: gitx.Repository{Root: root}, queue: gitx.NewMutationQueue()}
	results := waitForFolderSearch(t, adapter, "main", nil, 100)
	if len(results.Results) != 2 || results.Results[0].Name != "main.go" || !results.Results[0].DuplicateName {
		t.Fatalf("results = %#v", results)
	}
}

func TestFolderSearchExplicitRefreshRestartsIndexForUnobservedExternalChange(t *testing.T) {
	root := t.TempDir()
	adapter := &repoAdapter{ctx: t.Context(), repo: gitx.Repository{Root: root}, queue: gitx.NewMutationQueue()}
	initial := waitForFolderSearch(t, adapter, "external", nil, 100)
	if len(initial.Results) != 0 {
		t.Fatalf("initial results = %#v", initial.Results)
	}
	path := filepath.Join(root, "unopened", "external.txt")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("external"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := adapter.SearchFiles(t.Context(), "external", nil, true, 100); err != nil {
		t.Fatal(err)
	}
	refreshed := waitForFolderSearch(t, adapter, "external", nil, 100)
	if len(refreshed.Results) != 1 || refreshed.Results[0].Path != "unopened/external.txt" {
		t.Fatalf("refreshed results = %#v", refreshed.Results)
	}
}

func BenchmarkFolderSearchMillionFileDiskIndex(b *testing.B) {
	root := b.TempDir()
	file, err := os.CreateTemp(b.TempDir(), "search-index-*")
	if err != nil {
		b.Fatal(err)
	}
	writer := bufio.NewWriterSize(file, 256*1024)
	encoder := json.NewEncoder(writer)
	for index := range 1_000_000 {
		if err := encoder.Encode(fmt.Sprintf("packages/pkg-%06d/src/file-%06d.ts", index/100, index)); err != nil {
			b.Fatal(err)
		}
	}
	if err := writer.Flush(); err != nil {
		b.Fatal(err)
	}
	size, err := file.Seek(0, 1)
	if err != nil {
		b.Fatal(err)
	}
	if err := file.Close(); err != nil {
		b.Fatal(err)
	}
	adapter := &repoAdapter{ctx: b.Context(), repo: gitx.Repository{Root: root}, queue: gitx.NewMutationQueue()}
	adapter.search.rootKey = folder.PathKey(root)
	adapter.search.path = file.Name()
	adapter.search.publishedSize = size
	adapter.search.complete = true
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		results, err := adapter.searchFiles(b.Context(), "file-999999", []string{"packages/pkg-009999/src/file-999999.ts"}, 100)
		if err != nil {
			b.Fatal(err)
		}
		if len(results.Results) != 1 || results.Results[0].Path != "packages/pkg-009999/src/file-999999.ts" {
			b.Fatalf("results = %#v", results.Results)
		}
	}
	b.ReportMetric(float64(unsafe.Sizeof(adapter.search)), "retained-index-bytes")
}

func TestFolderSearchAppliesPaletteRecencyBeforeBoundedCutoff(t *testing.T) {
	root := t.TempDir()
	for _, path := range []string{"a/main.go", "b/main.go", "z/main.go"} {
		full := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(path), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	adapter := &repoAdapter{ctx: t.Context(), repo: gitx.Repository{Root: root}, queue: gitx.NewMutationQueue()}
	results := waitForFolderSearch(t, adapter, "main", []string{"z/main.go"}, 2)
	got := make([]string, 0, len(results.Results))
	for _, result := range results.Results {
		got = append(got, result.Path)
	}
	want := []string{"z/main.go", "a/main.go"}
	if !slices.Equal(got, want) {
		t.Fatalf("results = %#v, want rankPaletteFiles parity %#v", got, want)
	}
}
