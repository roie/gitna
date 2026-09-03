package gitx

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func TestRebaseClean(t *testing.T) {
	root := initTestRepo(t)
	runner := &ExecRunner{}
	repo, _ := Discover(context.Background(), runner, root)

	writeFile(t, filepath.Join(root, "main.txt"), "main\n")
	runGit(t, root, "add", "main.txt")
	runGit(t, root, "commit", "-q", "-m", "main work")

	runGit(t, root, "checkout", "-q", "-b", "feature")
	writeFile(t, filepath.Join(root, "feature.txt"), "feature\n")
	runGit(t, root, "add", "feature.txt")
	runGit(t, root, "commit", "-q", "-m", "feature work")
	runGit(t, root, "checkout", "-q", "main")

	if err := repo.Rebase(context.Background(), runner, "feature"); err != nil {
		t.Fatalf("Rebase: %v", err)
	}
	if _, err := readFile(t, filepath.Join(root, "feature.txt")); err != nil {
		t.Fatalf("feature.txt missing after rebase: %v", err)
	}
}

func TestRebaseConflict(t *testing.T) {
	root := initTestRepo(t)
	runner := &ExecRunner{}
	repo, _ := Discover(context.Background(), runner, root)

	writeFile(t, filepath.Join(root, "a.txt"), "base\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-q", "-m", "base")

	runGit(t, root, "checkout", "-q", "-b", "main-edit")
	writeFile(t, filepath.Join(root, "a.txt"), "main version\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-q", "-m", "main edit")

	runGit(t, root, "checkout", "-q", "main")
	writeFile(t, filepath.Join(root, "a.txt"), "feature version\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-q", "-m", "feature edit")

	runGit(t, root, "checkout", "-q", "main-edit")

	err := repo.Rebase(context.Background(), runner, "main")
	if err == nil {
		t.Fatal("expected conflict error from rebase")
	}
	op := DetectOperation(repo)
	if op != "rebase" {
		t.Fatalf("operation = %q, want rebase (after conflict)", op)
	}
}

func TestRebaseAbort(t *testing.T) {
	root := initTestRepo(t)
	runner := &ExecRunner{}
	repo, _ := Discover(context.Background(), runner, root)

	writeFile(t, filepath.Join(root, "a.txt"), "base\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-q", "-m", "base")

	runGit(t, root, "checkout", "-q", "-b", "main-edit")
	writeFile(t, filepath.Join(root, "a.txt"), "main version\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-q", "-m", "main edit")

	runGit(t, root, "checkout", "-q", "main")
	writeFile(t, filepath.Join(root, "a.txt"), "feature version\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-q", "-m", "feature edit")

	runGit(t, root, "checkout", "-q", "main-edit")
	_ = repo.Rebase(context.Background(), runner, "main")

	if err := repo.RebaseAbort(context.Background(), runner); err != nil {
		t.Fatalf("RebaseAbort: %v", err)
	}
	op := DetectOperation(repo)
	if op != "none" {
		t.Fatalf("operation after abort = %q, want none", op)
	}
}

func TestRebaseContinueAfterResolveSuppressesFailingEditor(t *testing.T) {
	root := initTestRepo(t)
	runner := &ExecRunner{Env: []string{"GIT_EDITOR=false"}}
	repo, _ := Discover(context.Background(), runner, root)

	writeFile(t, filepath.Join(root, "a.txt"), "base\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-q", "-m", "base")

	runGit(t, root, "checkout", "-q", "-b", "main-edit")
	writeFile(t, filepath.Join(root, "a.txt"), "main version\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-q", "-m", "main edit")

	runGit(t, root, "checkout", "-q", "main")
	writeFile(t, filepath.Join(root, "a.txt"), "feature version\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-q", "-m", "feature edit")

	runGit(t, root, "checkout", "-q", "main-edit")
	_ = repo.Rebase(context.Background(), runner, "main")

	if err := repo.ResolveConflictSide(context.Background(), runner, "a.txt", false); err != nil {
		t.Fatalf("ResolveConflictSide: %v", err)
	}

	if err := repo.RebaseContinue(context.Background(), runner); err != nil {
		t.Fatalf("RebaseContinue: %v", err)
	}
	op := DetectOperation(repo)
	if op != "none" {
		t.Fatalf("operation after continue = %q, want none", op)
	}
}

func TestRebaseAlreadyInProgress(t *testing.T) {
	root := initTestRepo(t)
	runner := &ExecRunner{}
	repo, _ := Discover(context.Background(), runner, root)

	writeFile(t, filepath.Join(root, "a.txt"), "base\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-q", "-m", "base")

	runGit(t, root, "checkout", "-q", "-b", "main-edit")
	writeFile(t, filepath.Join(root, "a.txt"), "main version\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-q", "-m", "main edit")

	runGit(t, root, "checkout", "-q", "main")
	writeFile(t, filepath.Join(root, "a.txt"), "feature version\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-q", "-m", "feature edit")

	runGit(t, root, "checkout", "-q", "main-edit")
	_ = repo.Rebase(context.Background(), runner, "main")

	err := repo.Rebase(context.Background(), runner, "main")
	if !errors.Is(err, ErrAlreadyInProgress) {
		t.Fatalf("expected ErrAlreadyInProgress, got %v", err)
	}
}

func TestRebaseBadRef(t *testing.T) {
	root := initTestRepo(t)
	runner := &ExecRunner{}
	repo, _ := Discover(context.Background(), runner, root)

	err := repo.Rebase(context.Background(), runner, "bad..ref")
	if err == nil {
		t.Fatal("expected error for bad ref")
	}
}

func TestRebaseContinueNoOpInProgress(t *testing.T) {
	root := initTestRepo(t)
	runner := &ExecRunner{}
	repo, _ := Discover(context.Background(), runner, root)

	err := repo.RebaseContinue(context.Background(), runner)
	if err == nil {
		t.Fatal("expected error for rebase-continue with no rebase in progress")
	}
}
