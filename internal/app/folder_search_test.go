package app

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
	"unsafe"

	"github.com/roie/gitna/internal/filesearch"
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

func TestFolderSearchRanksRootAndProjectPackagesBeforeNodeModules(t *testing.T) {
	root := t.TempDir()
	for _, path := range []string{
		"node_modules/z/package.json",
		"packages/app/package.json",
		"node_modules/.pnpm/react/node_modules/react/package.json",
		"package.json",
	} {
		full := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	adapter := &repoAdapter{ctx: t.Context(), repo: gitx.Repository{Root: root}, queue: gitx.NewMutationQueue()}
	results := waitForFolderSearch(t, adapter, "package.json", []string{"node_modules/z/package.json"}, 100)
	got := make([]string, len(results.Results))
	for index := range results.Results {
		got[index] = results.Results[index].Path
	}
	want := []string{
		"package.json",
		"packages/app/package.json",
		"node_modules/z/package.json",
		"node_modules/.pnpm/react/node_modules/react/package.json",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("paths = %#v, want %#v", got, want)
	}
}

func TestFolderSearchPublishesProjectFilesBeforeDeferredDependencies(t *testing.T) {
	root := t.TempDir()
	write := func(relative string) {
		t.Helper()
		full := filepath.Join(root, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(relative), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("package.json")
	write("src/owned.go")
	write("src/node_modules/nested/package.json")
	for index := range 4_100 {
		write(fmt.Sprintf("node_modules/pkg-%04d/package.json", index))
	}
	write(".git/private")

	builder := filesearch.NewBuilder(450 << 10)
	visited := make([]string, 0, 4_103)
	var firstPublication filesearch.Snapshot
	var beforeDependencies filesearch.Snapshot
	err := walkFolderSearchPaths(t.Context(), root, func(filePath string) error {
		if beforeDependencies.Len() == 0 && strings.Contains(strings.ToLower(filePath), "node_modules/") {
			beforeDependencies = builder.Snapshot(false)
		}
		visited = append(visited, filePath)
		builder.Add(filePath)
		return nil
	}, func() error {
		firstPublication = builder.Snapshot(false)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if firstPublication.Complete() || firstPublication.Len() != 1 {
		t.Fatalf("first publication = %d/%v, want one incomplete root file", firstPublication.Len(), firstPublication.Complete())
	}
	rootResults, err := firstPublication.Search(t.Context(), "package.json", nil, 100)
	if err != nil || len(rootResults) != 1 || rootResults[0].Path != "package.json" {
		t.Fatalf("first results = %#v, error = %v", rootResults, err)
	}
	projectResults, err := beforeDependencies.Search(t.Context(), "owned.go", nil, 100)
	if err != nil || len(projectResults) != 1 || projectResults[0].Path != "src/owned.go" {
		t.Fatalf("project-before-dependencies results = %#v, error = %v", projectResults, err)
	}
	if len(visited) != 4_103 || slices.Contains(visited, ".git/private") || !slices.Contains(visited, "src/node_modules/nested/package.json") {
		t.Fatalf("visited %d paths; git=%v nested-dependency=%v", len(visited), slices.Contains(visited, ".git/private"), slices.Contains(visited, "src/node_modules/nested/package.json"))
	}
	complete := builder.Snapshot(true)
	if !complete.Overflow() {
		t.Fatal("dependency traversal did not overflow the forced compact cap")
	}
	projectResults, err = complete.Search(t.Context(), "owned.go", nil, 100)
	if err != nil || len(projectResults) != 1 {
		t.Fatalf("project file was displaced by dependencies: %#v, error = %v", projectResults, err)
	}
}

func TestFolderSearchDiskFallbackMatchesCompactRanking(t *testing.T) {
	root := t.TempDir()
	for _, path := range []string{
		"node_modules/react/package.json",
		"node_modules/a/deep/package-helper.json",
		"packages/deep/app/package.json",
		"src/package-notes.json",
		"package.json",
	} {
		full := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	compact := &repoAdapter{ctx: t.Context(), repo: gitx.Repository{Root: root}, queue: gitx.NewMutationQueue()}
	fallback := &repoAdapter{ctx: t.Context(), repo: gitx.Repository{Root: root}, queue: gitx.NewMutationQueue()}
	fallback.search.memoryLimit = 1
	queries := []string{"package", "node_modules/react/package"}
	if runtime.GOOS == "windows" {
		queries = append(queries, "node_modules\\react\\package")
	}
	for _, query := range queries {
		want := waitForFolderSearch(t, compact, query, []string{"node_modules/react/package.json"}, 100)
		got := waitForFolderSearch(t, fallback, query, []string{"node_modules/react/package.json"}, 100)
		if !slices.Equal(got.Results, want.Results) {
			t.Fatalf("query %q fallback = %#v, compact = %#v", query, got.Results, want.Results)
		}
	}
	if !fallback.search.catalog.Overflow() {
		t.Fatal("catalog did not report memory-cap overflow")
	}
}

func TestFolderSearchDiskFallbackPreservesUnixBackslashFilename(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("backslash is a path separator on Windows")
	}
	root := t.TempDir()
	for _, path := range []string{`literal\name.txt`, "literal/name.txt"} {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(path), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	adapter := &repoAdapter{ctx: t.Context(), repo: gitx.Repository{Root: root}, queue: gitx.NewMutationQueue()}
	adapter.search.memoryLimit = 1
	results := waitForFolderSearch(t, adapter, `literal\name`, nil, 100)
	if len(results.Results) != 1 || results.Results[0].Path != `literal\name.txt` {
		t.Fatalf("results = %#v", results.Results)
	}
}

func TestValidRecentSearchPathsAreConfinedExistingFiles(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "repo")
	if err := os.MkdirAll(filepath.Join(root, "directory"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "existing.txt"), []byte("ok"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(parent, "outside.txt"), []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := validRecentSearchPaths(root, []string{
		"existing.txt", "missing.txt", "directory", "../outside.txt",
	}, 100)
	if !slices.Equal(got, []string{"existing.txt"}) {
		t.Fatalf("valid recent paths = %#v", got)
	}
	if got := validRecentSearchPaths(root, []string{"existing.txt", "missing-a", "missing-b"}, 2); len(got) != 0 {
		t.Fatalf("bounded recent paths = %#v, want no scan beyond newest two", got)
	}
}

func TestFolderSearchIndexesGitTrackedUntrackedAndIgnoredFiles(t *testing.T) {
	root := initSessionRepository(t, t.TempDir(), "repo")
	for path, contents := range map[string]string{
		"tracked.txt":           "tracked",
		"untracked.txt":         "untracked",
		"ignored/dependency.js": "ignored",
	} {
		full := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte("ignored/\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	command := gitx.ExecRunner{}
	result, err := command.Run(t.Context(), root, "add", ".gitignore", "tracked.txt")
	if err != nil || result.ExitCode != 0 {
		t.Fatalf("git add: %v: %s", err, result.Stderr)
	}

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	adapter := &repoAdapter{
		ctx:    ctx,
		repo:   gitx.Repository{Root: root, GitDir: filepath.Join(root, ".git")},
		runner: &command,
		queue:  gitx.NewMutationQueue(),
	}
	results := waitForFolderSearch(t, adapter, "", nil, 100)
	paths := make([]string, len(results.Results))
	for index, result := range results.Results {
		paths[index] = result.Path
	}
	for _, path := range []string{".gitignore", "ignored/dependency.js", "tracked.txt", "untracked.txt"} {
		if !slices.Contains(paths, path) {
			t.Fatalf("paths = %#v, want %q", paths, path)
		}
	}
	for _, path := range paths {
		if path == ".git" || filepath.HasPrefix(path, ".git/") {
			t.Fatalf("search indexed Git metadata path %q", path)
		}
	}
}

func TestFolderSearchSkipsLinkedWorktreeGitPointer(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, ".git"), []byte("gitdir: /tmp/worktree-metadata\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "visible.txt"), []byte("visible"), 0o644); err != nil {
		t.Fatal(err)
	}
	adapter := &repoAdapter{
		ctx:   t.Context(),
		repo:  gitx.Repository{Root: root, GitDir: filepath.Join(root, ".git")},
		queue: gitx.NewMutationQueue(),
	}
	results := waitForFolderSearch(t, adapter, "", nil, 100)
	if len(results.Results) != 1 || results.Results[0].Path != "visible.txt" {
		t.Fatalf("results = %#v, want only visible.txt", results.Results)
	}
}

func TestFolderSearchEmptyQueryRejectsStaleRecentEntries(t *testing.T) {
	root := t.TempDir()
	for _, path := range []string{"a-default.txt", "z-recent.txt"} {
		if err := os.WriteFile(filepath.Join(root, path), []byte(path), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(root, "directory"), 0o755); err != nil {
		t.Fatal(err)
	}
	adapter := &repoAdapter{ctx: t.Context(), repo: gitx.Repository{Root: root}, queue: gitx.NewMutationQueue()}
	results := waitForFolderSearch(t, adapter, "", []string{"z-recent.txt", "missing.txt", "directory"}, 100)
	if len(results.Results) != 2 || results.Results[0].Path != "z-recent.txt" {
		t.Fatalf("results = %#v", results.Results)
	}
	for _, result := range results.Results {
		if result.Path == "missing.txt" || result.Path == "directory" {
			t.Fatalf("invalid recent result = %#v", result)
		}
	}
}

func TestFolderSearchSkipsDisappearingAndUnreadableDescendants(t *testing.T) {
	root := t.TempDir()
	for name, walkErr := range map[string]error{
		"disappearing": fs.ErrNotExist,
		"unreadable":   fs.ErrPermission,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(root, name, "file.txt")
			if err := folderSearchWalkError(root, path, walkErr); err != nil {
				t.Fatalf("descendant error = %v, want skipped", err)
			}
		})
	}
	if err := folderSearchWalkError(root, root, fs.ErrPermission); !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("root error = %v, want permission error", err)
	}
}

func TestScanFolderSearchIndexStopsOnVisitorError(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "search-index-*")
	if err != nil {
		t.Fatal(err)
	}
	encoder := json.NewEncoder(file)
	for index := range 100 {
		if err := encoder.Encode(fmt.Sprintf("file-%03d.txt", index)); err != nil {
			t.Fatal(err)
		}
	}
	size, err := file.Seek(0, io.SeekCurrent)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	visitorErr := errors.New("stop visiting")
	visited := 0
	err = scanFolderSearchIndex(t.Context(), file.Name(), size, func(string) error {
		visited++
		if visited == 3 {
			return visitorErr
		}
		return nil
	})
	if !errors.Is(err, visitorErr) || visited != 3 {
		t.Fatalf("error = %v, visited = %d", err, visited)
	}
}

func TestFolderSearchFailedRetriesRemoveRetiredIndexes(t *testing.T) {
	root := filepath.Join(t.TempDir(), "missing")
	adapter := &repoAdapter{
		ctx:   t.Context(),
		repo:  gitx.Repository{Root: root},
		queue: gitx.NewMutationQueue(),
	}
	waitForFailure := func() string {
		t.Helper()
		for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
			adapter.search.mu.RLock()
			indexPath := adapter.search.path
			failed := adapter.search.err != nil && !adapter.search.building
			adapter.search.mu.RUnlock()
			if failed {
				if indexPath == "" {
					t.Fatal("failed index did not retain its temporary path")
				}
				return indexPath
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("search index did not fail")
		return ""
	}

	adapter.startFileSearchIndex()
	previousPath := waitForFailure()
	for range 3 {
		adapter.startFileSearchIndex()
		if _, err := os.Stat(previousPath); !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("retired index %q still exists: %v", previousPath, err)
		}
		previousPath = waitForFailure()
	}
	adapter.invalidateFileSearch()
	if _, err := os.Stat(previousPath); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("final failed index %q still exists after invalidation: %v", previousPath, err)
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

func BenchmarkFolderSearchCompactCatalog(b *testing.B) {
	for _, count := range []int{10_000, 100_000, 1_000_000} {
		b.Run(fmt.Sprintf("%d", count), func(b *testing.B) {
			builder := filesearch.NewBuilder(filesearch.DefaultMemoryLimit)
			for index := range count {
				builder.Add(fmt.Sprintf("packages/pkg-%06d/src/file-%06d.ts", index/100, index))
			}
			snapshot := builder.Snapshot(true)
			if snapshot.Overflow() {
				b.Fatalf("catalog exceeded memory cap at %d files", count)
			}
			root := b.TempDir()
			adapter := &repoAdapter{ctx: b.Context(), repo: gitx.Repository{Root: root}, queue: gitx.NewMutationQueue()}
			adapter.search.rootKey = folder.PathKey(root)
			adapter.search.complete = true
			adapter.search.catalog = snapshot
			want := fmt.Sprintf("packages/pkg-%06d/src/file-%06d.ts", (count-1)/100, count-1)
			query := fmt.Sprintf("file-%06d", count-1)
			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				results, err := adapter.searchFiles(b.Context(), query, []string{want}, 100)
				if err != nil {
					b.Fatal(err)
				}
				if len(results.Results) != 1 || results.Results[0].Path != want {
					b.Fatalf("results = %#v, want %q", results.Results, want)
				}
			}
			b.ReportMetric(float64(snapshot.MemoryBytes()), "retained-index-bytes")
		})
	}
}

func BenchmarkFolderSearchFuzzyMillion(b *testing.B) {
	builder := filesearch.NewBuilder(filesearch.DefaultMemoryLimit)
	for index := range 1_000_000 {
		builder.Add(fmt.Sprintf("packages/pkg-%06d/src/file-%06d.ts", index/100, index))
	}
	snapshot := builder.Snapshot(true)
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		results, err := snapshot.Search(b.Context(), "p009999f999999", nil, 100)
		if err != nil {
			b.Fatal(err)
		}
		if len(results) == 0 {
			b.Fatal("fuzzy query returned no results")
		}
	}
	b.ReportMetric(float64(snapshot.MemoryBytes()), "retained-index-bytes")
}

func BenchmarkFolderSearchCanceledMillion(b *testing.B) {
	builder := filesearch.NewBuilder(filesearch.DefaultMemoryLimit)
	for index := range 1_000_000 {
		builder.Add(fmt.Sprintf("packages/pkg-%06d/src/file-%06d.ts", index/100, index))
	}
	snapshot := builder.Snapshot(true)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		if _, err := snapshot.Search(ctx, "file", nil, 100); !errors.Is(err, context.Canceled) {
			b.Fatalf("error = %v, want canceled", err)
		}
	}
	b.ReportMetric(float64(snapshot.MemoryBytes()), "retained-index-bytes")
}

func BenchmarkFolderSearchEmptyMillion(b *testing.B) {
	builder := filesearch.NewBuilder(filesearch.DefaultMemoryLimit)
	for index := range 1_000_000 {
		builder.Add(fmt.Sprintf("packages/pkg-%06d/src/file-%06d.ts", index/100, index))
	}
	snapshot := builder.Snapshot(true)
	if snapshot.Overflow() {
		b.Fatal("catalog exceeded memory cap")
	}
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		results, err := snapshot.Search(b.Context(), "", nil, 100)
		if err != nil {
			b.Fatal(err)
		}
		if len(results) != 100 || results[0].Path != "packages/pkg-000000/src/file-000000.ts" {
			b.Fatalf("first result = %#v, want shallow project default", results[0])
		}
	}
	b.ReportMetric(float64(snapshot.MemoryBytes()), "retained-index-bytes")
}

func BenchmarkFolderSearchPackageJSONMillion(b *testing.B) {
	builder := filesearch.NewBuilder(filesearch.DefaultMemoryLimit)
	builder.Add("package.json")
	for index := 1; index < 1_000_000; index++ {
		builder.Add(fmt.Sprintf("node_modules/pkg-%06d/package.json", index))
	}
	snapshot := builder.Snapshot(true)
	if snapshot.Overflow() {
		b.Fatal("catalog exceeded memory cap")
	}
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		results, err := snapshot.Search(b.Context(), "package.json", []string{"node_modules/pkg-999999/package.json"}, 100)
		if err != nil {
			b.Fatal(err)
		}
		if len(results) != 100 || results[0].Path != "package.json" {
			b.Fatalf("first result = %#v, want repository root", results[0])
		}
	}
	b.ReportMetric(float64(snapshot.MemoryBytes()), "retained-index-bytes")
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
