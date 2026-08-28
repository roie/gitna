package gitx

import (
	"context"
	"errors"
	"fmt"
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
	unstaged := collectReview(t, repo, runner, protocol.DiffUnstaged, protocol.DiffOptions{})
	if len(unstaged) != 2 || unstaged[0].Path != "a.txt" || unstaged[1].Path != "new.txt" {
		t.Fatalf("unstaged review = %+v", unstaged)
	}
	if unstaged[0].Diff.Before.Content != "base\n" || unstaged[0].Diff.After.Content != "worktree\n" {
		t.Fatalf("unstaged tracked diff = %+v", unstaged[0].Diff)
	}
	if unstaged[1].Kind != protocol.KindUntracked || unstaged[1].Diff.After.Content != "untracked\n" {
		t.Fatalf("unstaged untracked diff = %+v", unstaged[1])
	}

	runGit(t, root, "add", "a.txt")
	staged := collectReview(t, repo, runner, protocol.DiffStaged, protocol.DiffOptions{})
	if len(staged) != 1 || staged[0].Path != "a.txt" || staged[0].Diff.After.Content != "worktree\n" {
		t.Fatalf("staged review = %+v", staged)
	}

	runGit(t, root, "commit", "-qm", "second")
	second := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD"))
	commit := collectReview(t, repo, runner, protocol.DiffCommit, protocol.DiffOptions{Commit: second})
	if len(commit) != 1 || commit[0].Path != "a.txt" || commit[0].Diff.After.Content != "worktree\n" {
		t.Fatalf("commit review = %+v", commit)
	}
	compare := collectReview(t, repo, runner, protocol.DiffCompare, protocol.DiffOptions{CompareFrom: base, CompareTo: second})
	if len(compare) != 1 || compare[0].Path != "a.txt" || compare[0].Diff.After.Content != "worktree\n" {
		t.Fatalf("compare review = %+v", compare)
	}
}

func TestReviewPaginatesEveryUntrackedFile(t *testing.T) {
	root := initTestRepo(t)
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	for index := range maxReviewPageFiles + 7 {
		writeFile(t, filepath.Join(root, fmt.Sprintf("file-%04d.txt", index)), "content\n")
	}

	seen := make(map[string]bool)
	after := ""
	pages := 0
	for {
		page, err := repo.Review(context.Background(), &ExecRunner{}, protocol.DiffUnstaged, protocol.DiffOptions{}, after)
		if err != nil {
			t.Fatalf("Review: %v", err)
		}
		pages++
		for _, file := range page.Response.Supplements {
			if seen[file.Path] {
				t.Fatalf("duplicate path %q", file.Path)
			}
			seen[file.Path] = true
		}
		if page.NextAfter == "" {
			break
		}
		after = page.NextAfter
	}
	if pages != 2 || len(seen) != maxReviewPageFiles+7 {
		t.Fatalf("pages=%d files=%d, want 2 and %d", pages, len(seen), maxReviewPageFiles+7)
	}
}

func TestReviewUntrackedBinaryImageAndTooLarge(t *testing.T) {
	root := initTestRepo(t)
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	writeFile(t, filepath.Join(root, "binary.dat"), "a\x00b")
	writeFile(t, filepath.Join(root, "image.png"), "\x89PNG\r\n\x1a\nimage")
	writeFile(t, filepath.Join(root, "large.txt"), strings.Repeat("x", DefaultDiffBytes+1))

	files := collectReview(t, repo, &ExecRunner{}, protocol.DiffUnstaged, protocol.DiffOptions{})
	byPath := make(map[string]protocol.ReviewSupplement)
	for _, file := range files {
		byPath[file.Path] = file
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

func TestReviewLargeTrackedFileIsPlaceholder(t *testing.T) {
	root := initTestRepo(t)
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	writeFile(t, filepath.Join(root, "large.txt"), "base\n")
	runGit(t, root, "add", "large.txt")
	runGit(t, root, "commit", "-qm", "base")
	writeFile(t, filepath.Join(root, "large.txt"), strings.Repeat("x", DefaultDiffBytes+1))

	files := collectReview(t, repo, &ExecRunner{}, protocol.DiffUnstaged, protocol.DiffOptions{})
	if len(files) != 1 || !files[0].Diff.TooLarge || files[0].Diff.After.Content != "" {
		t.Fatalf("large tracked review = %+v", files)
	}
}

func TestReviewPageByteBudgetContinuesWithoutDroppingImages(t *testing.T) {
	root := initTestRepo(t)
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	image := "\x89PNG\r\n\x1a\n" + strings.Repeat("x", MaxImageBytes-8)
	writeFile(t, filepath.Join(root, "a.png"), image)
	writeFile(t, filepath.Join(root, "b.png"), image)

	first, err := repo.Review(context.Background(), &ExecRunner{}, protocol.DiffUnstaged, protocol.DiffOptions{}, "")
	if err != nil {
		t.Fatalf("first Review: %v", err)
	}
	if len(first.Response.Supplements) != 1 || first.NextAfter == "" {
		t.Fatalf("first page files=%d next=%q", len(first.Response.Supplements), first.NextAfter)
	}
	second, err := repo.Review(context.Background(), &ExecRunner{}, protocol.DiffUnstaged, protocol.DiffOptions{}, first.NextAfter)
	if err != nil {
		t.Fatalf("second Review: %v", err)
	}
	if len(second.Response.Supplements) != 1 || second.NextAfter != "" {
		t.Fatalf("second page files=%d next=%q", len(second.Response.Supplements), second.NextAfter)
	}
	if first.Response.Supplements[0].Path == second.Response.Supplements[0].Path {
		t.Fatalf("duplicate image path %q", first.Response.Supplements[0].Path)
	}
}

func TestReviewHonorsCancellation(t *testing.T) {
	root := initTestRepo(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := (Repository{Root: root}).Review(ctx, &ExecRunner{}, protocol.DiffStaged, protocol.DiffOptions{}, "")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Review error = %v, want context.Canceled", err)
	}
}

func TestNextReviewChangesKeepsBoundedOrderedKeyset(t *testing.T) {
	changes := []reviewChange{{Path: "z.txt"}, {Path: "a.txt"}, {Path: "m.txt"}, {Path: "b.txt"}}
	selected, hasMore, err := nextReviewChanges(context.Background(), changes, "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if !hasMore || len(selected) != 2 || selected[0].Path != "a.txt" || selected[1].Path != "b.txt" {
		t.Fatalf("selected=%+v hasMore=%t", selected, hasMore)
	}

	selected, hasMore, err = nextReviewChanges(context.Background(), changes, reviewChangeKey(selected[0]), 3)
	if err != nil {
		t.Fatal(err)
	}
	if hasMore || len(selected) != 3 || selected[0].Path != "b.txt" || selected[2].Path != "z.txt" {
		t.Fatalf("continued=%+v hasMore=%t", selected, hasMore)
	}
}

func collectReview(t *testing.T, repo Repository, runner Runner, scope protocol.DiffScope, opts protocol.DiffOptions) []protocol.ReviewSupplement {
	t.Helper()
	var files []protocol.ReviewSupplement
	after := ""
	for {
		page, err := repo.Review(context.Background(), runner, scope, opts, after)
		if err != nil {
			t.Fatalf("Review: %v", err)
		}
		files = append(files, page.Response.Supplements...)
		if page.NextAfter == "" {
			return files
		}
		after = page.NextAfter
	}
}
