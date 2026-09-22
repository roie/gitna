package app

import (
	"context"
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
