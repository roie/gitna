package app

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/roie/gitna/internal/gitx"
)

func TestOrdinaryDirectoryEntriesIncludeChildMetadata(t *testing.T) {
	root := t.TempDir()
	for _, directory := range []string{"empty", "nonempty"} {
		if err := os.Mkdir(filepath.Join(root, directory), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "nonempty", "child.txt"), []byte("child"), 0o644); err != nil {
		t.Fatal(err)
	}
	adapter := &repoAdapter{repo: gitx.Repository{Root: root}, queue: gitx.NewMutationQueue()}
	t.Cleanup(adapter.directories.invalidate)

	entries, err := adapter.DirectoryEntries(t.Context(), "", "", 100)
	if err != nil {
		t.Fatal(err)
	}
	hasChildren := make(map[string]bool, len(entries.Entries))
	for _, entry := range entries.Entries {
		if entry.HasChildren != nil {
			hasChildren[entry.Path] = *entry.HasChildren
		}
	}
	if hasChildren["empty/"] || !hasChildren["nonempty/"] {
		t.Fatalf("entries = %#v, want ordinary-folder child metadata", entries.Entries)
	}
}

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
	if err := os.Mkdir(filepath.Join(root, "empty"), 0o755); err != nil {
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
	hasChildrenByPath := make(map[string]bool, len(rootEntries.Entries))
	for _, entry := range rootEntries.Entries {
		ignoredByPath[entry.Path] = entry.Ignored
		if entry.HasChildren != nil {
			hasChildrenByPath[entry.Path] = *entry.HasChildren
		}
	}
	if !ignoredByPath["ignored/"] {
		t.Fatalf("root entries = %#v, want ignored directory metadata", rootEntries.Entries)
	}
	if ignoredByPath["tracked.txt"] {
		t.Fatalf("root entries = %#v, tracked file marked ignored", rootEntries.Entries)
	}
	if !hasChildrenByPath["ignored/"] || hasChildrenByPath["empty/"] {
		t.Fatalf("root entries = %#v, want authoritative directory child metadata", rootEntries.Entries)
	}

	nestedEntries, err := adapter.DirectoryEntries(t.Context(), "ignored", "", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(nestedEntries.Entries) != 1 || !nestedEntries.Entries[0].Ignored {
		t.Fatalf("nested entries = %#v, want ignored child metadata", nestedEntries.Entries)
	}
}
