package app

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/roie/gitna/internal/gitx"
)

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
	var complete bool
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		results, err := adapter.SearchFiles(t.Context(), "main", 100)
		if err != nil {
			t.Fatal(err)
		}
		if results.Complete {
			complete = true
			if len(results.Results) != 2 || results.Results[0].Name != "main.go" || !results.Results[0].DuplicateName {
				t.Fatalf("results = %#v", results)
			}
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !complete {
		t.Fatal("search index did not complete")
	}
}
