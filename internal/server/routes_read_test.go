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

	mu       sync.Mutex
	stageOps []string
	unstages []string
	discards []string
	deletes  []string
	patches  []fakePatchCall
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

func (f *fakeRepo) StagePaths(_ context.Context, paths []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stageOps = append(f.stageOps, paths...)
	return f.err
}

func (f *fakeRepo) UnstagePaths(_ context.Context, paths []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.unstages = append(f.unstages, paths...)
	return f.err
}

func (f *fakeRepo) DiscardTracked(_ context.Context, paths []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.discards = append(f.discards, paths...)
	return f.err
}

func (f *fakeRepo) DeleteUntracked(_ context.Context, paths []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deletes = append(f.deletes, paths...)
	return f.err
}

func (f *fakeRepo) StagePatch(_ context.Context, patch []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.patches = append(f.patches, fakePatchCall{patch: string(patch)})
	return f.err
}

func (f *fakeRepo) UnstagePatch(_ context.Context, patch []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.patches = append(f.patches, fakePatchCall{patch: string(patch), reverse: true})
	return f.err
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
