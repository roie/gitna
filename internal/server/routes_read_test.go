package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

type fakeRepo struct {
	snap            protocol.RepoSnapshot
	err             error
	diff            protocol.FileDiff
	review          protocol.ReviewResponse
	reviewNextAfter string
	files           protocol.RepositoryFiles
	directory       protocol.DirectoryEntries
	search          protocol.FileSearchResults
	searchRecent    []string
	searchRefresh   bool

	graphCommits []protocol.GraphCommit
	graphFiles   []protocol.CommitFile
	graphStats   protocol.CommitStats
	branches     []protocol.Branch
	stashes      []protocol.StashEntry
	tags         []protocol.Tag
	compareFiles []protocol.CommitFile

	mu            sync.Mutex
	stageOps      []string
	unstages      []string
	discards      []string
	deletes       []string
	pathCallSizes []int
	patches       []fakePatchCall
	commits       []protocol.CommitRequest
	commitRes     protocol.OperationResult
	commitErr     error
	opErr         error

	branchCalls  []string
	branchForces []bool
	syncCalls    []string
	stashCalls   []string
	tagCalls     []string
	historyCalls []string
	resetModes   []string
	compareCalls []string
	reviewCalls  []protocol.ReviewIdentity
	reviewAfters []string
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

func (f *fakeRepo) RepositoryFiles(context.Context, string, int) (protocol.RepositoryFiles, error) {
	if f.err != nil {
		return protocol.RepositoryFiles{}, f.err
	}
	return f.files, nil
}

func (f *fakeRepo) DirectoryEntries(context.Context, string, string, int) (protocol.DirectoryEntries, error) {
	if f.err != nil {
		return protocol.DirectoryEntries{}, f.err
	}
	return f.directory, nil
}

func (f *fakeRepo) SearchFiles(_ context.Context, _ string, recent []string, refresh bool, _ int) (protocol.FileSearchResults, error) {
	if f.err != nil {
		return protocol.FileSearchResults{}, f.err
	}
	f.searchRecent = append([]string(nil), recent...)
	f.searchRefresh = refresh
	return f.search, nil
}

func (f *fakeRepo) Diff(context.Context, protocol.DiffScope, protocol.DiffOptions) (protocol.FileDiff, error) {
	if f.err != nil {
		return protocol.FileDiff{}, f.err
	}
	return f.diff, nil
}

func (f *fakeRepo) Review(_ context.Context, scope protocol.DiffScope, opts protocol.DiffOptions, after string) (protocol.ReviewPage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reviewCalls = append(f.reviewCalls, protocol.ReviewIdentity{
		Scope:       scope,
		Commit:      opts.Commit,
		CompareFrom: opts.CompareFrom,
		CompareTo:   opts.CompareTo,
	})
	f.reviewAfters = append(f.reviewAfters, after)
	if f.err != nil {
		return protocol.ReviewPage{}, f.err
	}
	return protocol.ReviewPage{Response: f.review, NextAfter: f.reviewNextAfter}, nil
}

func (f *fakeRepo) History(context.Context, int, int) ([]protocol.GraphCommit, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.graphCommits, nil
}

func (f *fakeRepo) FilesChanged(context.Context, string) (protocol.CommitFiles, error) {
	if f.err != nil {
		return protocol.CommitFiles{}, f.err
	}
	return protocol.CommitFiles{Files: f.graphFiles, Stats: f.graphStats}, nil
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

func (f *fakeRepo) CherryPickAbort(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.historyCalls = append(f.historyCalls, "cherry-pick-abort")
	return f.opFail()
}

func (f *fakeRepo) CherryPickContinue(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.historyCalls = append(f.historyCalls, "cherry-pick-continue")
	return f.opFail()
}

func (f *fakeRepo) Revert(_ context.Context, ref string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.historyCalls = append(f.historyCalls, "revert:"+ref)
	return f.opFail()
}

func (f *fakeRepo) RevertAbort(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.historyCalls = append(f.historyCalls, "revert-abort")
	return f.opFail()
}

func (f *fakeRepo) RevertContinue(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.historyCalls = append(f.historyCalls, "revert-continue")
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

func (f *fakeRepo) ResolveConflictBoth(_ context.Context, path string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.historyCalls = append(f.historyCalls, "resolve-both:"+path)
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
	f.pathCallSizes = append(f.pathCallSizes, len(paths))
	f.stageOps = append(f.stageOps, paths...)
	return f.opFail()
}

func (f *fakeRepo) UnstagePaths(_ context.Context, paths []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pathCallSizes = append(f.pathCallSizes, len(paths))
	f.unstages = append(f.unstages, paths...)
	return f.opFail()
}

func (f *fakeRepo) DiscardTracked(_ context.Context, paths []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pathCallSizes = append(f.pathCallSizes, len(paths))
	f.discards = append(f.discards, paths...)
	return f.opFail()
}

func (f *fakeRepo) DeleteUntracked(_ context.Context, paths []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pathCallSizes = append(f.pathCallSizes, len(paths))
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
	srv, err := New(newTestFS(), Options{
		Version: "test-version",
		Token:   testToken,
		Host:    testHost,
		Repo:    repo,
	})
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

	req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/snapshot", nil)
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
	if got.AppVersion != "test-version" {
		t.Fatalf("app version = %q, want test-version", got.AppVersion)
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

func TestFileSearchRouteReturnsBoundedResults(t *testing.T) {
	repo := &fakeRepo{search: protocol.FileSearchResults{
		Complete: true,
		Results:  []protocol.FileSearchResult{{Path: "src/main.go", Name: "main.go", Parent: "src"}},
	}}
	h := newSnapshotServer(repo)
	req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/files/search?q=main&recent=docs%2Fmain.go&recent=src%2Fmain.go&refresh=1", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body.String())
	}
	var got protocol.FileSearchResults
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.Complete || len(got.Results) != 1 || got.Results[0].Path != "src/main.go" {
		t.Fatalf("results = %#v", got)
	}
	if !repo.searchRefresh || !reflect.DeepEqual(repo.searchRecent, []string{"docs/main.go", "src/main.go"}) {
		t.Fatalf("refresh=%t recent=%#v", repo.searchRefresh, repo.searchRecent)
	}
}

func TestDirectoryEntriesRouteUsesOpaqueCursor(t *testing.T) {
	h := newSnapshotServer(&fakeRepo{directory: protocol.DirectoryEntries{
		Directory:  "src",
		Entries:    []protocol.DirectoryEntry{{Name: "main.go", Path: "src/main.go", Kind: protocol.DirectoryEntryFile}},
		Truncated:  true,
		NextCursor: "main.go",
	}})
	req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/directory?path=src", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body.String())
	}
	var got protocol.DirectoryEntries
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.NextCursor == "" || got.NextCursor == "main.go" {
		t.Fatalf("cursor = %q, want opaque", got.NextCursor)
	}

	bad := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/directory?cursor=not%20base64!", nil)
	bad.Host = testHost
	badRec := httptest.NewRecorder()
	h.ServeHTTP(badRec, bad)
	if badRec.Code != http.StatusBadRequest {
		t.Fatalf("bad cursor status = %d", badRec.Code)
	}
}

func TestRepositoryFilesRouteReturnsExplorerPaths(t *testing.T) {
	h := newSnapshotServer(&fakeRepo{files: protocol.RepositoryFiles{
		Paths:        []string{".env", "ignored/generated.js", "src/main.go"},
		IgnoredPaths: []string{"ignored/generated.js"},
		Truncated:    true,
	}})

	req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/files", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var got protocol.RepositoryFiles
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Generation == 0 || !got.Truncated || len(got.Paths) != 3 {
		t.Fatalf("files = %+v", got)
	}
	if len(got.IgnoredPaths) != 1 || got.IgnoredPaths[0] != "ignored/generated.js" {
		t.Fatalf("ignored paths = %#v", got.IgnoredPaths)
	}
}

func TestSnapshotFileLimit(t *testing.T) {
	request := func(snap protocol.RepoSnapshot) *httptest.ResponseRecorder {
		h := newSnapshotServer(&fakeRepo{snap: snap})
		req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/snapshot", nil)
		req.Host = testHost
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	exact := protocol.RepoSnapshot{Staged: make([]protocol.FileChange, snapshotFileLimit)}
	if rec := request(exact); rec.Code != http.StatusOK {
		t.Fatalf("exact limit status = %d, want 200 (%s)", rec.Code, rec.Body)
	}

	over := protocol.RepoSnapshot{
		Staged:    make([]protocol.FileChange, 4_000),
		Unstaged:  make([]protocol.FileChange, 4_000),
		Conflicts: make([]protocol.ConflictEntry, 2_001),
	}
	rec := request(over)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("over limit status = %d, want 413 (%s)", rec.Code, rec.Body)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["code"] != "snapshot-too-large" || body["limit"] != float64(snapshotFileLimit) || body["count"] != float64(snapshotFileLimit+1) {
		t.Fatalf("body = %#v, want snapshot-too-large with limit/count", body)
	}
}

type snapshotRaceRepo struct {
	*fakeRepo
	onFirstSnapshot func()
	calls           int
}

func (r *snapshotRaceRepo) Snapshot(context.Context) (protocol.RepoSnapshot, error) {
	r.calls++
	if r.calls == 1 {
		r.onFirstSnapshot()
		return protocol.RepoSnapshot{HeadBranch: "stale"}, nil
	}
	return protocol.RepoSnapshot{HeadBranch: "fresh"}, nil
}

func TestSnapshotGenerationStableWithoutInvalidation(t *testing.T) {
	h := newSnapshotServer(&fakeRepo{snap: protocol.RepoSnapshot{}})

	gen := func() uint64 {
		req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/snapshot", nil)
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
	if g2 != g1 {
		t.Fatalf("unchanged reads advanced generation: g1=%d g2=%d", g1, g2)
	}
}

func TestSnapshotRetriesWhenGenerationChangesDuringRead(t *testing.T) {
	repo := &snapshotRaceRepo{fakeRepo: &fakeRepo{}}
	srv, err := New(newTestFS(), Options{Token: testToken, Host: testHost, Repo: repo})
	if err != nil {
		t.Fatal(err)
	}
	repo.onFirstSnapshot = func() { srv.gen.Add(1) }

	req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/snapshot", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var got protocol.RepoSnapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if repo.calls != 2 || got.HeadBranch != "fresh" || got.Generation != 2 {
		t.Fatalf("calls=%d snapshot=%+v, want retried fresh generation 2", repo.calls, got)
	}
}

func TestSnapshotRouteError(t *testing.T) {
	h := newSnapshotServer(&fakeRepo{err: errors.New("disk failure")})

	req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/snapshot", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}

func TestSnapshotUnavailableWithoutRepo(t *testing.T) {
	h := newSnapshotServer(nil)

	req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/snapshot", nil)
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
		Patch:  "full patch",
	}})

	req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/diff?scope=unstaged&path=a.txt", nil)
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
	if got.PatchID == "" {
		t.Fatal("mutable diff did not receive a patch identity")
	}
}

func TestDiffRouteMapsInvalidInputTo400(t *testing.T) {
	for _, name := range []error{protocol.ErrInvalidPath, protocol.ErrNotInRepo} {
		h := newSnapshotServer(&fakeRepo{err: name})
		req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/diff?scope=unstaged&path=../escape", nil)
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

	req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/diff?scope=unstaged&path=a.txt", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}

func TestDiffUnavailableWithoutRepo(t *testing.T) {
	h := newSnapshotServer(nil)

	req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/diff?scope=unstaged&path=a.txt", nil)
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

	req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/graph?skip=50", nil)
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
		req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/graph?skip="+skip, nil)
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
	req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/graph", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}

func TestCommitFilesRouteReturnsFiles(t *testing.T) {
	repo := &fakeRepo{
		graphFiles: []protocol.CommitFile{
			{Path: "c.txt", OldPath: "a.txt", Kind: protocol.KindRenamed},
		},
		graphStats: protocol.CommitStats{Files: 1, Additions: 12, Deletions: 3},
	}
	h := newSnapshotServer(repo)

	req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/commit/abc123/files", nil)
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
	if got.Stats.Files != 1 || got.Stats.Additions != 12 || got.Stats.Deletions != 3 {
		t.Fatalf("stats = %+v", got.Stats)
	}
}

func TestCommitFilesRouteMapsInvalidRefTo400(t *testing.T) {
	h := newSnapshotServer(&fakeRepo{err: protocol.ErrInvalidRef})
	req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/commit/-oops/files", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestCommitFilesRouteError(t *testing.T) {
	h := newSnapshotServer(&fakeRepo{err: errors.New("boom")})
	req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/commit/abc123/files", nil)
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
	req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/branches", nil)
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
	req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/branches", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}

func TestBranchesRouteUnavailableWithoutRepo(t *testing.T) {
	h := newSnapshotServer(nil)
	req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/branches", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
}

func TestReviewRouteScopes(t *testing.T) {
	tests := []struct {
		name string
		path string
		want protocol.ReviewIdentity
	}{
		{name: "unstaged", path: "/api/v1/review?scope=unstaged", want: protocol.ReviewIdentity{Scope: protocol.DiffUnstaged}},
		{name: "staged", path: "/api/v1/review?scope=staged", want: protocol.ReviewIdentity{Scope: protocol.DiffStaged}},
		{name: "commit", path: "/api/v1/review?scope=commit&commit=abc123", want: protocol.ReviewIdentity{Scope: protocol.DiffCommit, Commit: "abc123"}},
		{name: "compare", path: "/api/v1/review?scope=compare&from=main&to=topic", want: protocol.ReviewIdentity{Scope: protocol.DiffCompare, CompareFrom: "main", CompareTo: "topic"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			repo := &fakeRepo{review: protocol.ReviewResponse{Identity: tc.want, Patch: "patch"}}
			h := newSnapshotServer(repo)
			req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+tc.path, nil)
			req.Host = testHost
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
			}
			var got protocol.ReviewResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if len(repo.reviewCalls) != 1 || repo.reviewCalls[0] != tc.want {
				t.Fatalf("review calls = %+v, want %+v", repo.reviewCalls, tc.want)
			}
			if got.Generation != 1 || got.Patch != "patch" || got.Identity != tc.want {
				t.Fatalf("review = %+v", got)
			}
		})
	}
}

func TestReviewRouteRejectsInvalidScope(t *testing.T) {
	invalidRepo := &fakeRepo{}
	h := newSnapshotServer(invalidRepo)
	req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/review?scope=conflict", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || len(invalidRepo.reviewCalls) != 0 {
		t.Fatalf("invalid status=%d calls=%d", rec.Code, len(invalidRepo.reviewCalls))
	}
}

func TestReviewCursorContinuesOneGeneration(t *testing.T) {
	repo := &fakeRepo{
		review:          protocol.ReviewResponse{Supplements: []protocol.ReviewSupplement{{Path: "a.txt"}}},
		reviewNextAfter: "a.txt\x00",
	}
	srv, err := New(newTestFS(), Options{Token: testToken, Host: testHost, Repo: repo})
	if err != nil {
		t.Fatal(err)
	}
	handler := srv.Handler()
	request := func(rawURL string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, rawURL, nil)
		req.Host = testHost
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	first := request("/g/" + testToken + "/api/v1/review?scope=unstaged")
	if first.Code != http.StatusOK {
		t.Fatalf("first status=%d body=%s", first.Code, first.Body)
	}
	var response protocol.ReviewResponse
	if err := json.Unmarshal(first.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.NextCursor == "" {
		t.Fatal("first page missing next cursor")
	}

	repo.reviewNextAfter = ""
	second := request("/g/" + testToken + "/api/v1/review?scope=unstaged&cursor=" + url.QueryEscape(response.NextCursor))
	if second.Code != http.StatusOK {
		t.Fatalf("second status=%d body=%s", second.Code, second.Body)
	}
	if len(repo.reviewAfters) != 2 || repo.reviewAfters[1] != "a.txt\x00" {
		t.Fatalf("review afters=%q", repo.reviewAfters)
	}

	srv.gen.Add(1)
	stale := request("/g/" + testToken + "/api/v1/review?scope=unstaged&cursor=" + url.QueryEscape(response.NextCursor))
	if stale.Code != http.StatusConflict || !strings.Contains(stale.Body.String(), "review-invalidated") {
		t.Fatalf("stale status=%d body=%s", stale.Code, stale.Body)
	}
	if len(repo.reviewAfters) != 2 {
		t.Fatalf("stale cursor reached repository: %q", repo.reviewAfters)
	}
}

func TestReviewRejectsInvalidOrMismatchedCursor(t *testing.T) {
	repo := &fakeRepo{}
	srv, err := New(newTestFS(), Options{Token: testToken, Host: testHost, Repo: repo})
	if err != nil {
		t.Fatal(err)
	}
	cursor, err := encodeReviewCursor(reviewCursor{Version: 1, Generation: 1, Scope: protocol.DiffStaged, After: "a.txt\x00"})
	if err != nil {
		t.Fatal(err)
	}
	for _, rawCursor := range []string{"not-a-cursor", cursor} {
		req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/review?scope=unstaged&cursor="+url.QueryEscape(rawCursor), nil)
		req.Host = testHost
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid-review-cursor") {
			t.Fatalf("cursor %q status=%d body=%s", rawCursor, rec.Code, rec.Body)
		}
	}
	if len(repo.reviewCalls) != 0 {
		t.Fatalf("invalid cursor reached repository: %+v", repo.reviewCalls)
	}
}

type reviewRaceRepo struct {
	*fakeRepo
	onFirstReview func()
	calls         int
}

func (r *reviewRaceRepo) Review(context.Context, protocol.DiffScope, protocol.DiffOptions, string) (protocol.ReviewPage, error) {
	r.calls++
	if r.calls == 1 {
		r.onFirstReview()
		return protocol.ReviewPage{Response: protocol.ReviewResponse{Patch: "stale"}}, nil
	}
	return protocol.ReviewPage{Response: protocol.ReviewResponse{Patch: "fresh"}}, nil
}

func TestReviewRetriesWhenGenerationChangesDuringRead(t *testing.T) {
	repo := &reviewRaceRepo{fakeRepo: &fakeRepo{}}
	srv, err := New(newTestFS(), Options{Token: testToken, Host: testHost, Repo: repo})
	if err != nil {
		t.Fatal(err)
	}
	repo.onFirstReview = func() { srv.gen.Add(1) }

	req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/review?scope=unstaged", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var got protocol.ReviewResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if repo.calls != 2 || got.Patch != "fresh" || got.Generation != 2 {
		t.Fatalf("calls=%d review=%+v, want retried fresh generation 2", repo.calls, got)
	}
}
