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

func TestOperationStashOps(t *testing.T) {
	repo := &fakeRepo{}
	for _, tc := range []struct {
		op   string
		req  mutationRequest
		want string
	}{
		{OpStashPush, mutationRequest{Message: "wip", IncludeUntracked: true}, "push:wip:untracked=true"},
		{OpStashPush, mutationRequest{Message: "plain"}, "push:plain:untracked=false"},
		{OpStashApply, mutationRequest{Ref: "stash@{0}"}, "apply:stash@{0}"},
		{OpStashPop, mutationRequest{Ref: "stash@{1}"}, "pop:stash@{1}"},
		{OpStashDrop, mutationRequest{Ref: "stash@{0}"}, "drop:stash@{0}"},
	} {
		rec := postOperation(t, repo, tc.op, tc.req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200 (%s)", tc.op, rec.Code, rec.Body)
		}
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if !reflect.DeepEqual(repo.stashCalls, []string{
		"push:wip:untracked=true",
		"push:plain:untracked=false",
		"apply:stash@{0}",
		"pop:stash@{1}",
		"drop:stash@{0}",
	}) {
		t.Fatalf("stashCalls = %v", repo.stashCalls)
	}
}

func TestOperationTagOps(t *testing.T) {
	repo := &fakeRepo{}
	tests := []struct {
		op   string
		req  mutationRequest
		want string
	}{
		{OpTagCreate, mutationRequest{Name: "v1", Start: "main"}, "create:v1:main:"},
		{OpTagCreate, mutationRequest{Name: "v1", Start: "main", Message: "release one"}, "create:v1:main:release one"},
		{OpTagDelete, mutationRequest{Name: "v1"}, "delete:v1"},
		{OpTagPush, mutationRequest{Name: "v1", Remote: "origin"}, "push:origin:v1"},
	}
	for _, tc := range tests {
		rec := postOperation(t, repo, tc.op, tc.req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200 (%s)", tc.op, rec.Code, rec.Body)
		}
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if !reflect.DeepEqual(repo.tagCalls, []string{
		"create:v1:main:",
		"create:v1:main:release one",
		"delete:v1",
		"push:origin:v1",
	}) {
		t.Fatalf("tagCalls = %v", repo.tagCalls)
	}
}

func TestOperationHistoryOps(t *testing.T) {
	repo := &fakeRepo{}
	tests := []struct {
		op  string
		req mutationRequest
	}{
		{OpCherryPick, mutationRequest{Ref: "abc123"}},
		{OpRevert, mutationRequest{Ref: "abc123"}},
		{OpReset, mutationRequest{Ref: "HEAD~2", Mode: "soft"}},
		{OpReset, mutationRequest{Ref: "HEAD~2", Mode: "mixed"}},
		{OpReset, mutationRequest{Ref: "HEAD~2", Mode: "hard"}},
	}
	for _, tc := range tests {
		rec := postOperation(t, repo, tc.op, tc.req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200 (%s)", tc.op, rec.Code, rec.Body)
		}
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if !reflect.DeepEqual(repo.historyCalls, []string{
		"cherry-pick:abc123",
		"revert:abc123",
		"reset:HEAD~2",
		"reset:HEAD~2",
		"reset:HEAD~2",
	}) {
		t.Fatalf("historyCalls = %v", repo.historyCalls)
	}
	if !reflect.DeepEqual(repo.resetModes, []string{"soft", "mixed", "hard"}) {
		t.Fatalf("resetModes = %v", repo.resetModes)
	}
}

func TestOperationMapsTask13Errors(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		op   string
		req  mutationRequest
		want int
		code string
	}{
		{"stash conflict", gitx.ErrStashConflict, OpStashApply, mutationRequest{Ref: "stash@{0}"}, http.StatusConflict, "conflict"},
		{"cherry-pick conflict", gitx.ErrConflict, OpCherryPick, mutationRequest{Ref: "abc"}, http.StatusConflict, "conflict"},
		{"missing stash", gitx.ErrNoStash, OpStashPop, mutationRequest{Ref: "stash@{0}"}, http.StatusNotFound, ""},
		{"missing tag", gitx.ErrNoTag, OpTagDelete, mutationRequest{Name: "v1"}, http.StatusNotFound, ""},
		{"tag exists", gitx.ErrTagExists, OpTagCreate, mutationRequest{Name: "v1"}, http.StatusConflict, "tag-exists"},
		{"invalid reset mode", gitx.ErrInvalidResetMode, OpReset, mutationRequest{Ref: "HEAD", Mode: "nuke"}, http.StatusBadRequest, ""},
	} {
		repo := &fakeRepo{err: tc.err}
		rec := postOperation(t, repo, tc.op, tc.req)
		if rec.Code != tc.want {
			t.Fatalf("%s: status = %d, want %d", tc.name, rec.Code, tc.want)
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

func TestReadStashesTagsAndCompare(t *testing.T) {
	repo := &fakeRepo{
		stashes: []protocol.StashEntry{
			{Ref: "stash@{0}", OID: "aabb", Message: "wip", Branch: "main"},
		},
		tags: []protocol.Tag{
			{Name: "v1", OID: "aabb", Annotated: true},
		},
		compareFiles: []protocol.CommitFile{{Path: "a.txt", Kind: protocol.KindModified}},
	}
	h := newSnapshotServer(repo)

	req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/stashes", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("stashes status = %d, want 200", rec.Code)
	}
	var stashes []protocol.StashEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &stashes); err != nil {
		t.Fatalf("unmarshal stashes: %v", err)
	}
	if len(stashes) != 1 || stashes[0].Message != "wip" {
		t.Fatalf("stashes = %+v", stashes)
	}

	req = httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/tags", nil)
	req.Host = testHost
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("tags status = %d, want 200", rec.Code)
	}
	var tags []protocol.Tag
	if err := json.Unmarshal(rec.Body.Bytes(), &tags); err != nil {
		t.Fatalf("unmarshal tags: %v", err)
	}
	if len(tags) != 1 || tags[0].Name != "v1" || !tags[0].Annotated {
		t.Fatalf("tags = %+v", tags)
	}

	req = httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/compare?from=main&to=HEAD", nil)
	req.Host = testHost
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("compare status = %d, want 200", rec.Code)
	}
	var got protocol.CommitFiles
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal compare: %v", err)
	}
	if len(got.Files) != 1 || got.Files[0].Path != "a.txt" {
		t.Fatalf("compare = %+v", got.Files)
	}
}

func TestCompareRouteValidation(t *testing.T) {
	for _, tc := range []struct {
		name string
		url  string
		repo Repo
		want int
	}{
		{"missing refs", "/s/" + testToken + "/api/v1/compare?from=main", &fakeRepo{}, http.StatusBadRequest},
		{"bad ref", "/s/" + testToken + "/api/v1/compare?from=bad..ref&to=HEAD", &fakeRepo{err: protocol.ErrInvalidRef}, http.StatusBadRequest},
	} {
		h := newSnapshotServer(tc.repo)
		req := httptest.NewRequest(http.MethodGet, tc.url, nil)
		req.Host = testHost
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Fatalf("%s: status = %d, want %d", tc.name, rec.Code, tc.want)
		}
	}
}

func TestCompareUnavailableWithoutRepo(t *testing.T) {
	h := newSnapshotServer(nil)
	req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/compare?from=main&to=HEAD", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}
