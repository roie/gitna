package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
)

func postOperation(t *testing.T, repo Repo, op string, body any) *httptest.ResponseRecorder {
	t.Helper()
	h := newSnapshotServer(repo)
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest(http.MethodPost, "/s/"+testToken+"/api/v1/operations?op="+op, &buf)
	req.Host = testHost
	req.Header.Set("Origin", "http://"+testHost)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestOperationStagePaths(t *testing.T) {
	repo := &fakeRepo{}
	rec := postOperation(t, repo, OpStage, mutationRequest{Paths: []string{"a.txt", "dir/b.txt"}})

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (%s)", rec.Code, http.StatusOK, rec.Body)
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.stageOps) != 2 || repo.stageOps[0] != "a.txt" || repo.stageOps[1] != "dir/b.txt" {
		t.Fatalf("staged = %v, want [a.txt dir/b.txt]", repo.stageOps)
	}
	if len(repo.unstages)+len(repo.discards)+len(repo.deletes)+len(repo.patches) != 0 {
		t.Fatalf("unrelated ops recorded: unstage=%v discard=%v delete=%v patch=%v",
			repo.unstages, repo.discards, repo.deletes, repo.patches)
	}
}

func TestOperationUnstageDiscardDelete(t *testing.T) {
	repo := &fakeRepo{}
	for _, tc := range []struct {
		op    string
		paths []string
		field func() []string
	}{
		{OpUnstage, []string{"s.txt"}, func() []string { return repo.unstages }},
		{OpDiscard, []string{"d.txt"}, func() []string { return repo.discards }},
		{OpDelete, []string{"u.txt"}, func() []string { return repo.deletes }},
	} {
		rec := postOperation(t, repo, tc.op, mutationRequest{Paths: tc.paths})
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d, want %d", tc.op, rec.Code, http.StatusOK)
		}
		repo.mu.Lock()
		got := tc.field()
		repo.mu.Unlock()
		if len(got) != 1 || got[0] != tc.paths[0] {
			t.Fatalf("%s paths = %v, want %v", tc.op, got, tc.paths)
		}
	}
}

func TestOperationPatchStagesAndUnstages(t *testing.T) {
	repo := &fakeRepo{}
	patch := "diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-x\n+x\n"

	if rec := postOperation(t, repo, OpPatch, mutationRequest{Patch: patch}); rec.Code != http.StatusOK {
		t.Fatalf("stage patch status = %d, want %d", rec.Code, http.StatusOK)
	}
	if rec := postOperation(t, repo, OpPatch, mutationRequest{Patch: patch, Reverse: true}); rec.Code != http.StatusOK {
		t.Fatalf("unstage patch status = %d, want %d", rec.Code, http.StatusOK)
	}

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.patches) != 2 {
		t.Fatalf("patches = %v, want 2 recorded", repo.patches)
	}
	if repo.patches[0].patch != patch || repo.patches[0].reverse {
		t.Fatalf("patch[0] = %+v, want forward patch", repo.patches[0])
	}
	if repo.patches[1].patch != patch || !repo.patches[1].reverse {
		t.Fatalf("patch[1] = %+v, want reverse patch", repo.patches[1])
	}
}

func TestOperationMapsSentinelErrors(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want int
	}{
		{"invalid path", protocol.ErrInvalidPath, http.StatusBadRequest},
		{"escapes repo", protocol.ErrNotInRepo, http.StatusBadRequest},
		{"stale patch", gitx.ErrPatchDoesNotApply, http.StatusConflict},
		{"other", errors.New("boom"), http.StatusInternalServerError},
	} {
		repo := &fakeRepo{err: tc.err}
		rec := postOperation(t, repo, OpStage, mutationRequest{Paths: []string{"a.txt"}})
		if rec.Code != tc.want {
			t.Fatalf("%s: status = %d, want %d", tc.name, rec.Code, tc.want)
		}
	}
}

func TestOperationRejectsBadRequests(t *testing.T) {
	repo := &fakeRepo{}

	rec := postOperation(t, repo, "no-such-op", mutationRequest{Paths: []string{"a.txt"}})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown op status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	req := httptest.NewRequest(http.MethodPost, "/s/"+testToken+"/api/v1/operations?op="+OpStage, strings.NewReader("{not json"))
	req.Host = testHost
	req.Header.Set("Origin", "http://"+testHost)
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	newSnapshotServer(repo).ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad json status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestOperationUnavailableWithoutRepo(t *testing.T) {
	rec := postOperation(t, nil, OpStage, mutationRequest{Paths: []string{"a.txt"}})
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
}
