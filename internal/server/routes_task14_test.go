package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
)

func TestOperationMergeAndRebaseOps(t *testing.T) {
	repo := &fakeRepo{}
	for _, tc := range []struct {
		op   string
		req  mutationRequest
		want string
	}{
		{OpMerge, mutationRequest{Name: "feature"}, "merge:feature"},
		{OpMergeAbort, mutationRequest{}, "merge-abort"},
		{OpMergeContinue, mutationRequest{}, "merge-continue"},
		{OpRebase, mutationRequest{Name: "main"}, "rebase:main"},
		{OpRebaseAbort, mutationRequest{}, "rebase-abort"},
		{OpRebaseContinue, mutationRequest{}, "rebase-continue"},
		{OpCherryPickAbort, mutationRequest{}, "cherry-pick-abort"},
		{OpCherryPickContinue, mutationRequest{}, "cherry-pick-continue"},
		{OpRevertAbort, mutationRequest{}, "revert-abort"},
		{OpRevertContinue, mutationRequest{}, "revert-continue"},
		{OpResolveOurs, mutationRequest{Paths: []string{"a.txt"}}, "resolve:a.txt:theirs=false"},
		{OpResolveTheirs, mutationRequest{Paths: []string{"a.txt"}}, "resolve:a.txt:theirs=true"},
		{OpResolveBoth, mutationRequest{Paths: []string{"a.txt"}}, "resolve-both:a.txt"},
	} {
		rec := postOperation(t, repo, tc.op, tc.req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200 (%s)", tc.op, rec.Code, rec.Body)
		}
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if !reflect.DeepEqual(repo.historyCalls, []string{
		"merge:feature",
		"merge-abort",
		"merge-continue",
		"rebase:main",
		"rebase-abort",
		"rebase-continue",
		"cherry-pick-abort",
		"cherry-pick-continue",
		"revert-abort",
		"revert-continue",
		"resolve:a.txt:theirs=false",
		"resolve:a.txt:theirs=true",
		"resolve-both:a.txt",
	}) {
		t.Fatalf("historyCalls = %v", repo.historyCalls)
	}
}

func TestOperationConflictResolutionRequiresOnePath(t *testing.T) {
	for _, op := range []string{OpResolveOurs, OpResolveTheirs, OpResolveBoth} {
		for _, paths := range [][]string{nil, {}, {"a.txt", "b.txt"}} {
			repo := &fakeRepo{}
			rec := postOperation(t, repo, op, mutationRequest{Paths: paths})
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("%s paths=%v: status = %d, want 400 (%s)", op, paths, rec.Code, rec.Body)
			}
			var body map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body["code"] != "invalid-path-count" {
				t.Fatalf("%s paths=%v: code = %v, want invalid-path-count", op, paths, body["code"])
			}
			repo.mu.Lock()
			calls := append([]string(nil), repo.historyCalls...)
			repo.mu.Unlock()
			if len(calls) != 0 {
				t.Fatalf("%s paths=%v: repository calls = %v, want none", op, paths, calls)
			}
		}
	}
}

func TestOperationMergeAndRebaseErrors(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		op   string
		req  mutationRequest
		want int
		code string
	}{
		{"already in progress", gitx.ErrAlreadyInProgress, OpMerge, mutationRequest{Name: "feature"}, http.StatusConflict, "already-in-progress"},
		{"rebase already in progress", gitx.ErrAlreadyInProgress, OpRebase, mutationRequest{Name: "main"}, http.StatusConflict, "already-in-progress"},
		{"merge conflict", gitx.ErrConflict, OpMergeContinue, mutationRequest{}, http.StatusConflict, "conflict"},
		{"rebase conflict", gitx.ErrConflict, OpRebaseContinue, mutationRequest{}, http.StatusConflict, "conflict"},
		{"bad ref", protocol.ErrInvalidRef, OpMerge, mutationRequest{Name: "bad..ref"}, http.StatusBadRequest, ""},
	} {
		repo := &fakeRepo{err: tc.err}
		rec := postOperation(t, repo, tc.op, tc.req)
		if rec.Code != tc.want {
			t.Fatalf("%s: status = %d, want %d (%s)", tc.name, rec.Code, tc.want, rec.Body)
		}
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s: unmarshal: %v", tc.name, err)
		}
		if tc.code == "" {
			if body["code"] != nil {
				t.Fatalf("%s: code = %v, want absent", tc.name, body["code"])
			}
		} else if body["code"] != tc.code {
			t.Fatalf("%s: code = %v, want %q", tc.name, body["code"], tc.code)
		}
	}
}

func TestConflictsRouteReturnsList(t *testing.T) {
	repo := &fakeRepo{}
	h := newSnapshotServer(repo)

	req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/conflicts", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got []protocol.ConflictEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty conflicts, got %+v", got)
	}
}

func TestConflictsRouteUnavailableWithoutRepo(t *testing.T) {
	h := newSnapshotServer(nil)
	req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/conflicts", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}
