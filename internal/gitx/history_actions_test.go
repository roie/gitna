package gitx

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

func TestCherryPickAppliesCommit(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "a.txt"), "one\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "a")
	runGit(t, root, "switch", "-q", "-c", "side")
	writeFile(t, filepath.Join(root, "b.txt"), "side\n")
	runGit(t, root, "add", "b.txt")
	runGit(t, root, "commit", "-qm", "side work")
	sideOID := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD"))
	runGit(t, root, "switch", "-q", "main")

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	if err := repo.CherryPick(context.Background(), &ExecRunner{}, sideOID); err != nil {
		t.Fatalf("CherryPick: %v", err)
	}
	if DetectOperation(repo) != "none" {
		t.Fatalf("operation after clean cherry-pick = %q, want none", DetectOperation(repo))
	}
	runGit(t, root, "cat-file", "-e", "HEAD:b.txt")
}

func TestCherryPickConflict(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "a.txt"), "base\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "base")
	runGit(t, root, "switch", "-q", "-c", "side")
	writeFile(t, filepath.Join(root, "a.txt"), "side\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "side change")
	sideOID := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD"))
	runGit(t, root, "switch", "-q", "main")
	writeFile(t, filepath.Join(root, "a.txt"), "other\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "other change")

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	if err := repo.CherryPick(context.Background(), &ExecRunner{}, sideOID); !errors.Is(err, ErrConflict) {
		t.Fatalf("CherryPick = %v, want ErrConflict", err)
	}
	if DetectOperation(repo) != "cherry-pick" {
		t.Fatalf("operation = %q, want cherry-pick", DetectOperation(repo))
	}
}

func TestRevertAppliesInverse(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "a.txt"), "one\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "a")
	writeFile(t, filepath.Join(root, "a.txt"), "two\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "b")
	target := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD"))

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	if err := repo.Revert(context.Background(), &ExecRunner{}, target); err != nil {
		t.Fatalf("Revert: %v", err)
	}
	if DetectOperation(repo) != "none" {
		t.Fatalf("operation after clean revert = %q, want none", DetectOperation(repo))
	}
	if got := strings.TrimSpace(runGit(t, root, "show", "HEAD:a.txt")); got != "one" {
		t.Fatalf("reverted a.txt = %q, want one", got)
	}
}

func TestRevertConflict(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "a.txt"), "base\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "base")
	runGit(t, root, "switch", "-q", "-c", "side")
	writeFile(t, filepath.Join(root, "a.txt"), "side\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "side change")
	sideOID := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD"))
	runGit(t, root, "switch", "-q", "main")
	writeFile(t, filepath.Join(root, "a.txt"), "other\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "other change")

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	if err := repo.Revert(context.Background(), &ExecRunner{}, sideOID); !errors.Is(err, ErrConflict) {
		t.Fatalf("Revert = %v, want ErrConflict", err)
	}
	if DetectOperation(repo) != "revert" {
		t.Fatalf("operation = %q, want revert", DetectOperation(repo))
	}
}

func TestResetMovesBranchAndState(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "a.txt"), "one\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "a")
	writeFile(t, filepath.Join(root, "a.txt"), "two\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "b")
	target := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD~1"))

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	runner := &ExecRunner{}
	ctx := context.Background()

	if err := repo.Reset(ctx, runner, target, "soft"); err != nil {
		t.Fatalf("Reset soft: %v", err)
	}
	if out := runGit(t, root, "status", "--porcelain"); !strings.Contains(out, "M  a.txt") {
		t.Fatalf("soft reset should stage a.txt, got %q", out)
	}

	if err := repo.Reset(ctx, runner, target, "mixed"); err != nil {
		t.Fatalf("Reset mixed: %v", err)
	}
	if out := runGit(t, root, "status", "--porcelain"); !strings.Contains(out, " M a.txt") {
		t.Fatalf("mixed reset should unstage a.txt, got %q", out)
	}

	if err := repo.Reset(ctx, runner, target, "hard"); err != nil {
		t.Fatalf("Reset hard: %v", err)
	}
	if out := runGit(t, root, "status", "--porcelain"); strings.TrimSpace(out) != "" {
		t.Fatalf("hard reset should clean the worktree, got %q", out)
	}
	if got := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD")); got != target {
		t.Fatalf("HEAD = %s, want %s after reset", got, target)
	}
}

func TestHistoryActionsValidateInput(t *testing.T) {
	root := initTestRepo(t)
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	runner := &ExecRunner{}

	if err := repo.CherryPick(context.Background(), runner, "bad..ref"); !errors.Is(err, protocol.ErrInvalidRef) {
		t.Fatalf("CherryPick(bad) = %v, want ErrInvalidRef", err)
	}
	if err := repo.Reset(context.Background(), runner, "HEAD", "nuke"); !errors.Is(err, ErrInvalidResetMode) {
		t.Fatalf("Reset(bad mode) = %v, want ErrInvalidResetMode", err)
	}
	if err := repo.Reset(context.Background(), runner, "HEAD..x", "hard"); !errors.Is(err, protocol.ErrInvalidRef) {
		t.Fatalf("Reset(bad target) = %v, want ErrInvalidRef", err)
	}
}
