package integration_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

func snapshotOf(t *testing.T, h *harness) protocol.RepoSnapshot {
	t.Helper()
	rec := h.get("/api/v1/snapshot")
	if rec.Code != http.StatusOK {
		t.Fatalf("snapshot status = %d (%s)", rec.Code, rec.Body)
	}
	var snap protocol.RepoSnapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &snap); err != nil {
		t.Fatalf("unmarshal snapshot: %v", err)
	}
	return snap
}

func stashesOf(t *testing.T, h *harness) []protocol.StashEntry {
	t.Helper()
	rec := h.get("/api/v1/stashes")
	if rec.Code != http.StatusOK {
		t.Fatalf("stashes status = %d (%s)", rec.Code, rec.Body)
	}
	var entries []protocol.StashEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &entries); err != nil {
		t.Fatalf("unmarshal stashes: %v", err)
	}
	return entries
}

func tagsOf(t *testing.T, h *harness) []protocol.Tag {
	t.Helper()
	rec := h.get("/api/v1/tags")
	if rec.Code != http.StatusOK {
		t.Fatalf("tags status = %d (%s)", rec.Code, rec.Body)
	}
	var tags []protocol.Tag
	if err := json.Unmarshal(rec.Body.Bytes(), &tags); err != nil {
		t.Fatalf("unmarshal tags: %v", err)
	}
	return tags
}

func expectOK(t *testing.T, rec *httptest.ResponseRecorder, op string) {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("%s status = %d (%s)", op, rec.Code, rec.Body)
	}
}

func TestStashLifecycle(t *testing.T) {
	h := newHarness(t)
	h.writeFile("file.txt", "base\n")
	h.commitAll("base")

	h.writeFile("file.txt", "work\n")
	expectOK(t, h.post("stash-push", map[string]any{"message": "wip work"}), "stash-push")
	if got := h.status(); got != "" {
		t.Fatalf("after stash push status = %q, want clean", got)
	}

	stashes := stashesOf(t, h)
	if len(stashes) != 1 {
		t.Fatalf("stashes = %+v, want one entry", stashes)
	}
	if stashes[0].Ref != "stash@{0}" || stashes[0].Branch != "main" || stashes[0].Message != "wip work" {
		t.Fatalf("stash entry = %+v", stashes[0])
	}

	expectOK(t, h.post("stash-apply", map[string]any{"ref": "stash@{0}"}), "stash-apply")
	if got := h.readFile("file.txt"); got != "work\n" {
		t.Fatalf("after apply file.txt = %q, want work", got)
	}
	if len(stashesOf(t, h)) != 1 {
		t.Fatalf("apply must keep the stash entry")
	}

	expectOK(t, h.post("stash-drop", map[string]any{"ref": "stash@{0}"}), "stash-drop")
	if len(stashesOf(t, h)) != 0 {
		t.Fatalf("drop must remove the stash entry")
	}

	rec := h.post("stash-pop", map[string]any{"ref": "stash@{0}"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("pop missing stash status = %d, want 404", rec.Code)
	}
}

func TestStashIncludeUntrackedAndConflict(t *testing.T) {
	h := newHarness(t)
	h.writeFile("file.txt", "base\n")
	h.commitAll("base")

	h.writeFile("file.txt", "work\n")
	h.writeFile("u.txt", "untracked\n")
	expectOK(t, h.post("stash-push", map[string]any{"message": "wip", "includeUntracked": true}), "stash-push")
	if got := h.status(); got != "" {
		t.Fatalf("after stash -u status = %q, want clean", got)
	}

	expectOK(t, h.post("stash-pop", map[string]any{"ref": "stash@{0}"}), "stash-pop")
	if got := h.status(); got != " M file.txt\n?? u.txt\n" {
		t.Fatalf("after pop status = %q", got)
	}

	// A conflicting apply (worktree clean, HEAD diverged) reports 409 and keeps
	// the stash entry with unmerged paths in the index.
	h.writeFile("file.txt", "work\n")
	expectOK(t, h.post("stash-push", map[string]any{"message": "conflicting"}), "stash-push")
	h.writeFile("file.txt", "other\n")
	h.commitAll("other")
	rec := h.post("stash-apply", map[string]any{"ref": "stash@{0}"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("conflicting apply status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if len(stashesOf(t, h)) != 1 {
		t.Fatalf("conflicting apply must keep the stash entry")
	}
	if got := h.status(); !strings.Contains(got, "UU file.txt") {
		t.Fatalf("conflicting apply should leave unmerged paths, got %q", got)
	}
}

func TestTagLifecycle(t *testing.T) {
	h := newHarness(t)
	h.writeFile("file.txt", "base\n")
	h.commitAll("base")
	target := strings.TrimSpace(git(t, h.root, "rev-parse", "HEAD"))

	expectOK(t, h.post("create-tag", map[string]any{"name": "light", "start": target}), "create-tag light")
	expectOK(t, h.post("create-tag", map[string]any{"name": "v1", "start": target, "message": "release one"}), "create-tag v1")

	tags := tagsOf(t, h)
	if len(tags) != 2 {
		t.Fatalf("tags = %+v, want two", tags)
	}
	var light, annotated *protocol.Tag
	for i := range tags {
		if tags[i].Name == "light" {
			light = &tags[i]
		}
		if tags[i].Name == "v1" {
			annotated = &tags[i]
		}
	}
	if light == nil || annotated == nil {
		t.Fatalf("tags = %+v, want light + v1", tags)
	}
	if light.Annotated || light.OID != target {
		t.Fatalf("light tag = %+v, want plain %s", *light, target)
	}
	if !annotated.Annotated || annotated.OID != target {
		t.Fatalf("annotated tag = %+v, want annotated %s", *annotated, target)
	}
	if got := git(t, h.root, "cat-file", "-t", "v1"); strings.TrimSpace(got) != "tag" {
		t.Fatalf("v1 object type = %q, want tag", got)
	}

	rec := h.post("create-tag", map[string]any{"name": "v1", "start": target})
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate tag status = %d, want 409 (%s)", rec.Code, rec.Body)
	}

	expectOK(t, h.post("delete-tag", map[string]any{"name": "light"}), "delete-tag light")
	tags = tagsOf(t, h)
	if len(tags) != 1 || tags[0].Name != "v1" {
		t.Fatalf("tags after delete = %+v", tags)
	}

	rec = h.post("delete-tag", map[string]any{"name": "nope"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete missing tag status = %d, want 404", rec.Code)
	}
}

func TestPushTagToRemote(t *testing.T) {
	h, bare := newRemoteHarness(t)
	h.writeFile("file.txt", "base\n")
	h.commitAll("base")
	expectOK(t, h.post("create-tag", map[string]any{"name": "v1", "start": "HEAD", "message": "release"}), "create-tag")
	expectOK(t, h.post("push-tag", map[string]any{"remote": "origin", "name": "v1"}), "push-tag")

	if got := strings.TrimSpace(git(t, bare, "rev-parse", "v1")); got == "" || got == "v1" {
		t.Fatalf("bare repo tag v1 missing, got %q", got)
	}
	local := strings.TrimSpace(git(t, h.root, "rev-parse", "v1^{}"))
	remote := strings.TrimSpace(git(t, bare, "rev-parse", "v1^{}"))
	if local != remote {
		t.Fatalf("pushed tag peeled oid %s != local %s", remote, local)
	}
}

func TestCherryPickCleanAndConflict(t *testing.T) {
	h := newHarness(t)
	h.writeFile("file.txt", "base\n")
	h.commitAll("base")

	// topic diverges on file.txt; main commits its own change, so cherry-picking
	// the topic commit onto main conflicts on file.txt.
	git(t, h.root, "checkout", "-q", "-b", "topic")
	h.writeFile("file.txt", "side\n")
	h.commitAll("side change")
	side := strings.TrimSpace(git(t, h.root, "rev-parse", "HEAD"))
	git(t, h.root, "checkout", "-q", "main")
	h.writeFile("file.txt", "main\n")
	h.commitAll("main change")

	rec := h.post("cherry-pick", map[string]any{"ref": side})
	if rec.Code != http.StatusConflict {
		t.Fatalf("conflicting cherry-pick status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if snap := snapshotOf(t, h); snap.Operation != protocol.OperationCherryPick {
		t.Fatalf("operation after conflict = %q, want cherry-pick", snap.Operation)
	}
	if got := h.status(); !strings.Contains(got, "UU file.txt") {
		t.Fatalf("conflicting cherry-pick should leave unmerged paths, got %q", got)
	}
	git(t, h.root, "cherry-pick", "--abort")

	// A clean cherry-pick (commit that only adds a file) applies without a
	// sequencer state.
	git(t, h.root, "checkout", "-q", "topic")
	h.writeFile("extra.txt", "extra\n")
	h.commitAll("add extra")
	clean := strings.TrimSpace(git(t, h.root, "rev-parse", "HEAD"))
	git(t, h.root, "checkout", "-q", "main")

	expectOK(t, h.post("cherry-pick", map[string]any{"ref": clean}), "cherry-pick clean")
	if got := h.status(); got != "" {
		t.Fatalf("after clean cherry-pick status = %q, want clean", got)
	}
	if got := h.readFile("extra.txt"); got != "extra\n" {
		t.Fatalf("after cherry-pick extra.txt = %q", got)
	}
	if snap := snapshotOf(t, h); snap.Operation != protocol.OperationNone {
		t.Fatalf("operation after clean cherry-pick = %q, want none", snap.Operation)
	}
}

func TestRevertCleanAndConflict(t *testing.T) {
	h := newHarness(t)
	h.writeFile("file.txt", "one\n")
	h.commitAll("one")
	h.writeFile("file.txt", "two\n")
	h.commitAll("two")
	change := strings.TrimSpace(git(t, h.root, "rev-parse", "HEAD"))

	// Clean revert of the HEAD change restores the worktree content.
	expectOK(t, h.post("revert", map[string]any{"ref": change}), "revert clean")
	if snap := snapshotOf(t, h); snap.Operation != protocol.OperationNone {
		t.Fatalf("operation after clean revert = %q, want none", snap.Operation)
	}
	if got := h.readFile("file.txt"); got != "one\n" {
		t.Fatalf("revert should restore file.txt = one, got %q", got)
	}
	if got := strings.TrimSpace(git(t, h.root, "show", "HEAD:file.txt")); got != "one" {
		t.Fatalf("revert commit should record file.txt = one, got %q", got)
	}

	// A conflicting revert (HEAD moved again) reports 409 and leaves the
	// sequencer state.
	h.writeFile("file.txt", "three\n")
	h.commitAll("three")
	rec := h.post("revert", map[string]any{"ref": change})
	if rec.Code != http.StatusConflict {
		t.Fatalf("conflicting revert status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if snap := snapshotOf(t, h); snap.Operation != protocol.OperationRevert {
		t.Fatalf("operation after revert conflict = %q, want revert", snap.Operation)
	}
	if got := h.status(); !strings.Contains(got, "UU file.txt") {
		t.Fatalf("conflicting revert should leave unmerged paths, got %q", got)
	}
}

func TestResetModes(t *testing.T) {
	h := newHarness(t)
	h.writeFile("file.txt", "one\n")
	h.commitAll("one")
	h.writeFile("file.txt", "two\n")
	h.commitAll("two")
	target := strings.TrimSpace(git(t, h.root, "rev-parse", "HEAD~1"))
	head := strings.TrimSpace(git(t, h.root, "rev-parse", "HEAD"))

	// soft: HEAD moves, index keeps the commit's changes staged.
	expectOK(t, h.post("reset", map[string]any{"ref": target, "mode": "soft"}), "reset soft")
	if got := strings.TrimSpace(git(t, h.root, "rev-parse", "HEAD")); got != target {
		t.Fatalf("HEAD after soft = %s, want %s", got, target)
	}
	if got := h.status(); !strings.Contains(got, "M  file.txt") {
		t.Fatalf("soft reset should stage file.txt, got %q", got)
	}

	// mixed: index changes unstaged, worktree preserved.
	expectOK(t, h.post("reset", map[string]any{"ref": target, "mode": "mixed"}), "reset mixed")
	if got := h.status(); !strings.Contains(got, " M file.txt") {
		t.Fatalf("mixed reset should unstage file.txt, got %q", got)
	}

	// hard: worktree reset to target, everything clean.
	expectOK(t, h.post("reset", map[string]any{"ref": target, "mode": "hard"}), "reset hard")
	if got := h.status(); got != "" {
		t.Fatalf("hard reset should clean the worktree, got %q", got)
	}
	if got := h.readFile("file.txt"); got != "one\n" {
		t.Fatalf("file.txt after hard = %q, want one", got)
	}
	if head == target {
		t.Fatal("fixture error: HEAD~1 == HEAD")
	}
}

func TestCompareEndpoint(t *testing.T) {
	h := newHarness(t)
	h.writeFile("a.txt", "one\n")
	h.commitAll("one")
	from := strings.TrimSpace(git(t, h.root, "rev-parse", "HEAD"))
	h.writeFile("a.txt", "two\n")
	h.writeFile("b.txt", "new\n")
	h.commitAll("two")
	to := strings.TrimSpace(git(t, h.root, "rev-parse", "HEAD"))

	rec := h.get("/api/v1/compare?from=" + from + "&to=" + to)
	if rec.Code != http.StatusOK {
		t.Fatalf("compare status = %d (%s)", rec.Code, rec.Body)
	}
	var files protocol.CommitFiles
	if err := json.Unmarshal(rec.Body.Bytes(), &files); err != nil {
		t.Fatalf("unmarshal compare: %v", err)
	}
	if len(files.Files) != 2 {
		t.Fatalf("compare files = %+v, want two", files.Files)
	}

	rec = h.get("/api/v1/compare?from=" + from)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("compare missing to status = %d, want 400", rec.Code)
	}
	rec = h.get("/api/v1/compare?from=bad..ref&to=" + to)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("compare bad ref status = %d, want 400", rec.Code)
	}
}
