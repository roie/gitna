package integration_test

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/protocol"
	"github.com/roie/gitna/internal/server"
)

// newRemoteHarness adds a bare origin to a fresh harness, pushes main, and
// returns the bare repository path.
func newRemoteHarness(t *testing.T) (*harness, string) {
	t.Helper()
	h := newHarness(t)
	bare := filepath.Join(t.TempDir(), "origin.git")
	git(t, filepath.Dir(bare), "init", "-q", "--bare", filepath.Base(bare))
	// A fresh bare repo's HEAD points at an unborn branch; point it at main so
	// clones check out the branch we push.
	git(t, bare, "symbolic-ref", "HEAD", "refs/heads/main")
	git(t, h.root, "remote", "add", "origin", bare)
	git(t, h.root, "push", "-q", "-u", "origin", "main")
	return h, bare
}

// cloneForSideWork clones the bare origin into a second worktree with identity
// configured, ready to add its own commits.
func cloneForSideWork(t *testing.T, bare string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "side")
	git(t, t.TempDir(), "clone", "-q", bare, dir)
	git(t, dir, "config", "user.email", "test@example.com")
	git(t, dir, "config", "user.name", "Test")
	return dir
}

func writeSideFile(t *testing.T, dir, rel, content string) {
	t.Helper()
	full := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func branchesFrom(t *testing.T, h *harness) []protocol.Branch {
	t.Helper()
	rec := h.get("/api/v1/branches")
	if rec.Code != http.StatusOK {
		t.Fatalf("branches status = %d (%s)", rec.Code, rec.Body)
	}
	var branches []protocol.Branch
	if err := json.Unmarshal(rec.Body.Bytes(), &branches); err != nil {
		t.Fatalf("unmarshal branches: %v", err)
	}
	return branches
}

func findBranch(branches []protocol.Branch, name string) *protocol.Branch {
	for i := range branches {
		if branches[i].Name == name {
			return &branches[i]
		}
	}
	return nil
}

// commitAll stages and commits every change in the harness repository.
func commitAll(t *testing.T, h *harness, message string) {
	t.Helper()
	git(t, h.root, "add", "-A")
	git(t, h.root, "commit", "-q", "-m", message)
}

func TestBranchesEndpointListsLocalAndRemote(t *testing.T) {
	h, _ := newRemoteHarness(t)
	git(t, h.root, "switch", "-q", "-c", "feature")
	git(t, h.root, "switch", "-q", "main")

	branches := branchesFrom(t, h)
	if len(branches) != 3 {
		t.Fatalf("branches = %+v, want feature, main, and origin/main", branches)
	}
	main := findBranch(branches, "main")
	if main == nil || !main.Current || main.Upstream != "origin/main" {
		t.Fatalf("main branch = %+v, want current with upstream origin/main", main)
	}
	if feat := findBranch(branches, "feature"); feat == nil || feat.Remote || feat.Current || feat.Upstream != "" {
		t.Fatalf("feature = %+v, want a local non-current branch without upstream", feat)
	}
	if rem := findBranch(branches, "origin/main"); rem == nil || !rem.Remote {
		t.Fatalf("origin/main = %+v, want a remote branch", rem)
	}
}

func TestBranchesAheadBehind(t *testing.T) {
	h, bare := newRemoteHarness(t)
	h.writeFile("a.txt", "one\n")
	commitAll(t, h, "local work")
	if rec := h.post(server.OpPush, map[string]any{}); rec.Code != http.StatusOK {
		t.Fatalf("push status = %d (%s)", rec.Code, rec.Body)
	}

	h.writeFile("a.txt", "one\ntwo\n")
	commitAll(t, h, "second local")

	side := cloneForSideWork(t, bare)
	writeSideFile(t, side, "b.txt", "remote\n")
	git(t, side, "add", "b.txt")
	git(t, side, "commit", "-q", "-m", "remote work")
	git(t, side, "push", "-q", "origin", "main")

	if rec := h.post(server.OpFetch, map[string]any{}); rec.Code != http.StatusOK {
		t.Fatalf("fetch status = %d (%s)", rec.Code, rec.Body)
	}

	main := findBranch(branchesFrom(t, h), "main")
	if main == nil {
		t.Fatal("main branch missing")
	}
	if main.Ahead != 1 || main.Behind != 1 {
		t.Fatalf("main ahead=%d behind=%d, want 1/1", main.Ahead, main.Behind)
	}
}

func TestPullFastForward(t *testing.T) {
	h, bare := newRemoteHarness(t)
	side := cloneForSideWork(t, bare)
	writeSideFile(t, side, "remote.txt", "remote\n")
	git(t, side, "add", "remote.txt")
	git(t, side, "commit", "-q", "-m", "remote work")
	git(t, side, "push", "-q", "origin", "main")

	if rec := h.post(server.OpPull, map[string]any{}); rec.Code != http.StatusOK {
		t.Fatalf("pull status = %d (%s)", rec.Code, rec.Body)
	}
	local := strings.TrimSpace(git(t, h.root, "rev-parse", "main"))
	remote := strings.TrimSpace(git(t, bare, "rev-parse", "main"))
	if local != remote {
		t.Fatalf("local main = %s, want %s after pull", local, remote)
	}
}

func TestPushAndRejectedPush(t *testing.T) {
	h, bare := newRemoteHarness(t)
	h.writeFile("a.txt", "one\n")
	commitAll(t, h, "local work")
	if rec := h.post(server.OpPush, map[string]any{}); rec.Code != http.StatusOK {
		t.Fatalf("push status = %d (%s)", rec.Code, rec.Body)
	}
	if local, remote := strings.TrimSpace(git(t, h.root, "rev-parse", "main")), strings.TrimSpace(git(t, bare, "rev-parse", "main")); local != remote {
		t.Fatalf("local main = %s, remote = %s, want equal after push", local, remote)
	}

	// A side worktree advances origin, then the harness diverges: the next
	// push must be rejected as non-fast-forward.
	side := cloneForSideWork(t, bare)
	writeSideFile(t, side, "b.txt", "other\n")
	git(t, side, "add", "b.txt")
	git(t, side, "commit", "-q", "-m", "other side")
	git(t, side, "push", "-q", "origin", "main")

	h.writeFile("b.txt", "local\n")
	commitAll(t, h, "local side")
	rec := h.post(server.OpPush, map[string]any{})
	if rec.Code != http.StatusConflict {
		t.Fatalf("rejected push status = %d, want %d (%s)", rec.Code, http.StatusConflict, rec.Body)
	}
}

func TestPushSetsUpstream(t *testing.T) {
	h, _ := newRemoteHarness(t)
	git(t, h.root, "switch", "-q", "-c", "topic")
	h.writeFile("t.txt", "topic\n")
	commitAll(t, h, "topic work")

	// Push without an upstream returns structured state the UI can act on.
	rec := h.post(server.OpPush, map[string]any{})
	if rec.Code != http.StatusConflict {
		t.Fatalf("no-upstream push status = %d, want %d (%s)", rec.Code, http.StatusConflict, rec.Body)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["code"] != "no-upstream" || body["branch"] != "topic" {
		t.Fatalf("body = %v, want code no-upstream and branch topic", body)
	}

	// Creating the upstream makes the plain push succeed.
	if rec := h.post(server.OpPushSetUpstream, map[string]any{"name": "topic", "remote": "origin"}); rec.Code != http.StatusOK {
		t.Fatalf("push-upstream status = %d (%s)", rec.Code, rec.Body)
	}
	if rec := h.post(server.OpPush, map[string]any{}); rec.Code != http.StatusOK {
		t.Fatalf("plain push status = %d (%s)", rec.Code, rec.Body)
	}
	if got := strings.TrimSpace(git(t, h.root, "rev-parse", "--symbolic-full-name", "@{u}")); got != "refs/remotes/origin/topic" {
		t.Fatalf("upstream = %q, want refs/remotes/origin/topic", got)
	}
}

func TestBranchCreateSwitchDelete(t *testing.T) {
	h, _ := newRemoteHarness(t)

	// Create and switch to a branch at HEAD.
	if rec := h.post(server.OpBranchCreate, map[string]any{"name": "topic"}); rec.Code != http.StatusOK {
		t.Fatalf("create-branch status = %d (%s)", rec.Code, rec.Body)
	}
	if got := strings.TrimSpace(git(t, h.root, "branch", "--show-current")); got != "topic" {
		t.Fatalf("current branch = %q, want topic", got)
	}

	// Switch back and delete the merged branch.
	if rec := h.post(server.OpBranchSwitch, map[string]any{"name": "main"}); rec.Code != http.StatusOK {
		t.Fatalf("switch-branch status = %d (%s)", rec.Code, rec.Body)
	}
	if rec := h.post(server.OpBranchDelete, map[string]any{"name": "topic"}); rec.Code != http.StatusOK {
		t.Fatalf("delete-branch status = %d (%s)", rec.Code, rec.Body)
	}

	// An unmerged branch refuses a plain delete with structured state, and
	// succeeds only after explicit force confirmation.
	git(t, h.root, "switch", "-q", "-c", "wip")
	h.writeFile("w.txt", "wip\n")
	commitAll(t, h, "wip work")
	git(t, h.root, "switch", "-q", "main")

	rec := h.post(server.OpBranchDelete, map[string]any{"name": "wip"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("unmerged delete status = %d, want %d (%s)", rec.Code, http.StatusConflict, rec.Body)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["code"] != "branch-not-merged" {
		t.Fatalf("body = %v, want code branch-not-merged", body)
	}
	if rec := h.post(server.OpBranchDelete, map[string]any{"name": "wip", "force": true}); rec.Code != http.StatusOK {
		t.Fatalf("force delete status = %d (%s)", rec.Code, rec.Body)
	}
	if b := findBranch(branchesFrom(t, h), "wip"); b != nil {
		t.Fatalf("wip branch still listed: %+v", b)
	}
}
