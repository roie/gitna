package gitx

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestRepositoryFilesListsTrackedAndNonIgnoredWorktreeFiles(t *testing.T) {
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
	want := []string{".env", ".gitignore", "external-link", "src/main.go"}
	if !reflect.DeepEqual(files.Paths, want) {
		t.Fatalf("paths = %#v, want %#v", files.Paths, want)
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

	next, err := (Repository{Root: root}).RepositoryFiles(context.Background(), &ExecRunner{}, files.NextCursor, 2)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(next.Paths, []string{"c.txt"}) || next.Truncated || next.NextCursor != "" {
		t.Fatalf("next = %#v", next)
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
