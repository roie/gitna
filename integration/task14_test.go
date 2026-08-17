package integration_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

func conflictsOf(t *testing.T, h *harness) []protocol.ConflictEntry {
	t.Helper()
	rec := h.get("/api/v1/conflicts")
	if rec.Code != http.StatusOK {
		t.Fatalf("conflicts status = %d (%s)", rec.Code, rec.Body)
	}
	var entries []protocol.ConflictEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &entries); err != nil {
		t.Fatalf("unmarshal conflicts: %v", err)
	}
	return entries
}

func divergeFixture(t *testing.T, h *harness) {
	t.Helper()
	h.writeFile("a.txt", "base\n")
	h.commitAll("base")
	git(t, h.root, "checkout", "-q", "-b", "feature")
	h.writeFile("a.txt", "feature version\n")
	h.commitAll("feature change")
	git(t, h.root, "checkout", "-q", "main")
	h.writeFile("a.txt", "main version\n")
	h.commitAll("main change")
}

func TestMergeClean(t *testing.T) {
	h := newHarness(t)
	h.writeFile("file.txt", "base\n")
	h.commitAll("base")
	git(t, h.root, "checkout", "-q", "-b", "feature")
	h.writeFile("feature.txt", "feature\n")
	h.commitAll("add feature")
	git(t, h.root, "checkout", "-q", "main")

	expectOK(t, h.post("merge", map[string]any{"name": "feature"}), "merge")
	if got := h.readFile("feature.txt"); got != "feature\n" {
		t.Fatalf("after merge feature.txt = %q", got)
	}
	if snap := snapshotOf(t, h); snap.Operation != protocol.OperationNone {
		t.Fatalf("operation after clean merge = %q, want none", snap.Operation)
	}
}

func TestMergeConflictAndAbort(t *testing.T) {
	h := newHarness(t)
	divergeFixture(t, h)

	rec := h.post("merge", map[string]any{"name": "feature"})
	if rec.Code != http.StatusOK {
		t.Fatalf("merge conflict status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	snap := snapshotOf(t, h)
	if snap.Operation != protocol.OperationMerge {
		t.Fatalf("operation after merge conflict = %q, want merge", snap.Operation)
	}
	conflicts := conflictsOf(t, h)
	if len(conflicts) != 1 || conflicts[0].Path != "a.txt" {
		t.Fatalf("conflicts = %+v, want one a.txt", conflicts)
	}
	if got := h.status(); !strings.Contains(got, "UU a.txt") {
		t.Fatalf("conflicting merge should leave unmerged, got %q", got)
	}

	expectOK(t, h.post("merge-abort", map[string]any{}), "merge-abort")
	if snap := snapshotOf(t, h); snap.Operation != protocol.OperationNone {
		t.Fatalf("operation after merge abort = %q, want none", snap.Operation)
	}
}

func TestMergeConflictAndContinue(t *testing.T) {
	h := newHarness(t)
	divergeFixture(t, h)

	expectOK(t, h.post("merge", map[string]any{"name": "feature"}), "merge")
	expectOK(t, h.post("resolve-ours", map[string]any{"paths": []string{"a.txt"}}), "resolve-ours")
	if got := h.readFile("a.txt"); got != "main version\n" {
		t.Fatalf("after resolve-ours a.txt = %q, want main version", got)
	}
	expectOK(t, h.post("merge-continue", map[string]any{}), "merge-continue")
	if snap := snapshotOf(t, h); snap.Operation != protocol.OperationNone {
		t.Fatalf("operation after merge continue = %q, want none", snap.Operation)
	}
	if got := h.status(); got != "" {
		t.Fatalf("after merge continue status = %q, want clean", got)
	}
}

func TestMergeResolveTheirs(t *testing.T) {
	h := newHarness(t)
	divergeFixture(t, h)

	expectOK(t, h.post("merge", map[string]any{"name": "feature"}), "merge")
	expectOK(t, h.post("resolve-theirs", map[string]any{"paths": []string{"a.txt"}}), "resolve-theirs")
	if got := h.readFile("a.txt"); got != "feature version\n" {
		t.Fatalf("after resolve-theirs a.txt = %q, want feature version", got)
	}
	expectOK(t, h.post("merge-continue", map[string]any{}), "merge-continue")
	if got := h.readFile("a.txt"); got != "feature version\n" {
		t.Fatalf("after merge continue a.txt = %q, want feature version", got)
	}
}

func TestMergeAlreadyInProgress(t *testing.T) {
	h := newHarness(t)
	divergeFixture(t, h)

	expectOK(t, h.post("merge", map[string]any{"name": "feature"}), "merge")
	rec := h.post("merge", map[string]any{"name": "feature"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("merge already in progress status = %d, want 409", rec.Code)
	}
	var body map[string]any
	json.Unmarshal(rec.Body.Bytes(), &body)
	if body["code"] != "already-in-progress" {
		t.Fatalf("body code = %v, want already-in-progress", body["code"])
	}
	git(t, h.root, "merge", "--abort")
}

func TestRebaseClean(t *testing.T) {
	h := newHarness(t)
	h.writeFile("file.txt", "base\n")
	h.commitAll("base")
	git(t, h.root, "checkout", "-q", "-b", "feature")
	h.writeFile("feature.txt", "feature\n")
	h.commitAll("add feature")
	git(t, h.root, "checkout", "-q", "main")

	expectOK(t, h.post("rebase", map[string]any{"name": "feature"}), "rebase")
	if got := h.readFile("feature.txt"); got != "feature\n" {
		t.Fatalf("after rebase feature.txt = %q", got)
	}
	if snap := snapshotOf(t, h); snap.Operation != protocol.OperationNone {
		t.Fatalf("operation after clean rebase = %q, want none", snap.Operation)
	}
}

func TestRebaseConflictAndAbort(t *testing.T) {
	h := newHarness(t)
	// Create a scenario where rebase conflicts: feature branches off, then main
	// changes the same file differently.
	h.writeFile("a.txt", "base\n")
	h.commitAll("base")
	git(t, h.root, "checkout", "-q", "-b", "feature")
	h.writeFile("a.txt", "feature version\n")
	h.commitAll("feature change")
	git(t, h.root, "checkout", "-q", "main")
	h.writeFile("a.txt", "main version\n")
	h.commitAll("main change")
	git(t, h.root, "checkout", "-q", "feature")

	rec := h.post("rebase", map[string]any{"name": "main"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("rebase conflict status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	var body map[string]any
	json.Unmarshal(rec.Body.Bytes(), &body)
	if body["code"] != "conflict" {
		t.Fatalf("body code = %v, want conflict", body["code"])
	}
	if snap := snapshotOf(t, h); snap.Operation != protocol.OperationRebase {
		t.Fatalf("operation after rebase conflict = %q, want rebase", snap.Operation)
	}

	expectOK(t, h.post("rebase-abort", map[string]any{}), "rebase-abort")
	if snap := snapshotOf(t, h); snap.Operation != protocol.OperationNone {
		t.Fatalf("operation after rebase abort = %q, want none", snap.Operation)
	}
}

func TestRebaseConflictAndContinue(t *testing.T) {
	h := newHarness(t)
	h.writeFile("a.txt", "base\n")
	h.commitAll("base")
	git(t, h.root, "checkout", "-q", "-b", "feature")
	h.writeFile("a.txt", "feature version\n")
	h.commitAll("feature change")
	git(t, h.root, "checkout", "-q", "main")
	h.writeFile("a.txt", "main version\n")
	h.commitAll("main change")
	git(t, h.root, "checkout", "-q", "feature")

	rec := h.post("rebase", map[string]any{"name": "main"})
	if rec.Code != http.StatusConflict {
		t.Fatalf("rebase conflict status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	expectOK(t, h.post("resolve-ours", map[string]any{"paths": []string{"a.txt"}}), "resolve-ours")
	expectOK(t, h.post("rebase-continue", map[string]any{}), "rebase-continue")
	if snap := snapshotOf(t, h); snap.Operation != protocol.OperationNone {
		t.Fatalf("operation after rebase continue = %q, want none", snap.Operation)
	}
}

func TestConflictsRouteEmpty(t *testing.T) {
	h := newHarness(t)
	h.writeFile("file.txt", "clean\n")
	h.commitAll("clean")
	conflicts := conflictsOf(t, h)
	if len(conflicts) != 0 {
		t.Fatalf("expected no conflicts, got %+v", conflicts)
	}
}
