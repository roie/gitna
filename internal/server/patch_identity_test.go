package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

func postPatchWithIdentity(t *testing.T, srv *Server, request mutationRequest) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	if err := json.NewEncoder(&body).Encode(request); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/g/"+testToken+"/api/v1/operations?op="+OpPatch, &body)
	req.Host = testHost
	req.Header.Set("Origin", "http://"+testHost)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

func newPatchTestServer(t *testing.T, repo Repo) *Server {
	t.Helper()
	srv, err := New(newTestFS(), Options{Token: testToken, Host: testHost, Repo: repo})
	if err != nil {
		t.Fatal(err)
	}
	return srv
}

func TestPatchIdentityRejectsTampering(t *testing.T) {
	srv := newPatchTestServer(t, &fakeRepo{})
	identity, err := srv.issuePatchIdentity(srv.gen.Load(), protocol.DiffUnstaged, "a.txt", "full patch")
	if err != nil {
		t.Fatal(err)
	}
	replacement := byte('A')
	if identity[len(identity)-1] == replacement {
		replacement = 'B'
	}
	identity = identity[:len(identity)-1] + string(replacement)
	if _, err := srv.verifyPatchIdentity(identity); err == nil {
		t.Fatal("tampered identity verified")
	}
}

func TestPatchMutationRejectsStaleGenerationEvenWhenPatchMatches(t *testing.T) {
	const patch = "full patch"
	repo := &fakeRepo{diff: protocol.FileDiff{Patch: patch}}
	srv := newPatchTestServer(t, repo)
	identity, err := srv.issuePatchIdentity(srv.gen.Load(), protocol.DiffUnstaged, "a.txt", patch)
	if err != nil {
		t.Fatal(err)
	}
	srv.gen.Add(1)

	rec := postPatchWithIdentity(t, srv, mutationRequest{
		Patch: patch, PatchID: identity, PatchScope: protocol.DiffUnstaged, PatchPath: "a.txt",
	})
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if calls := recordedMutationCalls(repo); calls != 0 {
		t.Fatalf("repository mutation calls = %d, want none", calls)
	}
}

func TestPatchMutationRejectsChangedAuthoritativeDiff(t *testing.T) {
	repo := &fakeRepo{diff: protocol.FileDiff{Patch: "old full patch"}}
	srv := newPatchTestServer(t, repo)
	identity, err := srv.issuePatchIdentity(srv.gen.Load(), protocol.DiffUnstaged, "a.txt", repo.diff.Patch)
	if err != nil {
		t.Fatal(err)
	}
	repo.diff.Patch = "new full patch"

	rec := postPatchWithIdentity(t, srv, mutationRequest{
		Patch: "old partial patch", PatchID: identity, PatchScope: protocol.DiffUnstaged, PatchPath: "a.txt",
	})
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if calls := recordedMutationCalls(repo); calls != 0 {
		t.Fatalf("repository mutation calls = %d, want none", calls)
	}
}

func TestPatchMutationAcceptsPartialPatchForCurrentFullDiff(t *testing.T) {
	const fullPatch = "file header\nhunk one\nhunk two\n"
	const partialPatch = "file header\nhunk two\n"
	repo := &fakeRepo{diff: protocol.FileDiff{Patch: fullPatch}}
	srv := newPatchTestServer(t, repo)
	identity, err := srv.issuePatchIdentity(srv.gen.Load(), protocol.DiffUnstaged, "a.txt", fullPatch)
	if err != nil {
		t.Fatal(err)
	}

	rec := postPatchWithIdentity(t, srv, mutationRequest{
		Patch: partialPatch, PatchID: identity, PatchScope: protocol.DiffUnstaged, PatchPath: "a.txt",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.patches) != 1 || repo.patches[0].patch != partialPatch {
		t.Fatalf("patches = %+v, want accepted partial patch", repo.patches)
	}
}

func TestPatchMutationRejectsScopeDirectionMismatch(t *testing.T) {
	const patch = "full patch"
	repo := &fakeRepo{diff: protocol.FileDiff{Patch: patch}}
	srv := newPatchTestServer(t, repo)
	identity, err := srv.issuePatchIdentity(srv.gen.Load(), protocol.DiffStaged, "a.txt", patch)
	if err != nil {
		t.Fatal(err)
	}

	rec := postPatchWithIdentity(t, srv, mutationRequest{
		Patch: patch, PatchID: identity, PatchScope: protocol.DiffStaged, PatchPath: "a.txt", Reverse: false,
	})
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
}
