package gitx

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
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

func TestRepositoryFileCountIncludesCurrentTrackedUntrackedAndIgnoredFiles(t *testing.T) {
	root := initTestRepo(t)
	if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte("ignored/\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for path, contents := range map[string]string{
		"tracked.txt":          "tracked",
		"untracked.txt":        "untracked",
		"ignored/generated.js": "ignored",
		"deleted.txt":          "deleted",
	} {
		full := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	runGit(t, root, "add", ".gitignore", "tracked.txt", "deleted.txt")
	runGit(t, root, "commit", "-qm", "add count fixture")
	if err := os.Remove(filepath.Join(root, "deleted.txt")); err != nil {
		t.Fatal(err)
	}

	total, err := (Repository{Root: root, GitDir: filepath.Join(root, ".git")}).RepositoryFileCount(t.Context(), &ExecRunner{})
	if err != nil {
		t.Fatal(err)
	}
	if total != 4 {
		t.Fatalf("total = %d, want 4", total)
	}
}

func TestRepositoryFilesDoesNotStatIgnoredManifestEntries(t *testing.T) {
	root := initTestRepo(t)
	if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte("ignored/\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "tracked.txt"), []byte("tracked"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "ignored"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"one.js", "two.js"} {
		if err := os.WriteFile(filepath.Join(root, "ignored", name), []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	runGit(t, root, "add", ".gitignore", "tracked.txt")
	runGit(t, root, "commit", "-qm", "add manifest fixture")

	statted := make([]string, 0)
	files, err := (Repository{Root: root, GitDir: filepath.Join(root, ".git")}).repositoryFiles(
		t.Context(),
		&ExecRunner{},
		"",
		100,
		func(path string) (os.FileInfo, error) {
			relative, err := filepath.Rel(root, path)
			if err != nil {
				t.Fatal(err)
			}
			statted = append(statted, filepath.ToSlash(relative))
			return os.Lstat(path)
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"ignored/one.js", "ignored/two.js"} {
		if slices.Contains(statted, path) {
			t.Fatalf("ignored manifest entry %q was statted", path)
		}
		if !slices.Contains(files.IgnoredPaths, path) {
			t.Fatalf("ignored paths = %#v, want %q", files.IgnoredPaths, path)
		}
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

func testFolderDirectoryPage(
	candidates []folderFileCandidate,
	globalAfter string,
	pageAfter string,
	limit int,
) folderDirectoryPage {
	filtered := make([]folderFileCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate.path > pageAfter && folderCandidateMayFollow(candidate, globalAfter) {
			filtered = append(filtered, candidate)
		}
	}
	slices.SortFunc(filtered, func(left, right folderFileCandidate) int {
		return strings.Compare(left.path, right.path)
	})
	page := folderDirectoryPage{candidates: filtered}
	if len(filtered) > limit {
		page.candidates = filtered[:limit]
		page.truncated = true
		page.nextCursor = page.candidates[len(page.candidates)-1].path
	}
	return page
}

func TestRepositoryFilesStopsAfterFindingTheNextPage(t *testing.T) {
	root := t.TempDir()
	readDirectories := make([]string, 0)
	readDirectory := func(
		ctx context.Context,
		_ string,
		relative string,
		globalAfter string,
		pageAfter string,
		limit int,
	) (folderDirectoryPage, error) {
		if err := ctx.Err(); err != nil {
			return folderDirectoryPage{}, err
		}
		readDirectories = append(readDirectories, relative)
		var candidates []folderFileCandidate
		switch relative {
		case "":
			candidates = []folderFileCandidate{{path: "a", directory: true}, {path: "z", directory: true}}
		case "a":
			candidates = []folderFileCandidate{{path: "a/1.txt"}, {path: "a/2.txt"}, {path: "a/3.txt"}}
		case "z":
			t.Fatal("read later subtree after the page boundary")
		}
		return testFolderDirectoryPage(candidates, globalAfter, pageAfter, limit), nil
	}

	page, err := (Repository{Root: root}).folderFilesWithReader(
		t.Context(),
		"",
		2,
		readDirectory,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(page.Paths, []string{"a/1.txt", "a/2.txt"}) ||
		!page.Truncated || page.NextCursor != "a/2.txt" {
		t.Fatalf("page = %#v", page)
	}
	if !reflect.DeepEqual(readDirectories, []string{"", "a"}) {
		t.Fatalf("read directories = %#v, want root and first subtree", readDirectories)
	}
}

func TestRepositoryFilesContinuesPastWideEmptyDirectoryPages(t *testing.T) {
	readDirectory := func(
		_ context.Context,
		_ string,
		relative string,
		globalAfter string,
		pageAfter string,
		limit int,
	) (folderDirectoryPage, error) {
		if relative != "" {
			return folderDirectoryPage{}, nil
		}
		candidates := []folderFileCandidate{
			{path: "a", directory: true}, {path: "b", directory: true},
			{path: "c", directory: true}, {path: "d", directory: true},
			{path: "z.txt"},
		}
		return testFolderDirectoryPage(candidates, globalAfter, pageAfter, limit), nil
	}
	page, err := (Repository{Root: t.TempDir()}).folderFilesWithReader(t.Context(), "", 1, readDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(page.Paths, []string{"z.txt"}) || page.Truncated {
		t.Fatalf("page = %#v, want final z.txt after empty directory pages", page)
	}
}

func TestRepositoryFilesCancelsDuringPageTraversal(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	readDirectory := func(
		_ context.Context,
		_ string,
		relative string,
		globalAfter string,
		pageAfter string,
		limit int,
	) (folderDirectoryPage, error) {
		var candidates []folderFileCandidate
		switch relative {
		case "":
			candidates = []folderFileCandidate{{path: "folder", directory: true}}
		case "folder":
			candidates = []folderFileCandidate{{path: "folder/file.txt"}}
			cancel()
		}
		return testFolderDirectoryPage(candidates, globalAfter, pageAfter, limit), nil
	}

	_, err := (Repository{Root: t.TempDir()}).folderFilesWithReader(ctx, "", 100, readDirectory)
	if err != context.Canceled {
		t.Fatalf("folderFilesWithReader error = %v, want context canceled", err)
	}
}

func TestFolderManifestSelectionBoundsMillionWideDirectoryFrontier(t *testing.T) {
	page, err := selectFolderDirectoryCandidates(
		t.Context(), millionWideDirectoryReader(), "", "", "", 2_000,
	)
	if err != nil {
		t.Fatal(err)
	}
	if page.maxRetained != 2_001 || len(page.candidates) != 2_000 || !page.truncated {
		t.Fatalf("page retained=%d candidates=%d truncated=%t, want 2001/2000/true", page.maxRetained, len(page.candidates), page.truncated)
	}
	if page.candidates[0].path != "file-0000001.txt" || page.nextCursor != "file-0002000.txt" {
		t.Fatalf("page range = %q..%q", page.candidates[0].path, page.nextCursor)
	}
}

func BenchmarkFolderManifestSelectionMillionWide(b *testing.B) {
	for b.Loop() {
		page, err := selectFolderDirectoryCandidates(
			context.Background(), millionWideDirectoryReader(), "", "", "", 2_000,
		)
		if err != nil || page.maxRetained != 2_001 || len(page.candidates) != 2_000 {
			b.Fatalf("retained=%d candidates=%d err=%v", page.maxRetained, len(page.candidates), err)
		}
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
