package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

type fakeWorktreeRepo struct {
	*fakeRepo
	file          protocol.WorktreeFile
	comparison    protocol.FileDiff
	err           error
	createdPath   string
	createdDir    bool
	renamedSource string
	renamedDest   string
}

func (f *fakeWorktreeRepo) ReadWorktreeFile(context.Context, string) (protocol.WorktreeFile, error) {
	return f.file, f.err
}

func (f *fakeWorktreeRepo) CompareWorktreeFiles(context.Context, string, string) (protocol.FileDiff, error) {
	return f.comparison, f.err
}

func (f *fakeWorktreeRepo) WriteWorktreeFile(_ context.Context, path, content, _ string) (protocol.WorktreeFile, error) {
	if f.err != nil {
		return protocol.WorktreeFile{}, f.err
	}
	f.file = protocol.WorktreeFile{Path: path, Content: content, Hash: "saved"}
	return f.file, nil
}

func (f *fakeWorktreeRepo) CreateWorktreeEntry(_ context.Context, path string, directory bool) error {
	f.createdPath, f.createdDir = path, directory
	return f.err
}

func (f *fakeWorktreeRepo) RenameWorktreeEntry(_ context.Context, source, destination string) error {
	f.renamedSource, f.renamedDest = source, destination
	return f.err
}

func worktreeRequest(t *testing.T, h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "/g/"+testToken+"/api/v1"+path, strings.NewReader(body))
	req.Host = testHost
	req.Header.Set("Origin", "http://"+testHost)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestWorktreeFileRoutesReadAndWrite(t *testing.T) {
	repo := &fakeWorktreeRepo{
		fakeRepo: &fakeRepo{},
		file:     protocol.WorktreeFile{Path: "notes.txt", Content: "before\n", Hash: "before"},
	}
	h := newSnapshotServer(repo)
	read := worktreeRequest(t, h, http.MethodGet, "/worktree/file?path=notes.txt", "")
	if read.Code != http.StatusOK {
		t.Fatalf("read status = %d, body = %s", read.Code, read.Body.String())
	}
	var loaded protocol.WorktreeFile
	if err := json.Unmarshal(read.Body.Bytes(), &loaded); err != nil {
		t.Fatal(err)
	}
	if loaded != repo.file {
		t.Fatalf("loaded = %#v, want %#v", loaded, repo.file)
	}

	write := worktreeRequest(t, h, http.MethodPut, "/worktree/file", `{"path":"notes.txt","content":"after\n","expectedHash":"before"}`)
	if write.Code != http.StatusOK || repo.file.Content != "after\n" {
		t.Fatalf("write status = %d, file = %#v, body = %s", write.Code, repo.file, write.Body.String())
	}
}

func TestWorktreeCompareRoute(t *testing.T) {
	repo := &fakeWorktreeRepo{
		fakeRepo: &fakeRepo{},
		comparison: protocol.FileDiff{
			Before: protocol.FileVersion{Path: "left.txt", Content: "left\n"},
			After:  protocol.FileVersion{Path: "right.txt", Content: "right\n"},
		},
	}
	h := newSnapshotServer(repo)
	rec := worktreeRequest(t, h, http.MethodGet, "/worktree/compare?left=left.txt&right=right.txt", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var comparison protocol.FileDiff
	if err := json.Unmarshal(rec.Body.Bytes(), &comparison); err != nil {
		t.Fatal(err)
	}
	if comparison.Before.Path != "left.txt" || comparison.After.Path != "right.txt" {
		t.Fatalf("comparison = %#v", comparison)
	}
}

func TestWorktreeEntryRoutesCreateAndRename(t *testing.T) {
	repo := &fakeWorktreeRepo{fakeRepo: &fakeRepo{}}
	h := newSnapshotServer(repo)
	created := worktreeRequest(t, h, http.MethodPost, "/worktree/entry", `{"path":"docs","directory":true}`)
	if created.Code != http.StatusOK || repo.createdPath != "docs" || !repo.createdDir {
		t.Fatalf("create status = %d, path = %q, dir = %v", created.Code, repo.createdPath, repo.createdDir)
	}
	renamed := worktreeRequest(t, h, http.MethodPatch, "/worktree/entry", `{"source":"old.txt","destination":"new.txt"}`)
	if renamed.Code != http.StatusOK || repo.renamedSource != "old.txt" || repo.renamedDest != "new.txt" {
		t.Fatalf("rename status = %d, source = %q, destination = %q", renamed.Code, repo.renamedSource, repo.renamedDest)
	}
}

func TestWorktreeRoutesMapConflictsAndUnavailableRepo(t *testing.T) {
	repo := &fakeWorktreeRepo{fakeRepo: &fakeRepo{}, err: protocol.ErrWorktreeConflict}
	rec := worktreeRequest(t, newSnapshotServer(repo), http.MethodPut, "/worktree/file", `{"path":"notes.txt","content":"after","expectedHash":"old"}`)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "stale-file") {
		t.Fatalf("conflict status = %d, body = %s", rec.Code, rec.Body.String())
	}

	unsupported := worktreeRequest(t, newSnapshotServer(&fakeRepo{}), http.MethodGet, "/worktree/file?path=notes.txt", "")
	if unsupported.Code != http.StatusServiceUnavailable {
		t.Fatalf("unavailable status = %d", unsupported.Code)
	}

	repo.err = errors.New("boom")
	failed := worktreeRequest(t, newSnapshotServer(repo), http.MethodPost, "/worktree/entry", `{"path":"new.txt"}`)
	if failed.Code != http.StatusInternalServerError {
		t.Fatalf("failed status = %d", failed.Code)
	}
}
