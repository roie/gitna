package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/roie/gitna/internal/gitx"
)

func TestContentSearch(t *testing.T) {
	root := t.TempDir()
	text := "😀 K NeedLE needle needles\n" + strings.Repeat("x", 600) + " needle\n  spaced  \n"
	if err := os.WriteFile(filepath.Join(root, "sample.txt"), []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	adapter := &repoAdapter{ctx: ctx, repo: gitx.Repository{Root: root}, queue: gitx.NewMutationQueue()}
	waitForFolderSearch(t, adapter, "", nil, 100)
	for _, tc := range []struct {
		name, query            string
		matchCase, regex, word bool
		count                  int
	}{
		{name: "literal case folding", query: "needle", count: 4},
		{name: "case sensitive", query: "needle", matchCase: true, count: 3},
		{name: "whole word", query: "needle", word: true, count: 3},
		{name: "regex", query: "need[a-z]+", regex: true, count: 4},
		{name: "spaces preserved", query: "  spaced  ", count: 1},
		{name: "space only", query: "  ", count: 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, err := adapter.SearchContent(t.Context(), tc.query, tc.matchCase, false, tc.regex, tc.word, "", "", 100)
			if err != nil {
				t.Fatal(err)
			}
			if len(result.Results) != 1 || len(result.Results[0].Matches) != tc.count {
				t.Fatalf("result = %#v", result)
			}
		})
	}
	result, err := adapter.SearchContent(t.Context(), "needle", false, false, false, true, "", "", 100)
	if err != nil {
		t.Fatal(err)
	}
	first, last := result.Results[0].Matches[0], result.Results[0].Matches[2]
	if first.Column != 5 || first.Length != 6 || first.MatchStart != 5 || first.MatchEnd != 11 {
		t.Fatalf("unicode offsets = %#v", first)
	}
	if !strings.Contains(last.Excerpt, "needle") || !utf8.ValidString(last.Excerpt) || last.Column != 601 {
		t.Fatalf("long excerpt = %#v", last)
	}
	if _, err := adapter.SearchContent(t.Context(), "[", false, false, true, false, "", "", 100); err == nil {
		t.Fatal("invalid regex accepted")
	}
	limited, err := adapter.SearchContent(t.Context(), "needle", false, false, false, false, "", "", 2)
	if err != nil || !limited.Truncated || len(limited.Results[0].Matches) != 2 {
		t.Fatalf("limit = %#v, %v", limited, err)
	}
}

func TestContentSearchLiteralPrefilterPreservesUnicodeFolding(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "fold.txt"), []byte("NEEDLE needle\nK ſ\nabsent\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	adapter := &repoAdapter{ctx: ctx, repo: gitx.Repository{Root: root}, queue: gitx.NewMutationQueue()}
	waitForFolderSearch(t, adapter, "", nil, 100)
	for _, tc := range []struct {
		query string
		count int
	}{
		{"needle", 2},
		{"k", 1},
		{"s", 2},
		{"missing", 0},
	} {
		result, err := adapter.SearchContent(t.Context(), tc.query, false, false, false, false, "", "", 100)
		if err != nil {
			t.Fatal(err)
		}
		count := 0
		for _, file := range result.Results {
			count += len(file.Matches)
		}
		if count != tc.count || !result.Complete {
			t.Fatalf("query %q = %#v, want %d matches", tc.query, result, tc.count)
		}
	}
}

func TestContentSearchPreservesOrderAndGlobalLimit(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"a.txt", "b.txt", "c.txt", "d.txt", "e.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("needle\nneedle\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	adapter := &repoAdapter{ctx: ctx, repo: gitx.Repository{Root: root}, queue: gitx.NewMutationQueue()}
	waitForFolderSearch(t, adapter, "", nil, 100)
	result, err := adapter.SearchContent(t.Context(), "needle", false, false, false, false, "", "", 3)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Truncated || len(result.Results) != 2 || result.Results[0].Path != "a.txt" || len(result.Results[0].Matches) != 2 || result.Results[1].Path != "b.txt" || len(result.Results[1].Matches) != 1 {
		t.Fatalf("ordered global limit = %#v", result)
	}
	result, err = adapter.SearchContent(t.Context(), "needle", false, false, false, false, "", "a.txt", 100)
	if err != nil || result.Truncated || len(result.Results) != 4 || result.Results[0].Path != "b.txt" || result.Results[3].Path != "e.txt" {
		t.Fatalf("filtered complete results = %#v, %v", result, err)
	}
	canceled, stop := context.WithCancel(t.Context())
	stop()
	if _, err := adapter.SearchContent(canceled, "needle", false, false, false, false, "", "", 3); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled search = %v", err)
	}
}

func TestContentSearchExcerptPreservesFullMatchLength(t *testing.T) {
	line := "before " + strings.Repeat("😀", 300)
	match := contentSearchExcerpt(line, 1, len("before "), len(line))
	if match.Length != 600 || match.MatchEnd-match.MatchStart >= match.Length || !utf8.ValidString(match.Excerpt) {
		t.Fatalf("truncated excerpt lost full UTF-16 match length: %#v", match)
	}
}

func TestContentSearchPathFilters(t *testing.T) {
	for _, tc := range []struct {
		path, include, exclude string
		want                   bool
	}{
		{"src/deep/file.ts", "**/*.ts", "", true},
		{"file.ts", "**/*.ts", "", true},
		{"src/deep/file.ts", "*.ts", "", true},
		{"src/deep/file.ts", "src", "", true},
		{"src/deep/file.ts", "src/**", "", true},
		{"src/deep/file.ts", "src/*.ts", "", false},
		{"node_modules/a/index.js", "", "**/node_modules/**", false},
		{"nested/node_modules/a/index.js", "", "**/node_modules/**", false},
		{"nested/vendor/index.js", "", "vendor", false},
		{"docs/file.md", "*.ts, *.md", "", true},
	} {
		if got := matchesSearchPath(tc.path, tc.include, tc.exclude); got != tc.want {
			t.Errorf("%q include %q exclude %q = %v", tc.path, tc.include, tc.exclude, got)
		}
	}
}
