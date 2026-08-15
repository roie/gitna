package gitx

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func mustStatus(t *testing.T, root string) protocol.RepoSnapshot {
	t.Helper()
	repo, err := Discover(context.Background(), &ExecRunner{}, root)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	snap, err := repo.Status(context.Background(), &ExecRunner{})
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	return snap
}

func findChange(t *testing.T, changes []protocol.FileChange, path string) protocol.FileChange {
	t.Helper()
	for _, c := range changes {
		if c.Path == path {
			return c
		}
	}
	t.Fatalf("no change for path %q in %+v", path, changes)
	return protocol.FileChange{}
}

func TestStatusModifiedUntrackedDeleted(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "tracked.txt"), "base\n")
	runGit(t, root, "add", "tracked.txt")
	runGit(t, root, "commit", "-q", "-m", "add tracked")

	writeFile(t, filepath.Join(root, "tracked.txt"), "changed\n")
	writeFile(t, filepath.Join(root, "new file.txt"), "untracked\n")
	if err := os.Remove(filepath.Join(root, "tracked.txt")); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(root, "tracked.txt"), "changed\n")

	snap := mustStatus(t, root)
	mod := findChange(t, snap.Unstaged, "tracked.txt")
	if mod.Kind != protocol.KindModified || mod.Scope != protocol.ScopeUnstaged || mod.Staged {
		t.Fatalf("tracked change = %+v, want unstaged modified", mod)
	}
	un := findChange(t, snap.Unstaged, "new file.txt")
	if un.Kind != protocol.KindUntracked {
		t.Fatalf("untracked change = %+v, want untracked", un)
	}
}

func TestStatusStagedAddedAndStagedPlusUnstaged(t *testing.T) {
	root := initTestRepo(t)

	writeFile(t, filepath.Join(root, "staged-only.txt"), "staged\n")
	writeFile(t, filepath.Join(root, "both.txt"), "stage this\n")
	runGit(t, root, "add", "staged-only.txt", "both.txt")
	writeFile(t, filepath.Join(root, "both.txt"), "stage this\nand more\n")

	snap := mustStatus(t, root)

	added := findChange(t, snap.Staged, "staged-only.txt")
	if added.Kind != protocol.KindAdded || added.Scope != protocol.ScopeStaged || !added.Staged {
		t.Fatalf("staged-only change = %+v, want staged added", added)
	}

	stagedBoth := findChange(t, snap.Staged, "both.txt")
	if stagedBoth.Kind != protocol.KindAdded {
		t.Fatalf("both staged change = %+v, want added", stagedBoth)
	}
	unstagedBoth := findChange(t, snap.Unstaged, "both.txt")
	if unstagedBoth.Kind != protocol.KindModified || unstagedBoth.Scope != protocol.ScopeUnstaged {
		t.Fatalf("both unstaged change = %+v, want unstaged modified", unstagedBoth)
	}
}

func TestStatusRenamed(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "oldname.txt"), "l1\nl2\nl3\nl4\nl5\n")
	runGit(t, root, "add", "oldname.txt")
	runGit(t, root, "commit", "-q", "-m", "add oldname")

	runGit(t, root, "mv", "oldname.txt", "new name.txt")

	snap := mustStatus(t, root)

	renamed := findChange(t, snap.Staged, "new name.txt")
	if renamed.Kind != protocol.KindRenamed {
		t.Fatalf("rename change = %+v, want renamed", renamed)
	}
	if renamed.OldPath != "oldname.txt" {
		t.Fatalf("rename oldPath = %q, want %q", renamed.OldPath, "oldname.txt")
	}
}

func TestStatusPathsWithSpacesAndUnicode(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "d i r", "ünïcode file.txt"), "x\n")

	snap := mustStatus(t, root)
	_ = findChange(t, snap.Unstaged, "d i r/ünïcode file.txt")
}

func TestStatusConflict(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "conflict.txt"), "base\n")
	runGit(t, root, "add", "conflict.txt")
	runGit(t, root, "commit", "-q", "-m", "base")

	runGit(t, root, "checkout", "-q", "-b", "other")
	writeFile(t, filepath.Join(root, "conflict.txt"), "other\n")
	runGit(t, root, "commit", "-q", "-am", "other side")

	runGit(t, root, "checkout", "-q", "main")
	writeFile(t, filepath.Join(root, "conflict.txt"), "main\n")
	runGit(t, root, "commit", "-q", "-am", "main side")

	runGitErr(t, root, "merge", "other")

	snap := mustStatus(t, root)
	if snap.Operation != protocol.OperationMerge {
		t.Fatalf("operation = %q, want %q", snap.Operation, protocol.OperationMerge)
	}
	conf := findChange(t, snap.Unstaged, "conflict.txt")
	if !conf.Conflicted {
		t.Fatalf("conflict change = %+v, want conflicted", conf)
	}
	if conf.Kind != protocol.KindConflicted {
		t.Fatalf("conflict kind = %q, want %q", conf.Kind, protocol.KindConflicted)
	}
}

func TestStatusAheadBehind(t *testing.T) {
	root := initTestRepo(t)
	runGit(t, root, "branch", "-M", "main")

	bare := filepath.Join(t.TempDir(), "origin.git")
	runGit(t, root, "clone", "-q", "--bare", root, bare)
	runGit(t, root, "remote", "add", "origin", bare)

	writeFile(t, filepath.Join(root, "a.txt"), "a\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-q", "-m", "c1")
	runGit(t, root, "push", "-q", "-u", "origin", "main")

	snap := mustStatus(t, root)
	if snap.Upstream != "origin/main" {
		t.Fatalf("upstream = %q, want origin/main", snap.Upstream)
	}
	if snap.Ahead != 0 || snap.Behind != 0 {
		t.Fatalf("after push: ahead=%d behind=%d, want 0/0", snap.Ahead, snap.Behind)
	}

	// Make origin advance independently to create a behind state.
	other := filepath.Join(t.TempDir(), "other")
	runGit(t, root, "clone", "-q", bare, other)
	runGit(t, other, "config", "user.email", "t@e.c")
	runGit(t, other, "config", "user.name", "T")
	writeFile(t, filepath.Join(other, "b.txt"), "b\n")
	runGit(t, other, "add", "b.txt")
	runGit(t, other, "commit", "-q", "-m", "c2")
	runGit(t, other, "push", "-q", "origin", "main")

	// Local commit in root to be both ahead and behind.
	writeFile(t, filepath.Join(root, "c.txt"), "c\n")
	runGit(t, root, "add", "c.txt")
	runGit(t, root, "commit", "-q", "-m", "c3")
	runGit(t, root, "fetch", "-q", "origin")

	snap = mustStatus(t, root)
	if snap.Ahead != 1 || snap.Behind != 1 {
		t.Fatalf("after divergence: ahead=%d behind=%d, want 1/1", snap.Ahead, snap.Behind)
	}
}

func TestStatusInitialRepo(t *testing.T) {
	root := t.TempDir()
	runGit(t, root, "init", "-q", root)
	runGit(t, root, "config", "user.email", "t@e.c")
	runGit(t, root, "config", "user.name", "T")

	snap := mustStatus(t, root)
	if snap.HeadOID != "" {
		t.Fatalf("head oid = %q, want empty for initial repo", snap.HeadOID)
	}
	writeFile(t, filepath.Join(root, "first.txt"), "x\n")
	snap = mustStatus(t, root)
	_ = findChange(t, snap.Unstaged, "first.txt")
}

func TestStatusDetachedHead(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "f.txt"), "x\n")
	runGit(t, root, "add", "f.txt")
	runGit(t, root, "commit", "-q", "-m", "c1")
	oid := runGit(t, root, "rev-parse", "HEAD")
	runGit(t, root, "checkout", "-q", oid[:len(oid)-1])

	snap := mustStatus(t, root)
	if snap.HeadBranch != "" {
		t.Fatalf("head branch = %q, want empty when detached", snap.HeadBranch)
	}
	if snap.HeadOID == "" {
		t.Fatal("head oid empty in detached state")
	}
}
