package gitx

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestRepositoryFilesListsTrackedUntrackedAndIgnoredWorktreeFiles(t *testing.T) {
	root := initTestRepo(t)
	mustWrite := func(path, content string) {
		t.Helper()
		full := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mustWrite(".gitignore", "ignored/\n")
	mustWrite(".git/info/exclude", "/docs\n")
	mustWrite(".env", "visible")
	mustWrite("docs/design.md", "private notes")
	mustWrite("ignored/generated.js", "generated")
	mustWrite("src/main.go", "package main")
	runGit(t, root, "add", ".gitignore", "src/main.go")
	runGit(t, root, "commit", "-q", "-m", "add files")

	external := t.TempDir()
	mustExternal := filepath.Join(external, "secret")
	if err := os.WriteFile(mustExternal, []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(root, "external-link")); err != nil {
		t.Fatal(err)
	}

	files, err := (Repository{Root: root, GitDir: filepath.Join(root, ".git")}).RepositoryFiles(context.Background(), &ExecRunner{}, "", 100)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{".env", ".gitignore", "docs/design.md", "external-link", "ignored/generated.js", "src/main.go"}
	if !reflect.DeepEqual(files.Paths, want) {
		t.Fatalf("paths = %#v, want %#v", files.Paths, want)
	}
	wantIgnored := []string{"docs/design.md", "ignored/generated.js"}
	if !reflect.DeepEqual(files.IgnoredPaths, wantIgnored) {
		t.Fatalf("ignored paths = %#v, want %#v", files.IgnoredPaths, wantIgnored)
	}
	if files.Truncated {
		t.Fatal("unexpected truncation")
	}
}

func TestRepositoryFilesReportsTruncation(t *testing.T) {
	root := initTestRepo(t)
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	files, err := (Repository{Root: root}).RepositoryFiles(context.Background(), &ExecRunner{}, "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(files.Paths, []string{"a.txt", "b.txt"}) || !files.Truncated || files.NextCursor != "b.txt" {
		t.Fatalf("files = %#v", files)
	}
	if len(files.IgnoredPaths) != 0 {
		t.Fatalf("ignored paths = %#v, want none", files.IgnoredPaths)
	}

	next, err := (Repository{Root: root}).RepositoryFiles(context.Background(), &ExecRunner{}, files.NextCursor, 2)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(next.Paths, []string{"c.txt"}) || next.Truncated || next.NextCursor != "" {
		t.Fatalf("next = %#v", next)
	}
}

func TestRepositoryFilesDeduplicatesUnmergedPaths(t *testing.T) {
	root := initTestRepo(t)
	path := filepath.Join(root, "conflict.txt")
	if err := os.WriteFile(path, []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, root, "add", "conflict.txt")
	runGit(t, root, "commit", "-q", "-m", "add conflict file")
	runGit(t, root, "switch", "-q", "-c", "other")
	if err := os.WriteFile(path, []byte("other\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, root, "commit", "-qam", "change on other")
	runGit(t, root, "switch", "-q", "main")
	if err := os.WriteFile(path, []byte("main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, root, "commit", "-qam", "change on main")
	runGitErr(t, root, "merge", "other")

	files, err := (Repository{Root: root}).RepositoryFiles(context.Background(), &ExecRunner{}, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(files.Paths, []string{"conflict.txt"}) {
		t.Fatalf("paths = %#v, want one conflict path", files.Paths)
	}
}

func TestRepositoryFilesHonorsCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := (Repository{Root: initTestRepo(t)}).RepositoryFiles(ctx, &ExecRunner{}, "", 10)
	if err != context.Canceled {
		t.Fatalf("error = %v, want context canceled", err)
	}
}
