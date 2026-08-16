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
