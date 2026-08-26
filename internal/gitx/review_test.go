package gitx

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

func TestReviewScopes(t *testing.T) {
	root := initTestRepo(t)
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	runner := &ExecRunner{}
	writeFile(t, filepath.Join(root, "a.txt"), "base\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "base")
	base := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD"))

	writeFile(t, filepath.Join(root, "a.txt"), "worktree\n")
	writeFile(t, filepath.Join(root, "new.txt"), "untracked\n")
	unstaged, err := repo.Review(context.Background(), runner, protocol.DiffUnstaged, protocol.DiffOptions{})
	if err != nil {
		t.Fatalf("Review unstaged: %v", err)
	}
	if !strings.Contains(unstaged.Patch, "diff --git a/a.txt b/a.txt") {
		t.Fatalf("unstaged patch missing tracked file:\n%s", unstaged.Patch)
	}
	if len(unstaged.Supplements) != 1 || unstaged.Supplements[0].Path != "new.txt" || unstaged.Supplements[0].Diff.After.Content != "untracked\n" {
		t.Fatalf("unstaged supplements = %+v", unstaged.Supplements)
	}

	runGit(t, root, "add", "a.txt")
	staged, err := repo.Review(context.Background(), runner, protocol.DiffStaged, protocol.DiffOptions{})
	if err != nil {
		t.Fatalf("Review staged: %v", err)
	}
	if !strings.Contains(staged.Patch, "+worktree") || len(staged.Supplements) != 0 {
		t.Fatalf("staged review = %+v", staged)
	}

	runGit(t, root, "commit", "-qm", "second")
	second := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD"))
	commit, err := repo.Review(context.Background(), runner, protocol.DiffCommit, protocol.DiffOptions{Commit: second})
	if err != nil {
		t.Fatalf("Review commit: %v", err)
	}
	if commit.Identity.Commit != second || !strings.Contains(commit.Patch, "+worktree") {
		t.Fatalf("commit review = %+v", commit)
	}

	compare, err := repo.Review(context.Background(), runner, protocol.DiffCompare, protocol.DiffOptions{CompareFrom: base, CompareTo: second})
	if err != nil {
		t.Fatalf("Review compare: %v", err)
	}
	if compare.Identity.CompareFrom != base || compare.Identity.CompareTo != second || !strings.Contains(compare.Patch, "+worktree") {
		t.Fatalf("compare review = %+v", compare)
	}
}

func TestReviewUntrackedBinaryAndTooLarge(t *testing.T) {
	root := initTestRepo(t)
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	runner := &ExecRunner{}
	writeFile(t, filepath.Join(root, "binary.dat"), "a\x00b")
	writeFile(t, filepath.Join(root, "image.png"), "\x89PNG\r\n\x1a\nimage")
	writeFile(t, filepath.Join(root, "large.txt"), strings.Repeat("x", DefaultDiffBytes+1))

	review, err := repo.Review(context.Background(), runner, protocol.DiffUnstaged, protocol.DiffOptions{})
	if err != nil {
		t.Fatalf("Review: %v", err)
	}
	byPath := make(map[string]protocol.ReviewSupplement)
	for _, supplement := range review.Supplements {
		byPath[supplement.Path] = supplement
	}
	if !byPath["binary.dat"].Diff.Binary || byPath["binary.dat"].Diff.After.Content != "" {
		t.Fatalf("binary supplement = %+v", byPath["binary.dat"])
	}
	image := byPath["image.png"].Diff
	if !image.Binary || image.After.Image == nil || image.After.Image.MIME != "image/png" {
		t.Fatalf("image supplement = %+v", byPath["image.png"])
	}
	if !byPath["large.txt"].Diff.TooLarge || byPath["large.txt"].Diff.After.Content != "" {
		t.Fatalf("large supplement = %+v", byPath["large.txt"])
	}
}

func TestReviewRejectsOversizedTrackedPatch(t *testing.T) {
	runner := &reviewResultRunner{result: Result{Stdout: bytes.Repeat([]byte("x"), maxReviewPatchBytes+1)}}
	_, err := (Repository{Root: t.TempDir()}).Review(context.Background(), runner, protocol.DiffStaged, protocol.DiffOptions{})
	if !errors.Is(err, protocol.ErrReviewTooLarge) {
		t.Fatalf("Review error = %v, want ErrReviewTooLarge", err)
	}
}

func TestReviewHonorsCancellation(t *testing.T) {
	root := initTestRepo(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := (Repository{Root: root}).Review(ctx, &ExecRunner{}, protocol.DiffStaged, protocol.DiffOptions{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Review error = %v, want context.Canceled", err)
	}
}

type reviewResultRunner struct {
	result Result
}

func (r *reviewResultRunner) Run(context.Context, string, ...string) (Result, error) {
	return r.result, nil
}

func (r *reviewResultRunner) RunInput(context.Context, string, []byte, ...string) (Result, error) {
	return r.result, nil
}
