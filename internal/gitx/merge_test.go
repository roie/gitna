package gitx

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

// mergeFixture creates a divergent scenario: main and feature both modify a.txt
// from a common base, guaranteeing a conflict on merge.
func mergeFixture(t *testing.T) (root string, repo Repository, runner *ExecRunner) {
	t.Helper()
	root = initTestRepo(t)
	runner = &ExecRunner{}
	repo, _ = Discover(context.Background(), runner, root)

	writeFile(t, filepath.Join(root, "a.txt"), "base\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-q", "-m", "base")

	runGit(t, root, "checkout", "-q", "-b", "feature")
	writeFile(t, filepath.Join(root, "a.txt"), "feature version\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-q", "-m", "feature change")
	runGit(t, root, "checkout", "-q", "main")

	writeFile(t, filepath.Join(root, "a.txt"), "main version\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-q", "-m", "main change")
	return
}

func TestMergeClean(t *testing.T) {
	root := initTestRepo(t)
	runner := &ExecRunner{}
	repo, _ := Discover(context.Background(), runner, root)

	runGit(t, root, "checkout", "-q", "-b", "feature")
	writeFile(t, filepath.Join(root, "feature.txt"), "feature\n")
	runGit(t, root, "add", "feature.txt")
	runGit(t, root, "commit", "-q", "-m", "feature work")
	runGit(t, root, "checkout", "-q", "main")

	if err := repo.Merge(context.Background(), runner, "feature"); err != nil {
		t.Fatalf("Merge: %v", err)
	}
	if _, err := readFile(t, filepath.Join(root, "feature.txt")); err != nil {
		t.Fatalf("feature.txt missing after merge: %v", err)
	}
}

func TestMergeConflict(t *testing.T) {
	_, repo, runner := mergeFixture(t)

	if err := repo.Merge(context.Background(), runner, "feature"); err != nil {
		t.Fatalf("Merge (conflict) = %v, want nil (merge started)", err)
	}
	op := DetectOperation(repo)
	if op != "merge" {
		t.Fatalf("operation = %q, want merge", op)
	}
}

func TestMergeAbort(t *testing.T) {
	root, repo, runner := mergeFixture(t)

	runGitErr(t, root, "merge", "--no-edit", "feature")

	if err := repo.MergeAbort(context.Background(), runner); err != nil {
		t.Fatalf("MergeAbort: %v", err)
	}
	op := DetectOperation(repo)
	if op != "none" {
		t.Fatalf("operation after abort = %q, want none", op)
	}
}

func TestMergeContinueAfterResolve(t *testing.T) {
	root, repo, runner := mergeFixture(t)

	runGitErr(t, root, "merge", "--no-edit", "feature")

	if err := repo.ResolveConflictSide(context.Background(), runner, "a.txt", false); err != nil {
		t.Fatalf("ResolveConflictSide: %v", err)
	}

	if err := repo.MergeContinue(context.Background(), runner); err != nil {
		t.Fatalf("MergeContinue: %v", err)
	}
	op := DetectOperation(repo)
	if op != "none" {
		t.Fatalf("operation after continue = %q, want none", op)
	}
}

func TestMergeAlreadyInProgress(t *testing.T) {
	root, repo, runner := mergeFixture(t)

	runGitErr(t, root, "merge", "--no-edit", "feature")

	err := repo.Merge(context.Background(), runner, "feature")
	if !errors.Is(err, ErrAlreadyInProgress) {
		t.Fatalf("expected ErrAlreadyInProgress, got %v", err)
	}
}

func TestMergeBadRef(t *testing.T) {
	root := initTestRepo(t)
	runner := &ExecRunner{}
	repo, _ := Discover(context.Background(), runner, root)

	err := repo.Merge(context.Background(), runner, "bad..ref")
	if err == nil {
		t.Fatal("expected error for bad ref")
	}
}

func TestMergeContinueNoOpInProgress(t *testing.T) {
	root := initTestRepo(t)
	runner := &ExecRunner{}
	repo, _ := Discover(context.Background(), runner, root)

	err := repo.MergeContinue(context.Background(), runner)
	if err == nil {
		t.Fatal("expected error for merge-continue with no merge in progress")
	}
}
