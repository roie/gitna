package gitx

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestRepositoryFilesListsWorktreeWithoutGitMetadata(t *testing.T) {
	root := t.TempDir()
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
	mustWrite(".git/config", "private")
	mustWrite(".env", "visible")
	mustWrite("ignored/generated.js", "visible")
	mustWrite("src/main.go", "package main")

	external := t.TempDir()
	mustExternal := filepath.Join(external, "secret")
	if err := os.WriteFile(mustExternal, []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(root, "external-link")); err != nil {
		t.Fatal(err)
	}

	files, err := (Repository{Root: root, GitDir: filepath.Join(root, ".git")}).RepositoryFiles(context.Background(), 100)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{".env", "external-link", "ignored/generated.js", "src/main.go"}
	if !reflect.DeepEqual(files.Paths, want) {
		t.Fatalf("paths = %#v, want %#v", files.Paths, want)
	}
	if files.Truncated {
		t.Fatal("unexpected truncation")
	}
}

func TestRepositoryFilesReportsTruncation(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	files, err := (Repository{Root: root}).RepositoryFiles(context.Background(), 2)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(files.Paths, []string{"a.txt", "b.txt"}) || !files.Truncated {
		t.Fatalf("files = %#v", files)
	}
}

func TestRepositoryFilesHonorsCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := (Repository{Root: t.TempDir()}).RepositoryFiles(ctx, 10)
	if err != context.Canceled {
		t.Fatalf("error = %v, want context canceled", err)
	}
}
