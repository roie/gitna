// Package integration exercises the workbench end to end: a real Git
// repository behind the HTTP API with the shared mutation queue, matching how
// the browser drives stage, unstage, discard, delete, and partial hunk
// operations.
package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
	"github.com/roie/gitna/internal/server"
)

const (
	testToken = "integration-token"
	testHost  = "gitna.test"
)

// workbenchRepo mirrors the app-layer adapter so mutations flow through the
// serialized queue exactly as they do in production.
type workbenchRepo struct {
	runner *gitx.ExecRunner
	repo   gitx.Repository
	queue  *gitx.MutationQueue
}

func (w *workbenchRepo) Snapshot(ctx context.Context) (protocol.RepoSnapshot, error) {
	return w.repo.Status(ctx, w.runner)
}

func (w *workbenchRepo) Diff(ctx context.Context, scope protocol.DiffScope, opts protocol.DiffOptions) (protocol.FileDiff, error) {
	return w.repo.Diff(ctx, w.runner, scope, opts)
}

func (w *workbenchRepo) History(ctx context.Context, skip, limit int) ([]protocol.GraphCommit, error) {
	return w.repo.History(ctx, w.runner, skip, limit)
}

func (w *workbenchRepo) FilesChanged(ctx context.Context, oid string) ([]protocol.CommitFile, error) {
	return w.repo.ChangedFiles(ctx, w.runner, oid)
}

func (w *workbenchRepo) Branches(ctx context.Context) ([]protocol.Branch, error) {
	return w.repo.ListBranches(ctx, w.runner)
}

func (w *workbenchRepo) CreateBranch(ctx context.Context, name, start string) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.CreateBranch(ctx, w.runner, name, start) })
}

func (w *workbenchRepo) SwitchBranch(ctx context.Context, name string) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.SwitchBranch(ctx, w.runner, name) })
}

func (w *workbenchRepo) DeleteBranch(ctx context.Context, name string, force bool) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.DeleteBranch(ctx, w.runner, name, force) })
}

func (w *workbenchRepo) Fetch(ctx context.Context) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.Fetch(ctx, w.runner) })
}

func (w *workbenchRepo) Pull(ctx context.Context) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.Pull(ctx, w.runner) })
}

func (w *workbenchRepo) Push(ctx context.Context) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.Push(ctx, w.runner) })
}

func (w *workbenchRepo) PushSetUpstream(ctx context.Context, remote, branch string) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.PushSetUpstream(ctx, w.runner, remote, branch) })
}

func (w *workbenchRepo) Stashes(ctx context.Context) ([]protocol.StashEntry, error) {
	return w.repo.ListStashes(ctx, w.runner)
}

func (w *workbenchRepo) StashPush(ctx context.Context, message string, untracked bool) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.StashPush(ctx, w.runner, message, untracked) })
}

func (w *workbenchRepo) StashApply(ctx context.Context, ref string) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.StashApply(ctx, w.runner, ref) })
}

func (w *workbenchRepo) StashPop(ctx context.Context, ref string) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.StashPop(ctx, w.runner, ref) })
}

func (w *workbenchRepo) StashDrop(ctx context.Context, ref string) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.StashDrop(ctx, w.runner, ref) })
}

func (w *workbenchRepo) Tags(ctx context.Context) ([]protocol.Tag, error) {
	return w.repo.ListTags(ctx, w.runner)
}

func (w *workbenchRepo) CreateTag(ctx context.Context, name, target, message string) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.CreateTag(ctx, w.runner, name, target, message) })
}

func (w *workbenchRepo) DeleteTag(ctx context.Context, name string) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.DeleteTag(ctx, w.runner, name) })
}

func (w *workbenchRepo) PushTag(ctx context.Context, remote, name string) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.PushTag(ctx, w.runner, remote, name) })
}

func (w *workbenchRepo) CherryPick(ctx context.Context, oid string) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.CherryPick(ctx, w.runner, oid) })
}

func (w *workbenchRepo) Revert(ctx context.Context, oid string) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.Revert(ctx, w.runner, oid) })
}

func (w *workbenchRepo) Reset(ctx context.Context, target, mode string) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.Reset(ctx, w.runner, target, mode) })
}

func (w *workbenchRepo) CompareFiles(ctx context.Context, from, to string) ([]protocol.CommitFile, error) {
	return w.repo.CompareFiles(ctx, w.runner, from, to)
}

func (w *workbenchRepo) StagePaths(ctx context.Context, paths []string) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.Stage(ctx, w.runner, paths) })
}

func (w *workbenchRepo) UnstagePaths(ctx context.Context, paths []string) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.Unstage(ctx, w.runner, paths) })
}

func (w *workbenchRepo) DiscardTracked(ctx context.Context, paths []string) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.DiscardTracked(ctx, w.runner, paths) })
}

func (w *workbenchRepo) DeleteUntracked(ctx context.Context, paths []string) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.DeleteUntracked(ctx, w.runner, paths) })
}

func (w *workbenchRepo) StagePatch(ctx context.Context, patch []byte) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.ApplyPatch(ctx, w.runner, patch, false) })
}

func (w *workbenchRepo) UnstagePatch(ctx context.Context, patch []byte) error {
	return w.queue.Do(ctx, func(ctx context.Context) error { return w.repo.ApplyPatch(ctx, w.runner, patch, true) })
}

func (w *workbenchRepo) Commit(ctx context.Context, req protocol.CommitRequest) (protocol.OperationResult, error) {
	var result protocol.OperationResult
	err := w.queue.Do(ctx, func(ctx context.Context) error {
		res, err := w.repo.Commit(ctx, w.runner, req.Message, req.Amend)
		result.OK = res.ExitCode == 0
		result.ExitCode = res.ExitCode
		result.Stdout = strings.TrimSpace(string(res.Stdout))
		result.Stderr = strings.TrimSpace(string(res.Stderr))
		return err
	})
	return result, err
}

type harness struct {
	t    *testing.T
	root string
	srv  http.Handler
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	root := t.TempDir()
	git(t, root, "init", "-q")
	git(t, root, "config", "user.email", "test@example.com")
	git(t, root, "config", "user.name", "Test")
	git(t, root, "branch", "-M", "main")
	git(t, root, "commit", "-q", "--allow-empty", "-m", "initial")

	runner := &gitx.ExecRunner{}
	repo, err := gitx.Discover(context.Background(), runner, root)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	adapter := &workbenchRepo{runner: runner, repo: repo, queue: gitx.NewMutationQueue()}

	// Static assets are never requested by these tests; an empty dir keeps the
	// handler honest about what it can serve.
	srv, err := server.New(os.DirFS(t.TempDir()), server.Options{
		Token: testToken,
		Host:  testHost,
		Repo:  adapter,
	})
	if err != nil {
		t.Fatalf("server: %v", err)
	}
	return &harness{t: t, root: root, srv: srv.Handler()}
}

func (h *harness) post(op string, body any) *httptest.ResponseRecorder {
	h.t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			h.t.Fatal(err)
		}
	}
	req := httptest.NewRequest(http.MethodPost, "/s/"+testToken+"/api/v1/operations?op="+op, &buf)
	req.Host = testHost
	req.Header.Set("Origin", "http://"+testHost)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.srv.ServeHTTP(rec, req)
	return rec
}

func (h *harness) get(path string) *httptest.ResponseRecorder {
	h.t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+path, nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.srv.ServeHTTP(rec, req)
	return rec
}

// status returns `git status --porcelain -z` for the harness repository with
// NUL separators turned into newlines so paths containing spaces stay raw.
func (h *harness) status() string {
	h.t.Helper()
	cmd := exec.Command("git", "status", "--porcelain", "-z")
	cmd.Dir = h.root
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		h.t.Fatalf("git status: %v: %s", err, out)
	}
	return strings.ReplaceAll(string(out), "\x00", "\n")
}

// writeFile writes content at the given repo-relative path.
func (h *harness) writeFile(rel, content string) {
	h.t.Helper()
	full := filepath.Join(h.root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		h.t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) readFile(rel string) string {
	h.t.Helper()
	b, err := os.ReadFile(filepath.Join(h.root, filepath.FromSlash(rel)))
	if err != nil {
		h.t.Fatalf("read %s: %v", rel, err)
	}
	return string(b)
}

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return string(out)
}

// numberedContent builds "1\n2\n...\n40\n" with replacements applied.
func numberedContent(replacements map[int]string) string {
	var b strings.Builder
	for i := 1; i <= 40; i++ {
		line := strconv.Itoa(i)
		if r, ok := replacements[i]; ok {
			line = r
		}
		b.WriteString(line)
		b.WriteByte('\n')
	}
	return b.String()
}

// splitHunkPatches splits a unified diff into one standalone patch per hunk,
// each ending with a trailing newline as git apply requires.
func splitHunkPatches(t *testing.T, fullDiff string) []string {
	t.Helper()
	lines := strings.Split(fullDiff, "\n")
	var header []string
	i := 0
	for ; i < len(lines); i++ {
		if strings.HasPrefix(lines[i], "@@") {
			break
		}
		header = append(header, lines[i])
	}
	if i == len(lines) {
		t.Fatalf("diff has no hunks:\n%s", fullDiff)
	}
	var patches []string
	cur := append([]string{}, header...)
	for ; i < len(lines); i++ {
		if strings.HasPrefix(lines[i], "@@") && len(cur) > len(header) {
			patches = append(patches, strings.Join(cur, "\n"))
			cur = append([]string{}, header...)
		}
		cur = append(cur, lines[i])
	}
	patches = append(patches, strings.Join(cur, "\n"))
	for n := range patches {
		if !strings.HasSuffix(patches[n], "\n") {
			patches[n] += "\n"
		}
	}
	return patches
}

// commitAll stages and commits every change in the repository.
func (h *harness) commitAll(msg string) {
	h.t.Helper()
	git(h.t, h.root, "add", "--", ".")
	git(h.t, h.root, "commit", "-q", "-m", msg)
}

func TestStageUnstageFilePreservesWorktree(t *testing.T) {
	h := newHarness(t)
	h.writeFile("file.txt", "base\n")
	h.commitAll("base")

	h.writeFile("file.txt", "changed\n")
	if got := h.post(server.OpStage, map[string]any{"paths": []string{"file.txt"}}); got.Code != http.StatusOK {
		t.Fatalf("stage status = %d (%s)", got.Code, got.Body)
	}
	if h.status() != "M  file.txt\n" {
		t.Fatalf("after stage status = %q, want staged M", h.status())
	}
	if got := h.readFile("file.txt"); got != "changed\n" {
		t.Fatalf("worktree = %q, want unchanged by stage", got)
	}

	if got := h.post(server.OpUnstage, map[string]any{"paths": []string{"file.txt"}}); got.Code != http.StatusOK {
		t.Fatalf("unstage status = %d (%s)", got.Code, got.Body)
	}
	if h.status() != " M file.txt\n" {
		t.Fatalf("after unstage status = %q, want unstaged M", h.status())
	}
	if got := h.readFile("file.txt"); got != "changed\n" {
		t.Fatalf("worktree = %q, want unchanged by unstage", got)
	}
}

func TestPartialHunkStageThenUnstage(t *testing.T) {
	h := newHarness(t)
	h.writeFile("file.txt", numberedContent(nil))
	h.commitAll("base")

	h.writeFile("file.txt", numberedContent(map[int]string{2: "TWO", 30: "THIRTY"}))
	diff := git(t, h.root, "diff", "--", "file.txt")
	hunks := splitHunkPatches(t, diff)
	if len(hunks) < 2 {
		t.Fatalf("expected >=2 hunks, got %d:\n%s", len(hunks), diff)
	}

	if got := h.post(server.OpPatch, map[string]any{"patch": hunks[0]}); got.Code != http.StatusOK {
		t.Fatalf("stage hunk status = %d (%s)", got.Code, got.Body)
	}
	if h.status() != "MM file.txt\n" {
		t.Fatalf("after hunk stage status = %q, want MM", h.status())
	}
	staged := git(t, h.root, "diff", "--cached", "--", "file.txt")
	if !strings.Contains(staged, "+TWO") || strings.Contains(staged, "+THIRTY") {
		t.Fatalf("staged diff wrong:\n%s", staged)
	}

	if got := h.post(server.OpPatch, map[string]any{"patch": hunks[0], "reverse": true}); got.Code != http.StatusOK {
		t.Fatalf("unstage hunk status = %d (%s)", got.Code, got.Body)
	}
	if h.status() != " M file.txt\n" {
		t.Fatalf("after hunk unstage status = %q, want unstaged M", h.status())
	}
	if got := h.readFile("file.txt"); got != numberedContent(map[int]string{2: "TWO", 30: "THIRTY"}) {
		t.Fatalf("worktree changed by unstage: %q", got)
	}
}

func TestRenameStageUnstage(t *testing.T) {
	h := newHarness(t)
	h.writeFile("old.txt", "content\n")
	h.commitAll("base")

	git(t, h.root, "mv", "old.txt", "new name.txt")
	// git detects the rename from the staged addition of the new path alone.
	if got := h.post(server.OpStage, map[string]any{"paths": []string{"new name.txt"}}); got.Code != http.StatusOK {
		t.Fatalf("stage rename status = %d (%s)", got.Code, got.Body)
	}
	if !strings.Contains(h.status(), "R  ") {
		t.Fatalf("status after rename stage = %q, want staged rename", h.status())
	}
	if got := h.readFile("new name.txt"); got != "content\n" {
		t.Fatalf("worktree = %q, want preserved content", got)
	}

	if got := h.post(server.OpUnstage, map[string]any{"paths": []string{"new name.txt"}}); got.Code != http.StatusOK {
		t.Fatalf("unstage rename status = %d (%s)", got.Code, got.Body)
	}
	if strings.Contains(h.status(), "R  ") {
		t.Fatalf("status after rename unstage = %q, want rename unstaged", h.status())
	}
	if _, err := os.Stat(filepath.Join(h.root, "new name.txt")); err != nil {
		t.Fatalf("renamed file missing after unstage: %v", err)
	}
}

func TestPathsWithSpaces(t *testing.T) {
	h := newHarness(t)
	h.writeFile("dir/a file.txt", "one\n")
	h.writeFile("dir/b file.txt", "two\n")
	h.commitAll("base")

	h.writeFile("dir/a file.txt", "one-changed\n")
	if got := h.post(server.OpStage, map[string]any{"paths": []string{"dir/a file.txt"}}); got.Code != http.StatusOK {
		t.Fatalf("stage status = %d (%s)", got.Code, got.Body)
	}
	if h.status() != "M  dir/a file.txt\n" {
		t.Fatalf("status = %q, want only a file.txt staged", h.status())
	}
}

func TestStaleHunkFailsWithoutCorruptingIndex(t *testing.T) {
	h := newHarness(t)
	h.writeFile("file.txt", "one\ntwo\nthree\n")
	h.commitAll("base")

	h.writeFile("file.txt", "ONE\ntwo\nthree\n")
	patch := []byte(git(t, h.root, "diff", "--", "file.txt"))

	// Stage the hunk once, then try to apply the same patch again. The index no
	// longer matches the patch context, so git must reject it and leave the
	// staged state intact rather than silently re-applying.
	if got := h.post(server.OpPatch, map[string]any{"patch": string(patch)}); got.Code != http.StatusOK {
		t.Fatalf("first patch status = %d (%s)", got.Code, got.Body)
	}
	if got := h.post(server.OpPatch, map[string]any{"patch": string(patch)}); got.Code != http.StatusConflict {
		t.Fatalf("stale patch status = %d, want %d (%s)", got.Code, http.StatusConflict, got.Body)
	}
	if h.status() != "M  file.txt\n" {
		t.Fatalf("status after stale patch = %q, want index untouched", h.status())
	}
}

func TestDiscardTrackedRestoresBlob(t *testing.T) {
	h := newHarness(t)
	h.writeFile("file.txt", "base\n")
	h.commitAll("base")

	h.writeFile("file.txt", "changed\n")
	if got := h.post(server.OpDiscard, map[string]any{"paths": []string{"file.txt"}}); got.Code != http.StatusOK {
		t.Fatalf("discard status = %d (%s)", got.Code, got.Body)
	}
	if h.status() != "" {
		t.Fatalf("status after discard = %q, want clean", h.status())
	}
	if got := h.readFile("file.txt"); got != "base\n" {
		t.Fatalf("worktree = %q, want restored blob", got)
	}
}

func TestDeleteUntrackedDeletesOnlySelectedPath(t *testing.T) {
	h := newHarness(t)
	h.writeFile("keep.txt", "keep\n")
	h.writeFile("dir/drop.txt", "drop\n")
	h.commitAll("base")

	h.writeFile("untracked-one.txt", "one\n")
	h.writeFile("untracked-two.txt", "two\n")
	if got := h.post(server.OpDelete, map[string]any{"paths": []string{"untracked-one.txt"}}); got.Code != http.StatusOK {
		t.Fatalf("delete status = %d (%s)", got.Code, got.Body)
	}
	if _, err := os.Stat(filepath.Join(h.root, "untracked-one.txt")); !os.IsNotExist(err) {
		t.Fatalf("untracked-one.txt still exists: %v", err)
	}
	if got := h.readFile("untracked-two.txt"); got != "two\n" {
		t.Fatalf("untracked-two.txt = %q, want untouched", got)
	}
}

func TestCommitViaAPI(t *testing.T) {
	h := newHarness(t)
	h.writeFile("file.txt", "base\n")
	h.commitAll("base")
	h.writeFile("file.txt", "changed\n")
	if got := h.post(server.OpStage, map[string]any{"paths": []string{"file.txt"}}); got.Code != http.StatusOK {
		t.Fatalf("stage status = %d (%s)", got.Code, got.Body)
	}

	rec := h.post(server.OpCommit, map[string]any{"message": "feature work\n\nAdd the change.", "amend": false})
	if rec.Code != http.StatusOK {
		t.Fatalf("commit status = %d (%s)", rec.Code, rec.Body)
	}
	var result protocol.OperationResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatalf("unmarshal commit result: %v", err)
	}
	if !result.OK {
		t.Fatalf("commit result = %+v, want OK", result)
	}
	if got := strings.TrimSpace(git(t, h.root, "log", "-1", "--format=%B")); got != "feature work\n\nAdd the change." {
		t.Fatalf("head message = %q, want committed message", got)
	}
	if h.status() != "" {
		t.Fatalf("status after commit = %q, want clean", h.status())
	}
}

func TestCommitHookFailureRelayed(t *testing.T) {
	h := newHarness(t)
	h.writeFile("file.txt", "base\n")
	h.commitAll("base")
	h.writeFile("file.txt", "changed\n")
	if got := h.post(server.OpStage, map[string]any{"paths": []string{"file.txt"}}); got.Code != http.StatusOK {
		t.Fatalf("stage status = %d (%s)", got.Code, got.Body)
	}
	hook := filepath.Join(h.root, ".git", "hooks", "pre-commit")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\necho policy rejects this commit\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	rec := h.post(server.OpCommit, map[string]any{"message": "subject", "amend": false})
	if rec.Code != http.StatusOK {
		t.Fatalf("commit status = %d, want %d (hook rejection is not an HTTP error) (%s)", rec.Code, http.StatusOK, rec.Body)
	}
	var result protocol.OperationResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatalf("unmarshal commit result: %v", err)
	}
	if result.OK {
		t.Fatal("commit result OK, want rejected")
	}
	if !strings.Contains(result.Stderr, "policy rejects this commit") {
		t.Fatalf("stderr = %q, want hook output relayed", result.Stderr)
	}
	// The rejected commit must leave HEAD untouched.
	if !strings.Contains(h.status(), "M  file.txt") {
		t.Fatalf("status = %q, want change still staged", h.status())
	}
}

func TestOperationQueueSerializesMutations(t *testing.T) {
	h := newHarness(t)
	h.writeFile("file.txt", "base\n")
	h.commitAll("base")
	h.writeFile("file.txt", "changed\n")

	// Fire many concurrent mutations at the API; they must all succeed and the
	// index must end staged exactly once, never an interleaving.
	results := make(chan int, 10)
	for i := 0; i < 10; i++ {
		go func() {
			req := httptest.NewRequest(http.MethodPost, "/s/"+testToken+"/api/v1/operations?op="+server.OpStage, strings.NewReader(`{"paths":["file.txt"]}`))
			req.Host = testHost
			req.Header.Set("Origin", "http://"+testHost)
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			h.srv.ServeHTTP(rec, req)
			results <- rec.Code
		}()
	}
	for range 10 {
		if code := <-results; code != http.StatusOK {
			t.Fatalf("concurrent stage code = %d, want %d", code, http.StatusOK)
		}
	}
	if h.status() != "M  file.txt\n" {
		t.Fatalf("status after concurrent stages = %q, want staged M", h.status())
	}
}

func TestGraphViaAPI(t *testing.T) {
	h := newHarness(t)
	h.writeFile("a.txt", "a\n")
	h.commitAll("root commit")
	git(t, h.root, "checkout", "-q", "-b", "feature")
	h.writeFile("f.txt", "f\n")
	h.commitAll("feature work")
	git(t, h.root, "checkout", "-q", "main")
	h.writeFile("b.txt", "b\n")
	h.commitAll("second")
	git(t, h.root, "merge", "-q", "--no-ff", "feature", "-m", "merge feature")
	git(t, h.root, "tag", "v1.0")
	git(t, h.root, "update-ref", "refs/remotes/origin/main", "HEAD")

	rec := h.get("/api/v1/graph")
	if rec.Code != http.StatusOK {
		t.Fatalf("graph status = %d (%s)", rec.Code, rec.Body)
	}
	var page protocol.GraphPage
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
		t.Fatalf("unmarshal graph: %v", err)
	}
	// initial + root + feature work + second + merge.
	if len(page.Commits) != 5 {
		t.Fatalf("history = %d commits, want 5", len(page.Commits))
	}
	merge := page.Commits[0]
	if merge.Subject != "merge feature" || len(merge.Parents) != 2 {
		t.Fatalf("merge = %+v, want two-parent merge feature", merge)
	}
	gotHead := false
	for _, ref := range merge.Refs {
		if ref.Kind == protocol.RefKindHead && ref.Name == "main" {
			gotHead = true
		}
	}
	if !gotHead {
		t.Fatalf("merge refs = %+v, want HEAD main", merge.Refs)
	}

	filesRec := h.get("/api/v1/commit/" + merge.OID + "/files")
	if filesRec.Code != http.StatusOK {
		t.Fatalf("commit files status = %d (%s)", filesRec.Code, filesRec.Body)
	}
	var cf protocol.CommitFiles
	if err := json.Unmarshal(filesRec.Body.Bytes(), &cf); err != nil {
		t.Fatalf("unmarshal commit files: %v", err)
	}
	// The merge brings feature's f.txt in; b.txt already landed on main.
	found := false
	for _, f := range cf.Files {
		if f.Path == "f.txt" && f.Kind == protocol.KindAdded {
			found = true
		}
	}
	if !found {
		t.Fatalf("merge files = %+v, want added f.txt", cf.Files)
	}

	rootOID := page.Commits[3].OID
	if page.Commits[3].Subject != "root commit" {
		t.Fatalf("page[3] = %q, want root commit", page.Commits[3].Subject)
	}
	rootRec := h.get("/api/v1/commit/" + rootOID + "/files")
	if rootRec.Code != http.StatusOK {
		t.Fatalf("root files status = %d (%s)", rootRec.Code, rootRec.Body)
	}
	var rootFiles protocol.CommitFiles
	if err := json.Unmarshal(rootRec.Body.Bytes(), &rootFiles); err != nil {
		t.Fatalf("unmarshal root files: %v", err)
	}
	if len(rootFiles.Files) != 1 || rootFiles.Files[0].Path != "a.txt" || rootFiles.Files[0].Kind != protocol.KindAdded {
		t.Fatalf("root files = %+v, want [a.txt added]", rootFiles.Files)
	}
}

func TestGraphRefreshReflectsNewCommit(t *testing.T) {
	h := newHarness(t)
	h.writeFile("file.txt", "base\n")
	h.commitAll("base")

	before := h.get("/api/v1/graph")
	if before.Code != http.StatusOK {
		t.Fatalf("graph status = %d (%s)", before.Code, before.Body)
	}
	var beforePage protocol.GraphPage
	if err := json.Unmarshal(before.Body.Bytes(), &beforePage); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(beforePage.Commits) != 2 {
		t.Fatalf("history = %d commits, want 2", len(beforePage.Commits))
	}

	h.writeFile("file.txt", "changed\n")
	h.commitAll("new commit")

	after := h.get("/api/v1/graph")
	var afterPage protocol.GraphPage
	if err := json.Unmarshal(after.Body.Bytes(), &afterPage); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(afterPage.Commits) != 3 {
		t.Fatalf("history after commit = %d commits, want 3", len(afterPage.Commits))
	}
	if afterPage.Commits[0].Subject != "new commit" {
		t.Fatalf("head after commit = %q, want new commit", afterPage.Commits[0].Subject)
	}
	// Pagination: skip 2 returns only the oldest commit.
	skipped := h.get("/api/v1/graph?skip=2")
	var skippedPage protocol.GraphPage
	if err := json.Unmarshal(skipped.Body.Bytes(), &skippedPage); err != nil {
		t.Fatalf("unmarshal skipped: %v", err)
	}
	if len(skippedPage.Commits) != 1 || skippedPage.Commits[0].OID != beforePage.Commits[1].OID {
		t.Fatalf("skipped = %+v, want the initial commit", skippedPage.Commits)
	}
}
