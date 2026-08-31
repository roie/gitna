package app

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/roie/gitna/internal/gitx"
)

func TestRepositoryDirectoryEntriesIncludeGitIgnoredMetadata(t *testing.T) {
	root := initSessionRepository(t, t.TempDir(), "repo")
	if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte("ignored/\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "tracked.txt"), []byte("tracked"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "ignored"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "ignored", "dependency.js"), []byte("ignored"), 0o644); err != nil {
		t.Fatal(err)
	}
	runner := &gitx.ExecRunner{}
	result, err := runner.Run(t.Context(), root, "add", ".gitignore", "tracked.txt")
	if err != nil || result.ExitCode != 0 {
		t.Fatalf("git add: %v: %s", err, result.Stderr)
	}
	adapter := &repoAdapter{
		repo:   gitx.Repository{Root: root, GitDir: filepath.Join(root, ".git")},
		runner: runner,
		queue:  gitx.NewMutationQueue(),
	}

	rootEntries, err := adapter.DirectoryEntries(t.Context(), "", "", 100)
	if err != nil {
		t.Fatal(err)
	}
	ignoredByPath := make(map[string]bool, len(rootEntries.Entries))
	for _, entry := range rootEntries.Entries {
		ignoredByPath[entry.Path] = entry.Ignored
	}
	if !ignoredByPath["ignored/"] {
		t.Fatalf("root entries = %#v, want ignored directory metadata", rootEntries.Entries)
	}
	if ignoredByPath["tracked.txt"] {
		t.Fatalf("root entries = %#v, tracked file marked ignored", rootEntries.Entries)
	}

	nestedEntries, err := adapter.DirectoryEntries(t.Context(), "ignored", "", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(nestedEntries.Entries) != 1 || !nestedEntries.Entries[0].Ignored {
		t.Fatalf("nested entries = %#v, want ignored child metadata", nestedEntries.Entries)
	}
}
