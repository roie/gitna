package gitx

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// commitDiscover returns a Repository bound to root and an ExecRunner.
func commitDiscover(t *testing.T, root string) (Repository, *ExecRunner) {
	t.Helper()
	runner := &ExecRunner{}
	repo, err := Discover(context.Background(), runner, root)
	if err != nil {
		t.Fatal(err)
	}
	return repo, runner
}

// installHook writes an executable git hook in the repository's hooks dir.
func installHook(t *testing.T, root, name, script string) {
	t.Helper()
	hook := filepath.Join(root, ".git", "hooks", name)
	if err := os.MkdirAll(filepath.Dir(hook), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hook, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(hook, 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestCommitCreatesCommitWithMessage(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "file.txt"), "base\n")
	runGit(t, root, "add", "file.txt")
	runGit(t, root, "commit", "-q", "-m", "base")

	writeFile(t, filepath.Join(root, "file.txt"), "changed\n")
	runGit(t, root, "add", "file.txt")
	repo, runner := commitDiscover(t, root)

	res, err := repo.Commit(context.Background(), runner, "subject", false)
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit code = %d, want 0", res.ExitCode)
	}
	if got := strings.TrimSpace(runGit(t, root, "log", "-1", "--format=%B")); got != "subject" {
		t.Fatalf("head message = %q, want %q", got, "subject")
	}
	if got := runGit(t, root, "status", "--porcelain"); got != "" {
		t.Fatalf("status after commit = %q, want clean", got)
	}
}

func TestCommitPreservesMultilineMessage(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "file.txt"), "base\n")
	runGit(t, root, "add", "file.txt")
	runGit(t, root, "commit", "-q", "-m", "base")

	writeFile(t, filepath.Join(root, "file.txt"), "changed\n")
	runGit(t, root, "add", "file.txt")
	repo, runner := commitDiscover(t, root)

	message := "subject\n\nfirst body line\nsecond body line"
	res, err := repo.Commit(context.Background(), runner, message, false)
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit code = %d, want 0", res.ExitCode)
	}
	if got := strings.TrimSpace(runGit(t, root, "log", "-1", "--format=%B")); got != message {
		t.Fatalf("head message = %q, want %q", got, message)
	}
}

func TestCommitFailsWhenNothingStaged(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "file.txt"), "base\n")
	runGit(t, root, "add", "file.txt")
	runGit(t, root, "commit", "-q", "-m", "base")

	// Unstaged worktree change only: commit must refuse and surface git's error.
	writeFile(t, filepath.Join(root, "file.txt"), "changed\n")
	repo, runner := commitDiscover(t, root)

	res, err := repo.Commit(context.Background(), runner, "subject", false)
	var commitErr *CommitError
	if !errors.As(err, &commitErr) {
		t.Fatalf("Commit error = %v, want *CommitError", err)
	}
	if res.ExitCode == 0 {
		t.Fatal("exit code = 0, want non-zero")
	}
	if !strings.Contains(commitErr.Stdout, "no changes added") && !strings.Contains(commitErr.Stderr, "nothing to commit") {
		t.Fatalf("output = stdout %q stderr %q, want a 'nothing to commit'-style message", commitErr.Stdout, commitErr.Stderr)
	}
}

func TestCommitPreCommitHookRejects(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "file.txt"), "base\n")
	runGit(t, root, "add", "file.txt")
	runGit(t, root, "commit", "-q", "-m", "base")

	writeFile(t, filepath.Join(root, "file.txt"), "changed\n")
	runGit(t, root, "add", "file.txt")
	installHook(t, root, "pre-commit", "#!/bin/sh\necho pre-commit blocked\n  exit 1\n")
	repo, runner := commitDiscover(t, root)

	res, err := repo.Commit(context.Background(), runner, "subject", false)
	var commitErr *CommitError
	if !errors.As(err, &commitErr) {
		t.Fatalf("Commit error = %v, want *CommitError", err)
	}
	if res.ExitCode == 0 {
		t.Fatal("exit code = 0, want non-zero")
	}
	if !strings.Contains(commitErr.Stderr, "pre-commit blocked") {
		t.Fatalf("stderr = %q, want hook output relayed", commitErr.Stderr)
	}
}

func TestCommitMsgHookRejects(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "file.txt"), "base\n")
	runGit(t, root, "add", "file.txt")
	runGit(t, root, "commit", "-q", "-m", "base")

	writeFile(t, filepath.Join(root, "file.txt"), "changed\n")
	runGit(t, root, "add", "file.txt")
	installHook(t, root, "commit-msg", "#!/bin/sh\necho commit-msg blocked\n  exit 1\n")
	repo, runner := commitDiscover(t, root)

	res, err := repo.Commit(context.Background(), runner, "subject", false)
	var commitErr *CommitError
	if !errors.As(err, &commitErr) {
		t.Fatalf("Commit error = %v, want *CommitError", err)
	}
	if res.ExitCode == 0 {
		t.Fatal("exit code = 0, want non-zero")
	}
	if !strings.Contains(commitErr.Stderr, "commit-msg blocked") {
		t.Fatalf("stderr = %q, want hook output relayed", commitErr.Stderr)
	}
}

func TestCommitAmendReplacesHeadMessage(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "file.txt"), "base\n")
	runGit(t, root, "add", "file.txt")
	runGit(t, root, "commit", "-q", "-m", "base")

	writeFile(t, filepath.Join(root, "file.txt"), "one\n")
	runGit(t, root, "add", "file.txt")
	repo, runner := commitDiscover(t, root)
	if _, err := repo.Commit(context.Background(), runner, "first subject", false); err != nil {
		t.Fatalf("first Commit: %v", err)
	}

	writeFile(t, filepath.Join(root, "file.txt"), "two\n")
	runGit(t, root, "add", "file.txt")
	res, err := repo.Commit(context.Background(), runner, "second subject", true)
	if err != nil {
		t.Fatalf("amend Commit: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exit code = %d, want 0", res.ExitCode)
	}
	if got := strings.TrimSpace(runGit(t, root, "log", "-1", "--format=%B")); got != "second subject" {
		t.Fatalf("head message = %q, want %q", got, "second subject")
	}
	if count := strings.TrimSpace(runGit(t, root, "rev-list", "--count", "HEAD")); count != "3" {
		t.Fatalf("commit count = %q, want 3 (amend must not add a commit)", count)
	}
}

func TestCommitRejectsOversizedMessage(t *testing.T) {
	root := initTestRepo(t)
	repo, runner := commitDiscover(t, root)
	_, err := repo.Commit(context.Background(), runner, strings.Repeat("x", maxCommitMessageBytes+1), false)
	if !errors.Is(err, ErrCommitMessageTooLarge) {
		t.Fatalf("Commit error = %v, want ErrCommitMessageTooLarge", err)
	}
}
