package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

type fakeRepo struct {
	snap protocol.RepoSnapshot
	err  error
	diff protocol.FileDiff

	graphCommits []protocol.GraphCommit
	graphFiles   []protocol.CommitFile
	branches     []protocol.Branch
	stashes      []protocol.StashEntry
	tags         []protocol.Tag
	compareFiles []protocol.CommitFile

	mu        sync.Mutex
	stageOps  []string
	unstages  []string
	discards  []string
	deletes   []string
	patches   []fakePatchCall
	commits   []protocol.CommitRequest
	commitRes protocol.OperationResult
	commitErr error
	opErr     error

	branchCalls  []string
	branchForces []bool
	syncCalls    []string
	stashCalls   []string
	tagCalls     []string
	historyCalls []string
	resetModes   []string
	compareCalls []string
}

// opFail returns the error a mutation method should report. opErr takes
// precedence so a test can fail one operation while snapshot reads succeed.
func (f *fakeRepo) opFail() error {
	if f.opErr != nil {
		return f.opErr
	}
	return f.err
}

type fakePatchCall struct {
	patch   string
	reverse bool
}

func (f *fakeRepo) Snapshot(context.Context) (protocol.RepoSnapshot, error) {
	if f.err != nil {
		return protocol.RepoSnapshot{}, f.err
	}
	return f.snap, nil
}

func (f *fakeRepo) Diff(context.Context, protocol.DiffScope, protocol.DiffOptions) (protocol.FileDiff, error) {
	if f.err != nil {
		return protocol.FileDiff{}, f.err
	}
	return f.diff, nil
}

func (f *fakeRepo) History(context.Context, int, int) ([]protocol.GraphCommit, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.graphCommits, nil
}

func (f *fakeRepo) FilesChanged(context.Context, string) ([]protocol.CommitFile, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.graphFiles, nil
}

func (f *fakeRepo) Branches(context.Context) ([]protocol.Branch, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.branches, nil
}

func (f *fakeRepo) CreateBranch(_ context.Context, name, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.branchCalls = append(f.branchCalls, "create:"+name)
	return f.opFail()
}

func (f *fakeRepo) SwitchBranch(_ context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.branchCalls = append(f.branchCalls, "switch:"+name)
	return f.opFail()
}

func (f *fakeRepo) DeleteBranch(_ context.Context, name string, force bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.branchCalls = append(f.branchCalls, "delete:"+name)
	f.branchForces = append(f.branchForces, force)
	return f.opFail()
}

func (f *fakeRepo) Fetch(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.syncCalls = append(f.syncCalls, "fetch")
	return f.opFail()
}

func (f *fakeRepo) Pull(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.syncCalls = append(f.syncCalls, "pull")
	return f.opFail()
}

func (f *fakeRepo) Push(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.syncCalls = append(f.syncCalls, "push")
	return f.opFail()
}

func (f *fakeRepo) PushSetUpstream(_ context.Context, remote, branch string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.syncCalls = append(f.syncCalls, "push-upstream:"+remote+":"+branch)
	return f.opFail()
}

func (f *fakeRepo) Stashes(context.Context) ([]protocol.StashEntry, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.stashes, nil
}

func (f *fakeRepo) StashPush(_ context.Context, message string, untracked bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stashCalls = append(f.stashCalls, "push:"+message+":untracked="+boolStr(untracked))
	return f.opFail()
}

func (f *fakeRepo) StashApply(_ context.Context, ref string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stashCalls = append(f.stashCalls, "apply:"+ref)
	return f.opFail()
}

func (f *fakeRepo) StashPop(_ context.Context, ref string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stashCalls = append(f.stashCalls, "pop:"+ref)
	return f.opFail()
}

func (f *fakeRepo) StashDrop(_ context.Context, ref string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stashCalls = append(f.stashCalls, "drop:"+ref)
	return f.opFail()
}

func (f *fakeRepo) Tags(context.Context) ([]protocol.Tag, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.tags, nil
}

func (f *fakeRepo) CreateTag(_ context.Context, name, target, message string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tagCalls = append(f.tagCalls, "create:"+name+":"+target+":"+message)
	return f.opFail()
}

func (f *fakeRepo) DeleteTag(_ context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tagCalls = append(f.tagCalls, "delete:"+name)
	return f.opFail()
}

func (f *fakeRepo) PushTag(_ context.Context, remote, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tagCalls = append(f.tagCalls, "push:"+remote+":"+name)
	return f.opFail()
}

func (f *fakeRepo) CherryPick(_ context.Context, ref string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.historyCalls = append(f.historyCalls, "cherry-pick:"+ref)
	return f.opFail()
}

func (f *fakeRepo) Revert(_ context.Context, ref string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.historyCalls = append(f.historyCalls, "revert:"+ref)
	return f.opFail()
}

func (f *fakeRepo) Reset(_ context.Context, target, mode string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.historyCalls = append(f.historyCalls, "reset:"+target)
	f.resetModes = append(f.resetModes, mode)
	return f.opFail()
}

func (f *fakeRepo) CompareFiles(context.Context, string, string) ([]protocol.CommitFile, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.compareFiles, nil
}

func (f *fakeRepo) Conflicts(context.Context) ([]protocol.ConflictEntry, error) {
	if f.err != nil {
		return nil, f.err
	}
	return nil, nil
}

func (f *fakeRepo) Merge(_ context.Context, branch string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.historyCalls = append(f.historyCalls, "merge:"+branch)
	return f.opFail()
}

func (f *fakeRepo) MergeAbort(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.historyCalls = append(f.historyCalls, "merge-abort")
	return f.opFail()
}

func (f *fakeRepo) MergeContinue(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.historyCalls = append(f.historyCalls, "merge-continue")
	return f.opFail()
}

func (f *fakeRepo) Rebase(_ context.Context, upstream string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.historyCalls = append(f.historyCalls, "rebase:"+upstream)
	return f.opFail()
}

func (f *fakeRepo) RebaseAbort(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.historyCalls = append(f.historyCalls, "rebase-abort")
	return f.opFail()
}

func (f *fakeRepo) RebaseContinue(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.historyCalls = append(f.historyCalls, "rebase-continue")
	return f.opFail()
}

func (f *fakeRepo) ResolveConflict(_ context.Context, path string, theirs bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.historyCalls = append(f.historyCalls, "resolve:"+path+":theirs="+boolStr(theirs))
	return f.opFail()
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

func (f *fakeRepo) StagePaths(_ context.Context, paths []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stageOps = append(f.stageOps, paths...)
	return f.opFail()
}

func (f *fakeRepo) UnstagePaths(_ context.Context, paths []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.unstages = append(f.unstages, paths...)
	return f.opFail()
}

func (f *fakeRepo) DiscardTracked(_ context.Context, paths []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.discards = append(f.discards, paths...)
	return f.opFail()
}

func (f *fakeRepo) DeleteUntracked(_ context.Context, paths []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deletes = append(f.deletes, paths...)
	return f.opFail()
}

func (f *fakeRepo) StagePatch(_ context.Context, patch []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.patches = append(f.patches, fakePatchCall{patch: string(patch)})
	return f.opFail()
}

func (f *fakeRepo) UnstagePatch(_ context.Context, patch []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.patches = append(f.patches, fakePatchCall{patch: string(patch), reverse: true})
	return f.opFail()
}

func (f *fakeRepo) Commit(_ context.Context, req protocol.CommitRequest) (protocol.OperationResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.commits = append(f.commits, req)
	if f.commitErr != nil {
		return f.commitRes, f.commitErr
	}
	return f.commitRes, f.err
}

func newSnapshotServer(repo Repo) http.Handler {
	srv, err := New(newTestFS(), Options{Token: testToken, Host: testHost, Repo: repo})
	if err != nil {
		panic(err)
	}
	return srv.Handler()
}

func TestSnapshotRouteReturnsNormalizedJSON(t *testing.T) {
	snap := protocol.RepoSnapshot{
		Root:       "/tmp/repo",
		HeadOID:    "abc123",
		HeadBranch: "main",
		Upstream:   "origin/main",
		Ahead:      2,
		Behind:     1,
		Operation:  protocol.OperationNone,
		Staged: []protocol.FileChange{
			{Path: "staged.txt", Kind: protocol.KindAdded, Scope: protocol.ScopeStaged, Staged: true},
		},
		Unstaged: []protocol.FileChange{
			{Path: "dir/file.txt", Kind: protocol.KindModified, Scope: protocol.ScopeUnstaged},
		},
	}
	h := newSnapshotServer(&fakeRepo{snap: snap})

	req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/snapshot", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	ct := rec.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("content-type = %q, want application/json", ct)
	}

	var got protocol.RepoSnapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.HeadBranch != "main" || got.Ahead != 2 || got.Behind != 1 {
		t.Fatalf("got %+v, want head main ahead 2 behind 1", got)
	}
	if len(got.Staged) != 1 || got.Staged[0].Path != "staged.txt" || !got.Staged[0].Staged {
		t.Fatalf("staged = %+v, want one staged staged.txt", got.Staged)
	}
	if len(got.Unstaged) != 1 || got.Unstaged[0].Path != "dir/file.txt" {
		t.Fatalf("unstaged = %+v, want one dir/file.txt", got.Unstaged)
	}
	if got.Generation == 0 {
		t.Fatal("generation not populated")
	}
}

func TestSnapshotGenerationIncrements(t *testing.T) {
	h := newSnapshotServer(&fakeRepo{snap: protocol.RepoSnapshot{}})

	gen := func() uint64 {
		req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/snapshot", nil)
		req.Host = testHost
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		var got protocol.RepoSnapshot
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		return got.Generation
	}

	g1 := gen()
	g2 := gen()
	if g2 <= g1 {
		t.Fatalf("generation did not advance: g1=%d g2=%d", g1, g2)
	}
}

func TestSnapshotRouteError(t *testing.T) {
	h := newSnapshotServer(&fakeRepo{err: context.Canceled})

	req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/snapshot", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}

func TestSnapshotUnavailableWithoutRepo(t *testing.T) {
	h := newSnapshotServer(nil)

	req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/snapshot", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
}

func TestDiffRouteReturnsFileDiff(t *testing.T) {
	h := newSnapshotServer(&fakeRepo{diff: protocol.FileDiff{
		Before: protocol.FileVersion{Path: "a.txt", Language: "text", Content: "one\n"},
		After:  protocol.FileVersion{Path: "a.txt", Language: "text", Content: "one\ntwo\n"},
	}})

	req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/diff?scope=unstaged&path=a.txt", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var got protocol.FileDiff
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Before.Content != "one\n" || got.After.Content != "one\ntwo\n" {
		t.Fatalf("got %+v, want before one\\n after one\\ntwo\\n", got)
	}
}

func TestDiffRouteMapsInvalidInputTo400(t *testing.T) {
	for _, name := range []error{protocol.ErrInvalidPath, protocol.ErrNotInRepo} {
		h := newSnapshotServer(&fakeRepo{err: name})
		req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/diff?scope=unstaged&path=../escape", nil)
		req.Host = testHost
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%v: status = %d, want %d", name, rec.Code, http.StatusBadRequest)
		}
	}
}

func TestDiffRouteError(t *testing.T) {
	h := newSnapshotServer(&fakeRepo{err: errors.New("boom")})

	req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/diff?scope=unstaged&path=a.txt", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}

func TestDiffUnavailableWithoutRepo(t *testing.T) {
	h := newSnapshotServer(nil)

	req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/diff?scope=unstaged&path=a.txt", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
}

func TestGraphRouteReturnsHistory(t *testing.T) {
	repo := &fakeRepo{graphCommits: []protocol.GraphCommit{
		{
			OID:        "abc123",
			Parents:    []string{"def456"},
			Subject:    "merge feature",
			AuthorName: "Test",
			Refs:       []protocol.CommitRef{{Name: "main", Kind: protocol.RefKindHead}},
		},
	}}
	h := newSnapshotServer(repo)

	req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/graph?skip=50", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var got protocol.GraphPage
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Commits) != 1 || got.Commits[0].OID != "abc123" {
		t.Fatalf("commits = %+v, want one abc123", got.Commits)
	}
	if got.Commits[0].Refs[0].Kind != protocol.RefKindHead {
		t.Fatalf("refs = %+v, want head ref", got.Commits[0].Refs)
	}
}

func TestGraphRouteRejectsBadSkip(t *testing.T) {
	for _, skip := range []string{"abc", "-1", "1.5"} {
		h := newSnapshotServer(&fakeRepo{graphCommits: []protocol.GraphCommit{{OID: "x"}}})
		req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/graph?skip="+skip, nil)
		req.Host = testHost
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("skip=%q status = %d, want %d", skip, rec.Code, http.StatusBadRequest)
		}
	}
}

func TestGraphRouteError(t *testing.T) {
	h := newSnapshotServer(&fakeRepo{err: errors.New("boom")})
	req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/graph", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}

func TestCommitFilesRouteReturnsFiles(t *testing.T) {
	repo := &fakeRepo{graphFiles: []protocol.CommitFile{
		{Path: "c.txt", OldPath: "a.txt", Kind: protocol.KindRenamed},
	}}
	h := newSnapshotServer(repo)

	req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/commit/abc123/files", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var got protocol.CommitFiles
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Files) != 1 || got.Files[0].Path != "c.txt" || got.Files[0].OldPath != "a.txt" {
		t.Fatalf("files = %+v, want renamed c.txt from a.txt", got.Files)
	}
}

func TestCommitFilesRouteMapsInvalidRefTo400(t *testing.T) {
	h := newSnapshotServer(&fakeRepo{err: protocol.ErrInvalidRef})
	req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/commit/-oops/files", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestCommitFilesRouteError(t *testing.T) {
	h := newSnapshotServer(&fakeRepo{err: errors.New("boom")})
	req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/commit/abc123/files", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}

func TestBranchesRouteReturnsList(t *testing.T) {
	repo := &fakeRepo{branches: []protocol.Branch{
		{Name: "main", OID: "abc", Current: true, Upstream: "origin/main", Ahead: 1},
		{Name: "origin/main", OID: "abc", Remote: true},
	}}
	h := newSnapshotServer(repo)
	req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/branches", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var got []protocol.Branch
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("branches = %+v, want 2", got)
	}
	if got[0].Name != "main" || !got[0].Current || got[0].Upstream != "origin/main" || got[0].Ahead != 1 {
		t.Fatalf("branches[0] = %+v", got[0])
	}
	if got[1].Name != "origin/main" || !got[1].Remote {
		t.Fatalf("branches[1] = %+v", got[1])
	}
}

func TestBranchesRouteError(t *testing.T) {
	h := newSnapshotServer(&fakeRepo{err: errors.New("boom")})
	req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/branches", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}

func TestBranchesRouteUnavailableWithoutRepo(t *testing.T) {
	h := newSnapshotServer(nil)
	req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/branches", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
}
