package gitx

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

func readFile(t *testing.T, path string) (string, error) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func TestListConflictsEmpty(t *testing.T) {
	root := initTestRepo(t)
	repo, _ := Discover(context.Background(), &ExecRunner{}, root)
	conflicts, err := repo.ListConflicts(context.Background(), &ExecRunner{})
	if err != nil {
		t.Fatalf("ListConflicts: %v", err)
	}
	if len(conflicts) != 0 {
		t.Fatalf("expected no conflicts, got %d", len(conflicts))
	}
}

func TestListConflictsMerge(t *testing.T) {
	root, repo, runner := mergeFixture(t)

	runGitErr(t, root, "merge", "--no-edit", "feature")

	conflicts, err := repo.ListConflicts(context.Background(), runner)
	if err != nil {
		t.Fatalf("ListConflicts: %v", err)
	}
	if len(conflicts) != 1 {
		t.Fatalf("expected 1 conflict, got %d: %+v", len(conflicts), conflicts)
	}
	c := conflicts[0]
	if c.Path != "a.txt" {
		t.Fatalf("conflict path = %q, want a.txt", c.Path)
	}
	if c.OursOID == "" {
		t.Fatal("expected ours OID")
	}
	if c.TheirsOID == "" {
		t.Fatal("expected theirs OID")
	}
}

func TestConflictBlobOursAndTheirs(t *testing.T) {
	root, repo, runner := mergeFixture(t)

	runGitErr(t, root, "merge", "--no-edit", "feature")

	ours, err := repo.ConflictBlob(context.Background(), runner, "a.txt", 2)
	if err != nil {
		t.Fatalf("ConflictBlob ours: %v", err)
	}
	if string(ours) != "main version\n" {
		t.Fatalf("ours = %q, want main version", ours)
	}

	theirs, err := repo.ConflictBlob(context.Background(), runner, "a.txt", 3)
	if err != nil {
		t.Fatalf("ConflictBlob theirs: %v", err)
	}
	if string(theirs) != "feature version\n" {
		t.Fatalf("theirs = %q, want feature version", theirs)
	}
}

func TestConflictPathsAllowSpacesAndUnicode(t *testing.T) {
	root := initTestRepo(t)
	runner := &ExecRunner{}
	repo, err := Discover(context.Background(), runner, root)
	if err != nil {
		t.Fatal(err)
	}
	path := "d i r/ünïcode file.txt"
	writeFile(t, filepath.Join(root, filepath.FromSlash(path)), "base\n")
	runGit(t, root, "add", "--", path)
	runGit(t, root, "commit", "-qm", "base")
	runGit(t, root, "checkout", "-qb", "feature")
	writeFile(t, filepath.Join(root, filepath.FromSlash(path)), "feature version\n")
	runGit(t, root, "add", "--", path)
	runGit(t, root, "commit", "-qm", "feature")
	runGit(t, root, "checkout", "-q", "main")
	writeFile(t, filepath.Join(root, filepath.FromSlash(path)), "main version\n")
	runGit(t, root, "add", "--", path)
	runGit(t, root, "commit", "-qm", "main")
	runGitErr(t, root, "merge", "--no-edit", "feature")

	ours, err := repo.ConflictBlob(context.Background(), runner, path, 2)
	if err != nil {
		t.Fatalf("ConflictBlob ours: %v", err)
	}
	if string(ours) != "main version\n" {
		t.Fatalf("ours = %q, want main version", ours)
	}
	theirs, err := repo.ConflictBlob(context.Background(), runner, path, 3)
	if err != nil {
		t.Fatalf("ConflictBlob theirs: %v", err)
	}
	if string(theirs) != "feature version\n" {
		t.Fatalf("theirs = %q, want feature version", theirs)
	}
	if err := repo.ResolveConflictSide(context.Background(), runner, path, true); err != nil {
		t.Fatalf("ResolveConflictSide: %v", err)
	}
	if got, err := readFile(t, filepath.Join(root, filepath.FromSlash(path))); err != nil || got != "feature version\n" {
		t.Fatalf("resolved content = %q, %v; want theirs", got, err)
	}
}

func TestConflictOperationsRejectInvalidPaths(t *testing.T) {
	root := initTestRepo(t)
	repo, err := Discover(context.Background(), &ExecRunner{}, root)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"", "../escape", "a/../escape", filepath.Join(root, "absolute"), "nul\x00path"} {
		t.Run(path, func(t *testing.T) {
			if _, err := repo.ConflictBlob(context.Background(), &ExecRunner{}, path, 2); !errors.Is(err, protocol.ErrInvalidPath) {
				t.Fatalf("ConflictBlob(%q) error = %v, want ErrInvalidPath", path, err)
			}
			if err := repo.ResolveConflictSide(context.Background(), &ExecRunner{}, path, false); !errors.Is(err, protocol.ErrInvalidPath) {
				t.Fatalf("ResolveConflictSide(%q) error = %v, want ErrInvalidPath", path, err)
			}
			if err := repo.ResolveConflictBoth(context.Background(), &ExecRunner{}, path); !errors.Is(err, protocol.ErrInvalidPath) {
				t.Fatalf("ResolveConflictBoth(%q) error = %v, want ErrInvalidPath", path, err)
			}
		})
	}
}

func TestResolveConflictSideOurs(t *testing.T) {
	root, repo, runner := mergeFixture(t)

	runGitErr(t, root, "merge", "--no-edit", "feature")

	if err := repo.ResolveConflictSide(context.Background(), runner, "a.txt", false); err != nil {
		t.Fatalf("ResolveConflictSide ours: %v", err)
	}

	conflicts, _ := repo.ListConflicts(context.Background(), runner)
	if len(conflicts) != 0 {
		t.Fatalf("expected no conflicts after resolve, got %d", len(conflicts))
	}
	content, _ := readFile(t, filepath.Join(root, "a.txt"))
	if content != "main version\n" {
		t.Fatalf("worktree = %q, want ours", content)
	}
}

func TestResolveConflictBoth(t *testing.T) {
	root, repo, runner := mergeFixture(t)

	runGitErr(t, root, "merge", "--no-edit", "feature")

	if err := repo.ResolveConflictBoth(context.Background(), runner, "a.txt"); err != nil {
		t.Fatalf("ResolveConflictBoth: %v", err)
	}
	content, _ := readFile(t, filepath.Join(root, "a.txt"))
	if !strings.Contains(content, "main version") || !strings.Contains(content, "feature version") {
		t.Fatalf("worktree = %q, want both sides", content)
	}
	conflicts, err := repo.ListConflicts(context.Background(), runner)
	if err != nil || len(conflicts) != 0 {
		t.Fatalf("conflicts after resolve both = %+v, %v", conflicts, err)
	}
}

func TestResolveConflictSideTheirs(t *testing.T) {
	root, repo, runner := mergeFixture(t)

	runGitErr(t, root, "merge", "--no-edit", "feature")

	if err := repo.ResolveConflictSide(context.Background(), runner, "a.txt", true); err != nil {
		t.Fatalf("ResolveConflictSide theirs: %v", err)
	}

	content, _ := readFile(t, filepath.Join(root, "a.txt"))
	if content != "feature version\n" {
		t.Fatalf("worktree = %q, want theirs", content)
	}
}

func TestConflictBlobBadStage(t *testing.T) {
	root := initTestRepo(t)
	repo, _ := Discover(context.Background(), &ExecRunner{}, root)
	_, err := repo.ConflictBlob(context.Background(), &ExecRunner{}, "a.txt", 5)
	if err == nil {
		t.Fatal("expected error for bad stage")
	}
}

func TestParseLsFilesUnmerged(t *testing.T) {
	raw := "100644 aaa111 1\ta.txt\x00100644 bbb222 2\ta.txt\x00100644 ccc333 3\ta.txt\x00100644 ddd444 2\tb.txt\x00100644 eee555 3\tb.txt\x00"
	conflicts, err := parseLsFilesUnmerged([]byte(raw))
	if err != nil {
		t.Fatalf("parseLsFilesUnmerged: %v", err)
	}
	if len(conflicts) != 2 {
		t.Fatalf("expected 2 conflicts, got %d", len(conflicts))
	}
	if conflicts[0].Path != "a.txt" || conflicts[0].BaseOID != "aaa111" || conflicts[0].OursOID != "bbb222" || conflicts[0].TheirsOID != "ccc333" || conflicts[0].Mode != "100644" || !conflicts[0].CanResolveBoth {
		t.Fatalf("a.txt conflict = %+v", conflicts[0])
	}
	if conflicts[1].Path != "b.txt" || conflicts[1].BaseOID != "" || conflicts[1].OursOID != "ddd444" || conflicts[1].TheirsOID != "eee555" || conflicts[1].Mode != "100644" || !conflicts[1].CanResolveBoth {
		t.Fatalf("b.txt conflict = %+v", conflicts[1])
	}
}

func TestDiffConflictScope(t *testing.T) {
	root, repo, runner := mergeFixture(t)

	runGitErr(t, root, "merge", "--no-edit", "feature")

	fd, err := repo.Diff(context.Background(), runner, protocol.DiffConflict, protocol.DiffOptions{Path: "a.txt"})
	if err != nil {
		t.Fatalf("DiffConflict: %v", err)
	}
	if fd.Before.Content != "main version\n" {
		t.Fatalf("before = %q, want ours", fd.Before.Content)
	}
	if fd.After.Content != "feature version\n" {
		t.Fatalf("after = %q, want theirs", fd.After.Content)
	}
}
