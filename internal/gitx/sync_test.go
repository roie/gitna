package gitx

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

// cloneOrigin clones the bare origin into a fresh worktree with identity
// configured, ready to add its own commits.
func cloneOrigin(t *testing.T, bare string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "clone")
	runGit(t, t.TempDir(), "clone", "-q", bare, dir)
	runGit(t, dir, "config", "user.email", "test@example.com")
	runGit(t, dir, "config", "user.name", "Test")
	return dir
}

func TestFetchUpdatesRemoteRefs(t *testing.T) {
	root, bare := initRemoteRepo(t)
	runGit(t, root, "push", "-u", "origin", "main")
	before := runGit(t, root, "rev-parse", "origin/main")

	other := cloneOrigin(t, bare)
	writeFile(t, filepath.Join(other, "remote.txt"), "remote\n")
	runGit(t, other, "add", "remote.txt")
	runGit(t, other, "commit", "-qm", "remote work")
	runGit(t, other, "push", "-q", "origin", "main")

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	if err := repo.Fetch(context.Background(), &ExecRunner{}); err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	after := runGit(t, root, "rev-parse", "origin/main")
	if after == before {
		t.Fatal("origin/main did not advance after fetch")
	}
	if want := runGit(t, other, "rev-parse", "main"); strings.TrimSpace(after) != strings.TrimSpace(want) {
		t.Fatalf("origin/main = %s, want %s", after, want)
	}
}

func TestPullFastForward(t *testing.T) {
	root, bare := initRemoteRepo(t)
	runGit(t, root, "push", "-u", "origin", "main")

	other := cloneOrigin(t, bare)
	writeFile(t, filepath.Join(other, "remote.txt"), "remote\n")
	runGit(t, other, "add", "remote.txt")
	runGit(t, other, "commit", "-qm", "remote work")
	runGit(t, other, "push", "-q", "origin", "main")

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	if err := repo.Pull(context.Background(), &ExecRunner{}); err != nil {
		t.Fatalf("Pull: %v", err)
	}
	local := strings.TrimSpace(runGit(t, root, "rev-parse", "main"))
	remote := strings.TrimSpace(runGit(t, other, "rev-parse", "main"))
	if local != remote {
		t.Fatalf("local main = %s, want %s after pull", local, remote)
	}
}

func TestPullConflictLeavesMergeState(t *testing.T) {
	root, bare := initRemoteRepo(t)
	writeFile(t, filepath.Join(root, "a.txt"), "base\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "base")
	runGit(t, root, "push", "-u", "origin", "main")

	other := cloneOrigin(t, bare)
	writeFile(t, filepath.Join(other, "a.txt"), "other\n")
	runGit(t, other, "add", "a.txt")
	runGit(t, other, "commit", "-qm", "other side")
	runGit(t, other, "push", "-q", "origin", "main")

	writeFile(t, filepath.Join(root, "a.txt"), "local\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "local side")
	runGit(t, root, "config", "pull.rebase", "false")

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	if err := repo.Pull(context.Background(), &ExecRunner{}); err == nil {
		t.Fatal("Pull on divergent histories = nil error, want conflict")
	}
	if op := DetectOperation(repo); op != "merge" {
		t.Fatalf("DetectOperation = %q, want merge after conflicted pull", op)
	}
}

func TestPushSucceeds(t *testing.T) {
	root, bare := initRemoteRepo(t)
	runGit(t, root, "push", "-u", "origin", "main")
	writeFile(t, filepath.Join(root, "a.txt"), "work\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "local work")

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	if err := repo.Push(context.Background(), &ExecRunner{}); err != nil {
		t.Fatalf("Push: %v", err)
	}
	local := strings.TrimSpace(runGit(t, root, "rev-parse", "main"))
	if got := strings.TrimSpace(runGit(t, bare, "rev-parse", "main")); got != local {
		t.Fatalf("bare main = %s, want %s", got, local)
	}
}

func TestPushNoUpstream(t *testing.T) {
	root, _ := initRemoteRepo(t)
	runGit(t, root, "push", "-u", "origin", "main")
	runGit(t, root, "switch", "-c", "nostream")

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	if err := repo.Push(context.Background(), &ExecRunner{}); !errors.Is(err, ErrNoUpstream) {
		t.Fatalf("Push = %v, want ErrNoUpstream", err)
	}
}

func TestPushSetUpstreamThenPush(t *testing.T) {
	root, _ := initRemoteRepo(t)
	runGit(t, root, "push", "-u", "origin", "main")
	runGit(t, root, "switch", "-c", "topic")
	writeFile(t, filepath.Join(root, "t.txt"), "topic\n")
	runGit(t, root, "add", "t.txt")
	runGit(t, root, "commit", "-qm", "topic work")

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	if err := repo.PushSetUpstream(context.Background(), &ExecRunner{}, "origin", "topic"); err != nil {
		t.Fatalf("PushSetUpstream: %v", err)
	}
	if got := strings.TrimSpace(runGit(t, root, "rev-parse", "--symbolic-full-name", "@{u}")); got != "refs/remotes/origin/topic" {
		t.Fatalf("upstream = %q, want refs/remotes/origin/topic", got)
	}
	if err := repo.Push(context.Background(), &ExecRunner{}); err != nil {
		t.Fatalf("plain Push after set-upstream: %v", err)
	}
}

func TestPushRejectedNonFastForward(t *testing.T) {
	root, bare := initRemoteRepo(t)
	writeFile(t, filepath.Join(root, "a.txt"), "base\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "base")
	runGit(t, root, "push", "-u", "origin", "main")

	other := cloneOrigin(t, bare)
	writeFile(t, filepath.Join(other, "b.txt"), "other\n")
	runGit(t, other, "add", "b.txt")
	runGit(t, other, "commit", "-qm", "other side")
	runGit(t, other, "push", "-q", "origin", "main")

	writeFile(t, filepath.Join(root, "c.txt"), "local\n")
	runGit(t, root, "add", "c.txt")
	runGit(t, root, "commit", "-qm", "local side")

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	err := repo.Push(context.Background(), &ExecRunner{})
	if !errors.Is(err, ErrPushRejected) {
		t.Fatalf("Push error = %v, want ErrPushRejected", err)
	}
}

func TestPushSetUpstreamRejectsBadInput(t *testing.T) {
	root := initTestRepo(t)
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	if err := repo.PushSetUpstream(context.Background(), &ExecRunner{}, "has space", "main"); !errors.Is(err, protocol.ErrInvalidRef) {
		t.Fatalf("PushSetUpstream(bad remote) error = %v, want ErrInvalidRef", err)
	}
	if err := repo.PushSetUpstream(context.Background(), &ExecRunner{}, "origin", "a b"); !errors.Is(err, protocol.ErrInvalidRef) {
		t.Fatalf("PushSetUpstream(bad branch) error = %v, want ErrInvalidRef", err)
	}
}
