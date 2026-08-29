package gitx

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"slices"
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

func TestRepositoryFilesPagesOrdinaryFolderInGlobalPathOrder(t *testing.T) {
	root := t.TempDir()
	paths := []string{
		"transport/index.js",
		"transport/package.json",
		"transport-exit-immediately.js",
		"z-last.txt",
	}
	for _, path := range paths {
		full := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(path), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	want := append([]string(nil), paths...)
	slices.Sort(want)
	var got []string
	seen := make(map[string]struct{})
	cursor := ""
	for pageNumber := 0; ; pageNumber++ {
		page, err := (Repository{Root: root}).RepositoryFiles(t.Context(), &ExecRunner{}, cursor, 1)
		if err != nil {
			t.Fatal(err)
		}
		if !slices.IsSorted(page.Paths) {
			t.Fatalf("page %d paths = %#v, want sorted", pageNumber, page.Paths)
		}
		for _, path := range page.Paths {
			if path <= cursor {
				t.Fatalf("page %d path %q is not after cursor %q", pageNumber, path, cursor)
			}
			if _, duplicate := seen[path]; duplicate {
				t.Fatalf("page %d repeats path %q", pageNumber, path)
			}
			seen[path] = struct{}{}
			got = append(got, path)
		}
		if !page.Truncated {
			if page.NextCursor != "" {
				t.Fatalf("final page cursor = %q, want empty", page.NextCursor)
			}
			break
		}
		if len(page.Paths) == 0 || page.NextCursor != page.Paths[len(page.Paths)-1] {
			t.Fatalf("page %d = %#v, want cursor at final path", pageNumber, page)
		}
		cursor = page.NextCursor
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("paged paths = %#v, want %#v", got, want)
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

func TestRepositoryFilesListsOrdinaryFolderWithoutGitMetadata(t *testing.T) {
	root := t.TempDir()
	for path, content := range map[string]string{
		".env":                  "secret",
		"docs/readme.md":        "docs",
		"nested/.git/config":    "metadata",
		"nested/source/main.go": "package main",
		"worktree/.git":         "gitdir: ../metadata",
		"worktree/file.txt":     "worktree file",
	} {
		full := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	files, err := (Repository{Root: root}).RepositoryFiles(t.Context(), &ExecRunner{}, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{".env", "docs/readme.md", "nested/source/main.go", "worktree/file.txt"}
	if !reflect.DeepEqual(files.Paths, want) {
		t.Fatalf("paths = %#v, want %#v", files.Paths, want)
	}
	if len(files.IgnoredPaths) != 0 || files.Truncated {
		t.Fatalf("files = %#v", files)
	}
}

func TestRepositoryFilesHonorsCanceledContext(t *testing.T) {
	for _, repository := range []Repository{
		{Root: initTestRepo(t)},
		{Root: t.TempDir()},
	} {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := repository.RepositoryFiles(ctx, &ExecRunner{}, "", 10)
		if err != context.Canceled {
			t.Fatalf("RepositoryFiles(%q) error = %v, want context canceled", repository.Root, err)
		}
	}
}
