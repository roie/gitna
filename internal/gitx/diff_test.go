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

func diffRepo(t *testing.T) (Repository, Runner) {
	t.Helper()
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "a.txt"), "one\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "add a")
	return Repository{Root: root, GitDir: filepath.Join(root, ".git")}, &ExecRunner{}
}

func TestDiffUnstagedModified(t *testing.T) {
	repo, runner := diffRepo(t)
	writeFile(t, filepath.Join(repo.Root, "a.txt"), "one\ntwo\n")

	d, err := repo.Diff(context.Background(), runner, protocol.DiffUnstaged, protocol.DiffOptions{Path: "a.txt"})
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if d.Binary || d.TooLarge {
		t.Fatalf("unexpected flags binary=%v tooLarge=%v", d.Binary, d.TooLarge)
	}
	if d.Before.Content != "one\n" {
		t.Fatalf("Before = %q, want %q", d.Before.Content, "one\n")
	}
	if d.After.Content != "one\ntwo\n" {
		t.Fatalf("After = %q, want %q", d.After.Content, "one\ntwo\n")
	}
}

func TestDiffStagedModified(t *testing.T) {
	repo, runner := diffRepo(t)
	writeFile(t, filepath.Join(repo.Root, "a.txt"), "one\ntwo\n")
	runGit(t, repo.Root, "add", "a.txt")

	d, err := repo.Diff(context.Background(), runner, protocol.DiffStaged, protocol.DiffOptions{Path: "a.txt"})
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if d.Before.Content != "one\n" {
		t.Fatalf("Before = %q, want HEAD content", d.Before.Content)
	}
	if d.After.Content != "one\ntwo\n" {
		t.Fatalf("After = %q, want index content", d.After.Content)
	}
}

func TestDiffUnstagedUsesIndexAsBase(t *testing.T) {
	repo, runner := diffRepo(t)
	writeFile(t, filepath.Join(repo.Root, "a.txt"), "one\nstaged\n")
	runGit(t, repo.Root, "add", "a.txt")
	writeFile(t, filepath.Join(repo.Root, "a.txt"), "one\nstaged\nworktree\n")

	d, err := repo.Diff(context.Background(), runner, protocol.DiffUnstaged, protocol.DiffOptions{Path: "a.txt"})
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if d.Before.Content != "one\nstaged\n" {
		t.Fatalf("Before = %q, want index content", d.Before.Content)
	}
	if d.After.Content != "one\nstaged\nworktree\n" {
		t.Fatalf("After = %q, want worktree content", d.After.Content)
	}
}

func TestDiffUntracked(t *testing.T) {
	repo, runner := diffRepo(t)
	writeFile(t, filepath.Join(repo.Root, "new.txt"), "hello\n")

	d, err := repo.Diff(context.Background(), runner, protocol.DiffUnstaged, protocol.DiffOptions{Path: "new.txt"})
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if d.Before.Content != "" {
		t.Fatalf("Before = %q, want empty", d.Before.Content)
	}
	if d.After.Content != "hello\n" {
		t.Fatalf("After = %q, want worktree content", d.After.Content)
	}
}

func TestDiffStagedDeleted(t *testing.T) {
	repo, runner := diffRepo(t)
	runGit(t, repo.Root, "rm", "-q", "a.txt")

	d, err := repo.Diff(context.Background(), runner, protocol.DiffStaged, protocol.DiffOptions{Path: "a.txt"})
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if d.Before.Content != "one\n" {
		t.Fatalf("Before = %q, want HEAD content", d.Before.Content)
	}
	if d.After.Content != "" {
		t.Fatalf("After = %q, want empty", d.After.Content)
	}
}

func TestDiffStagedRename(t *testing.T) {
	repo, runner := diffRepo(t)
	runGit(t, repo.Root, "mv", "a.txt", "renamed.txt")

	d, err := repo.Diff(context.Background(), runner, protocol.DiffStaged, protocol.DiffOptions{Path: "renamed.txt", OldPath: "a.txt"})
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if d.Before.Path != "a.txt" || d.Before.Content != "one\n" {
		t.Fatalf("Before = %+v, want a.txt with one\\n", d.Before)
	}
	if d.After.Path != "renamed.txt" || d.After.Content != "one\n" {
		t.Fatalf("After = %+v, want renamed.txt with one\\n", d.After)
	}
}

func TestDiffEmptyAddedFile(t *testing.T) {
	repo, runner := diffRepo(t)
	writeFile(t, filepath.Join(repo.Root, "empty.txt"), "")
	runGit(t, repo.Root, "add", "empty.txt")

	d, err := repo.Diff(context.Background(), runner, protocol.DiffStaged, protocol.DiffOptions{Path: "empty.txt"})
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if d.Binary || d.TooLarge {
		t.Fatalf("empty file flagged binary=%v tooLarge=%v", d.Binary, d.TooLarge)
	}
	if d.Before.Content != "" || d.After.Content != "" {
		t.Fatalf("empty file contents = %q / %q", d.Before.Content, d.After.Content)
	}
}

func TestDiffBinaryStaged(t *testing.T) {
	repo, runner := diffRepo(t)
	writeFile(t, filepath.Join(repo.Root, "bin.dat"), "abc\x00def")
	runGit(t, repo.Root, "add", "bin.dat")

	d, err := repo.Diff(context.Background(), runner, protocol.DiffStaged, protocol.DiffOptions{Path: "bin.dat"})
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if !d.Binary {
		t.Fatal("binary file not flagged")
	}
	if d.Before.Content != "" || d.After.Content != "" {
		t.Fatalf("binary content not cleared: %q / %q", d.Before.Content, d.After.Content)
	}
}

func TestDiffOversizedUntracked(t *testing.T) {
	repo, runner := diffRepo(t)
	writeFile(t, filepath.Join(repo.Root, "big.txt"), strings.Repeat("x", DefaultDiffBytes+1))

	d, err := repo.Diff(context.Background(), runner, protocol.DiffUnstaged, protocol.DiffOptions{Path: "big.txt"})
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if !d.TooLarge {
		t.Fatal("oversized file not flagged")
	}
	if d.After.Content != "" {
		t.Fatal("oversized content should be empty")
	}
}

func TestDiffCommitScope(t *testing.T) {
	repo, runner := diffRepo(t)
	writeFile(t, filepath.Join(repo.Root, "a.txt"), "one\ntwo\n")
	runGit(t, repo.Root, "add", "a.txt")
	runGit(t, repo.Root, "commit", "-qm", "second")
	oid := strings.TrimSpace(runGit(t, repo.Root, "rev-parse", "HEAD"))

	d, err := repo.Diff(context.Background(), runner, protocol.DiffCommit, protocol.DiffOptions{Path: "a.txt", Commit: oid})
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if d.Before.Content != "one\n" {
		t.Fatalf("Before = %q, want parent content", d.Before.Content)
	}
	if d.After.Content != "one\ntwo\n" {
		t.Fatalf("After = %q, want commit content", d.After.Content)
	}
}

func TestDiffRootCommitBeforeEmpty(t *testing.T) {
	repo, runner := diffRepo(t)
	oid := strings.TrimSpace(runGit(t, repo.Root, "rev-parse", "HEAD"))

	d, err := repo.Diff(context.Background(), runner, protocol.DiffCommit, protocol.DiffOptions{Path: "a.txt", Commit: oid})
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if d.Before.Content != "" {
		t.Fatalf("Before = %q, want empty for root commit", d.Before.Content)
	}
	if d.After.Content != "one\n" {
		t.Fatalf("After = %q, want added content", d.After.Content)
	}
}

func TestDiffCompareScope(t *testing.T) {
	repo, runner := diffRepo(t)
	writeFile(t, filepath.Join(repo.Root, "a.txt"), "one\ntwo\n")
	runGit(t, repo.Root, "add", "a.txt")
	runGit(t, repo.Root, "commit", "-qm", "second")
	first := strings.TrimSpace(runGit(t, repo.Root, "rev-parse", "HEAD~1"))

	d, err := repo.Diff(context.Background(), runner, protocol.DiffCompare, protocol.DiffOptions{
		Path:        "a.txt",
		CompareFrom: first,
		CompareTo:   "HEAD",
	})
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if d.Before.Content != "one\n" || d.After.Content != "one\ntwo\n" {
		t.Fatalf("compare contents = %q / %q", d.Before.Content, d.After.Content)
	}
}

func TestDiffRejectsEscapingPath(t *testing.T) {
	repo, runner := diffRepo(t)
	_, err := repo.Diff(context.Background(), runner, protocol.DiffUnstaged, protocol.DiffOptions{Path: "../outside.txt"})
	if !errors.Is(err, protocol.ErrInvalidPath) {
		t.Fatalf("err = %v, want ErrInvalidPath", err)
	}
}

func TestDiffRejectsAbsolutePath(t *testing.T) {
	repo, runner := diffRepo(t)
	_, err := repo.Diff(context.Background(), runner, protocol.DiffUnstaged, protocol.DiffOptions{Path: "/etc/passwd"})
	if !errors.Is(err, protocol.ErrInvalidPath) {
		t.Fatalf("err = %v, want ErrInvalidPath", err)
	}
}

func TestDiffRejectsBadRef(t *testing.T) {
	repo, runner := diffRepo(t)
	_, err := repo.Diff(context.Background(), runner, protocol.DiffCompare, protocol.DiffOptions{
		Path:        "a.txt",
		CompareFrom: "feature/x",
		CompareTo:   "HEAD;rm -rf /",
	})
	if !errors.Is(err, protocol.ErrInvalidRef) {
		t.Fatalf("err = %v, want ErrInvalidRef", err)
	}
}

func TestDiffRejectsUnknownScope(t *testing.T) {
	repo, runner := diffRepo(t)
	_, err := repo.Diff(context.Background(), runner, "bogus", protocol.DiffOptions{Path: "a.txt"})
	if err == nil {
		t.Fatal("unknown scope = nil error, want error")
	}
}

func TestDiffWorktreeSymlinkEscape(t *testing.T) {
	repo, runner := diffRepo(t)
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(repo.Root, "link.txt")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}

	_, err := repo.Diff(context.Background(), runner, protocol.DiffUnstaged, protocol.DiffOptions{Path: "link.txt"})
	if !errors.Is(err, protocol.ErrNotInRepo) {
		t.Fatalf("err = %v, want ErrNotInRepo", err)
	}
}

func TestDiffStagedPathWithSpaces(t *testing.T) {
	repo, runner := diffRepo(t)
	writeFile(t, filepath.Join(repo.Root, "sp ace.txt"), "one\n")
	runGit(t, repo.Root, "add", "sp ace.txt")

	d, err := repo.Diff(context.Background(), runner, protocol.DiffStaged, protocol.DiffOptions{Path: "sp ace.txt"})
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if d.After.Content != "one\n" {
		t.Fatalf("After = %q, want content", d.After.Content)
	}
}
