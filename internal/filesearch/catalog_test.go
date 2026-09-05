package filesearch

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
)

func build(paths ...string) Snapshot {
	builder := NewBuilder(DefaultMemoryLimit)
	for _, path := range paths {
		builder.Add(path, false)
	}
	return builder.Snapshot(true)
}

func resultPaths(results []Result) []string {
	paths := make([]string, len(results))
	for index := range results {
		paths[index] = results[index].Path
	}
	return paths
}

func TestSearchRanksProjectFilesBeforeDependencies(t *testing.T) {
	snapshot := build(
		"node_modules/z/package.json",
		"packages/app/package.json",
		"node_modules/.pnpm/react/node_modules/react/package.json",
		"package.json",
	)
	results, err := snapshot.Search(t.Context(), "package.json", nil, 100, false)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"package.json",
		"packages/app/package.json",
		"node_modules/z/package.json",
		"node_modules/.pnpm/react/node_modules/react/package.json",
	}
	if got := resultPaths(results); !slices.Equal(got, want) {
		t.Fatalf("paths = %#v, want %#v", got, want)
	}
	if !results[0].DuplicateName || results[0].Parent != "" {
		t.Fatalf("root result = %#v, want duplicate at repository root", results[0])
	}
}

func TestSearchExplicitDependencyPathLiftsDependency(t *testing.T) {
	snapshot := build("src/react-package.json", "node_modules/react/package.json")
	results, err := snapshot.Search(t.Context(), "node_modules/react/package", nil, 100, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) == 0 || results[0].Path != "node_modules/react/package.json" {
		t.Fatalf("results = %#v, want explicit dependency first", results)
	}
}

func TestSearchRecencyDoesNotCrossSemanticTiers(t *testing.T) {
	snapshot := build("package.json", "packages/app/package.json", "node_modules/react/package.json")
	results, err := snapshot.Search(t.Context(), "package.json", []string{"node_modules/react/package.json"}, 100, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := resultPaths(results); !slices.Equal(got, []string{"package.json", "packages/app/package.json", "node_modules/react/package.json"}) {
		t.Fatalf("paths = %#v", got)
	}
}

func TestSearchExcludesIgnoredPathsUnlessIncluded(t *testing.T) {
	builder := NewBuilder(DefaultMemoryLimit)
	builder.Add("src/generated.ts", true)
	builder.Add("src/handwritten.ts", false)
	snapshot := builder.Snapshot(true)

	results, err := snapshot.Search(t.Context(), "src", nil, 100, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := resultPaths(results); !slices.Equal(got, []string{"src/handwritten.ts"}) {
		t.Fatalf("excluded paths = %#v", got)
	}
	if results[0].DuplicateName {
		t.Fatal("different visible basenames should not be duplicates")
	}
	defaults, err := snapshot.Search(t.Context(), "", nil, 100, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := resultPaths(defaults); !slices.Equal(got, []string{"src/handwritten.ts"}) {
		t.Fatalf("default paths = %#v", got)
	}
	results, err = snapshot.Search(t.Context(), "src", nil, 100, true)
	if err != nil {
		t.Fatal(err)
	}
	if got := resultPaths(results); !slices.Equal(got, []string{"src/generated.ts", "src/handwritten.ts"}) {
		t.Fatalf("included paths = %#v", got)
	}
}

func TestSearchSupportsUnicodeAndSlashNormalizedPaths(t *testing.T) {
	snapshot := build("パッケージ/設定.json", "src/config.json")
	results, err := snapshot.Search(t.Context(), "パッケージ/設定", nil, 100, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Path != "パッケージ/設定.json" {
		t.Fatalf("results = %#v", results)
	}
}

func TestSearchReturnsAuthoritativeMatchRuneIndices(t *testing.T) {
	tests := []struct {
		name  string
		path  string
		query string
		want  []int
	}{
		{name: "exact", path: "package.json", query: "package.json", want: []int{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11}},
		{name: "name prefix", path: "src/package.json", query: "pack", want: []int{4, 5, 6, 7}},
		{name: "name substring", path: "src/package.json", query: "age.j", want: []int{8, 9, 10, 11, 12}},
		{name: "path substring", path: "src/client/index.ts", query: "client/in", want: []int{4, 5, 6, 7, 8, 9, 10, 11, 12}},
		{name: "fuzzy", path: "src/package.json", query: "pjson", want: []int{4, 12, 13, 14, 15}},
		{name: "multiple terms", path: "src/package.json", query: "src pjson", want: []int{0, 1, 2, 4, 12, 13, 14, 15}},
		{name: "filename fuzzy before parent", path: ".opencode/package.json", query: "pkg json", want: []int{10, 13, 15, 18, 19, 20, 21}},
		{name: "exact multiword name", path: "foo bar", query: "foo bar", want: []int{0, 1, 2, 3, 4, 5, 6}},
		{name: "unicode", path: "パ/İndex.ts", query: "ixt", want: []int{2, 6, 8}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			results, err := build(test.path).Search(t.Context(), test.query, nil, 1, false)
			if err != nil {
				t.Fatal(err)
			}
			if len(results) != 1 || !slices.Equal(results[0].MatchIndices, test.want) {
				t.Fatalf("results = %#v, want indices %#v", results, test.want)
			}
		})
	}

	results, err := build("recent.txt").Search(t.Context(), "", []string{"recent.txt"}, 1, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].MatchIndices != nil {
		t.Fatalf("empty-query results = %#v, want no match indices", results)
	}
}

func TestRankPathsMatchIndicesAgreeWithCompactSearch(t *testing.T) {
	paths := []string{"src/package.json", ".opencode/package.json", "src/client/index.ts", "パ/İndex.ts"}
	scan := func(visit func(string, bool) error) error {
		for _, path := range paths {
			if err := visit(path, false); err != nil {
				return err
			}
		}
		return nil
	}
	compact := build(paths...)
	for _, query := range []string{"age.j", "client/in", "src pjson", "pkg json", "ixt"} {
		want, err := compact.Search(t.Context(), query, nil, 100, false)
		if err != nil {
			t.Fatal(err)
		}
		got, err := RankPaths(t.Context(), query, nil, 100, scan, false)
		if err != nil {
			t.Fatal(err)
		}
		if !slices.EqualFunc(got, want, func(left, right Result) bool {
			return left.Path == right.Path && slices.Equal(left.MatchIndices, right.MatchIndices)
		}) {
			t.Fatalf("query %q disk = %#v, compact = %#v", query, got, want)
		}
	}
}

func TestFuzzyScoreDoesNotMatchReplacementRuneInsideMultibyteEncoding(t *testing.T) {
	if _, ok := fuzzyScore("éx", "é\uFFFD"); ok {
		t.Fatal("fuzzy score matched a replacement rune inside a valid multibyte character")
	}
	if _, ok := fuzzyScore("éx", "éx"); !ok {
		t.Fatal("fuzzy score rejected a valid multibyte subsequence")
	}
}

func TestEmptySearchUsesBoundedRecentPathsThenShallowDefaults(t *testing.T) {
	snapshot := build(
		"deep/project/default.txt",
		"node_modules/pkg/dependency.txt",
		"root.txt",
		"src/shallow.txt",
	)
	results, err := snapshot.Search(t.Context(), "", []string{
		"old/recent.txt", "../escape.txt", "deep/recent.txt",
	}, 4, false)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"deep/recent.txt", "old/recent.txt", "root.txt", "src/shallow.txt"}
	if got := resultPaths(results); !slices.Equal(got, want) {
		t.Fatalf("paths = %#v, want %#v", got, want)
	}
}

func TestNormalizeRecentPathUsesPlatformSeparators(t *testing.T) {
	got, ok := NormalizeRecentPath(`dir\file.txt`)
	if !ok {
		t.Fatal("path was rejected")
	}
	want := `dir\file.txt`
	if runtime.GOOS == "windows" {
		want = "dir/file.txt"
	}
	if got != want {
		t.Fatalf("path = %q, want %q", got, want)
	}
}

func TestProgressiveSnapshotsRemainImmutable(t *testing.T) {
	builder := NewBuilder(DefaultMemoryLimit)
	builder.Add("first.txt", false)
	first := builder.Snapshot(false)
	builder.Add("second.txt", false)
	second := builder.Snapshot(true)
	if first.Complete() || first.Len() != 1 || second.Len() != 2 || !second.Complete() {
		t.Fatalf("first=%d/%v second=%d/%v", first.Len(), first.Complete(), second.Len(), second.Complete())
	}
}

func TestCompleteSnapshotSealsDuplicateMetadata(t *testing.T) {
	builder := NewBuilder(DefaultMemoryLimit)
	builder.Add("first/name.txt", false)
	snapshot := builder.Snapshot(true)
	if builder.Add("second/name.txt", false) {
		t.Fatal("sealed builder accepted another path")
	}

	var wait sync.WaitGroup
	for range 8 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			results, err := snapshot.Search(t.Context(), "name.txt", nil, 10, false)
			if err != nil || len(results) != 1 || results[0].DuplicateName {
				t.Errorf("results=%#v error=%v", results, err)
			}
		}()
	}
	wait.Wait()
}

func TestBuilderEnforcesMemoryLimit(t *testing.T) {
	builder := NewBuilder(1)
	if cap(builder.paths) != 0 || cap(builder.folded) != 0 || cap(builder.records) != 0 || cap(builder.defaults) != 0 {
		t.Fatalf(
			"tiny builder capacities paths=%d folded=%d records=%d defaults=%d",
			cap(builder.paths), cap(builder.folded), cap(builder.records), cap(builder.defaults),
		)
	}
	builder.Add("one-long-file-name.txt", false)
	builder.Add("two-long-file-name.txt", false)
	snapshot := builder.Snapshot(true)
	if !snapshot.Overflow() || snapshot.MemoryBytes() > 1 {
		t.Fatalf("overflow=%v memory=%d", snapshot.Overflow(), snapshot.MemoryBytes())
	}
}

func TestMemoryReportIncludesBoundedDefaultResults(t *testing.T) {
	const limit = int64(1 << 20)
	builder := NewBuilder(limit)
	for range 100 {
		builder.Add(strings.Repeat("nested/", 10)+strings.Repeat("x", 4_000)+".txt", false)
	}
	snapshot := builder.Snapshot(true)
	if snapshot.MemoryBytes() > limit {
		t.Fatalf("memory = %d, limit = %d", snapshot.MemoryBytes(), limit)
	}
}

func TestRankPathsStopsEnumerationAtCancellationCheckpoint(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	enumerated := 0
	_, err := RankPaths(ctx, "file", nil, 100, func(visit func(string, bool) error) error {
		for index := range 10_000 {
			enumerated++
			if err := visit(fmt.Sprintf("file-%05d.txt", index), false); err != nil {
				return err
			}
			if enumerated == 17 {
				cancel()
			}
		}
		return nil
	}, false)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want canceled", err)
	}
	if enumerated > 257 {
		t.Fatalf("enumerated %d paths after cancellation, want at most 257", enumerated)
	}
}

func TestRankPathsExcludesIgnoredPathsUnlessIncluded(t *testing.T) {
	scan := func(visit func(string, bool) error) error {
		if err := visit("ignored/result.ts", true); err != nil {
			return err
		}
		return visit("visible/result.ts", false)
	}
	results, err := RankPaths(t.Context(), "result", nil, 100, scan, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := resultPaths(results); !slices.Equal(got, []string{"visible/result.ts"}) {
		t.Fatalf("excluded paths = %#v", got)
	}
	if !results[0].DuplicateName {
		t.Fatal("disk fallback duplicate metadata should match compact catalog semantics")
	}
	results, err = RankPaths(t.Context(), "result", nil, 100, scan, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 {
		t.Fatalf("included results = %#v", results)
	}
}

func TestRankPathsPreservesUnixBackslashFilenames(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("backslash is a path separator on Windows")
	}
	paths := []string{`literal\name.txt`, "literal/name.txt"}
	results, err := RankPaths(t.Context(), `literal\name`, nil, 100, func(visit func(string, bool) error) error {
		for _, filePath := range paths {
			if err := visit(filePath, false); err != nil {
				return err
			}
		}
		return nil
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := resultPaths(results); !slices.Equal(got, []string{`literal\name.txt`}) {
		t.Fatalf("paths = %#v", got)
	}
}

func TestSearchHonorsCancellation(t *testing.T) {
	builder := NewBuilder(DefaultMemoryLimit)
	for index := 0; index < 10_000; index++ {
		builder.Add("node_modules/pkg/file.txt", false)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := builder.Snapshot(true).Search(ctx, "file", nil, 100, false)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want canceled", err)
	}
}
