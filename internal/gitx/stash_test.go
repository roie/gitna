package gitx

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

func TestStashListParse(t *testing.T) {
	raw := []byte("stash@{0}\x000123456789abcdef0123456789abcdef01234567\x00On main: wip work\n" +
		"stash@{1}\x0011111111111111111111111111111111111111\x00WIP on feature: 2222222 subject\n" +
		"stash@{2}\x00abcdefabcdefabcdefabcdefabcdefabcdefabcd\x00weird\n")
	got, err := parseStashList(raw)
	if err != nil {
		t.Fatalf("parseStashList: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("len = %d, want 3", len(got))
	}
	if got[0].Ref != "stash@{0}" || got[0].OID != "0123456789abcdef0123456789abcdef01234567" {
		t.Fatalf("stash[0] = %+v", got[0])
	}
	if got[0].Branch != "main" || got[0].Message != "wip work" {
		t.Fatalf("stash[0] branch/message = %q/%q, want main/wip work", got[0].Branch, got[0].Message)
	}
	if got[1].Branch != "feature" || got[1].Message != "2222222 subject" {
		t.Fatalf("stash[1] branch/message = %q/%q", got[1].Branch, got[1].Message)
	}
	if got[2].Branch != "" || got[2].Message != "weird" {
		t.Fatalf("stash[2] = %+v", got[2])
	}
}

func TestStashPushListApplyPopDrop(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "a.txt"), "one\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "a")
	writeFile(t, filepath.Join(root, "b.txt"), "dirty\n")
	runGit(t, root, "add", "b.txt")

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	runner := &ExecRunner{}
	ctx := context.Background()

	if err := repo.StashPush(ctx, runner, "wip work", false); err != nil {
		t.Fatalf("StashPush: %v", err)
	}
	if out := runGit(t, root, "status", "--porcelain"); strings.TrimSpace(out) != "" {
		t.Fatalf("worktree not clean after stash: %q", out)
	}

	stashes, err := repo.ListStashes(ctx, runner)
	if err != nil {
		t.Fatalf("ListStashes: %v", err)
	}
	if len(stashes) != 1 {
		t.Fatalf("stashes = %d, want 1", len(stashes))
	}
	if stashes[0].Ref != "stash@{0}" {
		t.Fatalf("ref = %q, want stash@{0}", stashes[0].Ref)
	}
	if stashes[0].Branch != "main" || !strings.Contains(stashes[0].Message, "wip work") {
		t.Fatalf("stash[0] = %+v", stashes[0])
	}

	if err := repo.StashApply(ctx, runner, stashes[0].Ref); err != nil {
		t.Fatalf("StashApply: %v", err)
	}
	if out := runGit(t, root, "status", "--porcelain"); !strings.Contains(out, "b.txt") {
		t.Fatalf("stash not applied: %q", out)
	}
	if stashes, err := repo.ListStashes(ctx, runner); err != nil || len(stashes) != 1 {
		t.Fatalf("apply removed the stash (len=%d err=%v)", len(stashes), err)
	}

	runGit(t, root, "checkout", "-q", "--", ".")
	if err := repo.StashPop(ctx, runner, "stash@{0}"); err != nil {
		t.Fatalf("StashPop: %v", err)
	}
	if stashes, err := repo.ListStashes(ctx, runner); err != nil || len(stashes) != 0 {
		t.Fatalf("pop left %d stashes (err=%v), want 0", len(stashes), err)
	}

	writeFile(t, filepath.Join(root, "c.txt"), "again\n")
	if err := repo.StashPush(ctx, runner, "", false); err != nil {
		t.Fatalf("StashPush (no message): %v", err)
	}
	if err := repo.StashDrop(ctx, runner, "stash@{0}"); err != nil {
		t.Fatalf("StashDrop: %v", err)
	}
	if stashes, err := repo.ListStashes(ctx, runner); err != nil || len(stashes) != 0 {
		t.Fatalf("drop left %d stashes (err=%v), want 0", len(stashes), err)
	}
}

func TestStashPushIncludesUntrackedOnlyWhenRequested(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "a.txt"), "one\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "a")
	writeFile(t, filepath.Join(root, "new.txt"), "untracked\n")

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	runner := &ExecRunner{}
	ctx := context.Background()

	if err := repo.StashPush(ctx, runner, "", false); err != nil {
		t.Fatalf("StashPush without untracked: %v", err)
	}
	if out := runGit(t, root, "status", "--porcelain"); !strings.Contains(out, "new.txt") {
		t.Fatalf("untracked file was stashed without -u: %q", out)
	}

	if err := repo.StashPush(ctx, runner, "", true); err != nil {
		t.Fatalf("StashPush with untracked: %v", err)
	}
	if out := runGit(t, root, "status", "--porcelain"); strings.TrimSpace(out) != "" {
		t.Fatalf("untracked file not stashed with -u: %q", out)
	}
}

func TestStashApplyConflict(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "a.txt"), "base\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "a")

	writeFile(t, filepath.Join(root, "a.txt"), "stashed\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "stash", "push", "-qm", "keep me")
	writeFile(t, filepath.Join(root, "a.txt"), "other\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "other side")

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	runner := &ExecRunner{}
	if err := repo.StashApply(context.Background(), runner, "stash@{0}"); !errors.Is(err, ErrStashConflict) {
		t.Fatalf("StashApply = %v, want ErrStashConflict", err)
	}
	// The conflicting stash is preserved.
	stashes, err := repo.ListStashes(context.Background(), runner)
	if err != nil {
		t.Fatal(err)
	}
	if len(stashes) != 1 {
		t.Fatalf("stashes = %d, want 1 (entry kept on conflict)", len(stashes))
	}
}

func TestStashOpsRejectMissingStashAndBadRef(t *testing.T) {
	root := initTestRepo(t)
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	runner := &ExecRunner{}

	if err := repo.StashDrop(context.Background(), runner, "stash@{0}"); !errors.Is(err, ErrNoStash) {
		t.Fatalf("StashDrop(missing) = %v, want ErrNoStash", err)
	}
	if err := repo.StashApply(context.Background(), runner, ""); !errors.Is(err, protocol.ErrInvalidRef) {
		t.Fatalf("StashApply(empty ref) = %v, want ErrInvalidRef", err)
	}
}
