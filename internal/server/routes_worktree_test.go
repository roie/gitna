package server

import (
	"bytes"
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
	lineHistory   protocol.LineHistory
	historyBudget []int64
	fileBlame     protocol.FileBlame
	err           error
	createdPath   string
	createdDir    bool
	renamedSource string
	renamedDest   string
}

func (f *fakeWorktreeRepo) ReadWorktreeFile(context.Context, string, ...int64) (protocol.WorktreeFile, error) {
	return f.file, f.err
}

func (f *fakeWorktreeRepo) CompareWorktreeFiles(context.Context, string, string) (protocol.FileDiff, error) {
	return f.comparison, f.err
}

func (f *fakeWorktreeRepo) LineHistory(_ context.Context, _ string, _ int, budget ...int64) (protocol.LineHistory, error) {
	f.historyBudget = budget
	return f.lineHistory, f.err
}

func (f *fakeWorktreeRepo) FileBlame(_ context.Context, _ string, budget ...int64) (protocol.FileBlame, error) {
	f.historyBudget = budget
	return f.fileBlame, f.err
}

func (f *fakeWorktreeRepo) WriteWorktreeFile(_ context.Context, path, content, _ string, _ ...int64) (protocol.WorktreeFile, error) {
	if f.err != nil {
		return protocol.WorktreeFile{}, f.err
	}
	f.file = protocol.WorktreeFile{Path: path, Content: content, Hash: "saved"}
	return f.file, nil
}

func (f *fakeWorktreeRepo) CreateWorktreeFile(_ context.Context, path, content string, _ ...int64) (protocol.WorktreeFile, error) {
	if f.err != nil {
		return protocol.WorktreeFile{}, f.err
	}
	f.file = protocol.WorktreeFile{Path: path, Content: content, Hash: "created"}
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

type fakeResourceRepo struct {
	*fakeRepo
	data []byte
	path string
}

func (f *fakeResourceRepo) ReadWorktreeResource(_ context.Context, path string) ([]byte, error) {
	f.path = path
	return f.data, nil
}

func TestWorktreeResourceOnlyServesDetectedRasterImages(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\n" + strings.Repeat("\x00", 32))
	repo := &fakeResourceRepo{fakeRepo: &fakeRepo{}, data: png}
	h := newSnapshotServer(repo)
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		response := worktreeRequest(t, h, method, "/content?path=docs%2Fimage.png", "")
		if response.Code != http.StatusOK || repo.path != "docs/image.png" || response.Header().Get("Content-Type") != "image/png" || response.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatalf("%s: status = %d, headers = %v, path = %q", method, response.Code, response.Header(), repo.path)
		}
		if method == http.MethodHead && response.Body.Len() != 0 || method == http.MethodGet && !bytes.Equal(response.Body.Bytes(), png) {
			t.Fatalf("%s: unexpected body", method)
		}
	}
	for _, data := range [][]byte{[]byte("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), []byte("<script>alert(1)</script>")} {
		repo.data = data
		response := worktreeRequest(t, h, http.MethodGet, "/content?path=docs%2Fimage.png", "")
		if response.Code != http.StatusUnsupportedMediaType {
			t.Fatalf("unsafe content status = %d", response.Code)
		}
	}
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

	create := worktreeRequest(t, h, http.MethodPost, "/worktree/file", `{"path":"new.txt","content":"created\n"}`)
	if create.Code != http.StatusOK || repo.file.Path != "new.txt" || repo.file.Content != "created\n" {
		t.Fatalf("create status = %d, file = %#v, body = %s", create.Code, repo.file, create.Body.String())
	}
}

func TestWorktreeFileRevalidatesCachedContents(t *testing.T) {
	repo := &fakeWorktreeRepo{
		fakeRepo: &fakeRepo{},
		file:     protocol.WorktreeFile{Path: "large.txt", Content: strings.Repeat("x", 6<<20), Hash: "original"},
	}
	h := newSnapshotServer(repo)
	read := worktreeRequest(t, h, http.MethodGet, "/worktree/file?path=large.txt", "")
	etag := read.Header().Get("ETag")
	if read.Code != http.StatusOK || etag != `"original"` {
		t.Fatalf("initial read: status = %d, etag = %q", read.Code, etag)
	}
	request := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/worktree/file?path=large.txt", nil)
		req.Host = testHost
		req.Header.Set("If-None-Match", etag)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	unchanged := request()
	if unchanged.Code != http.StatusNotModified || unchanged.Body.Len() != 0 || unchanged.Header().Get("ETag") != etag {
		t.Fatalf("unchanged: status = %d, bytes = %d, headers = %v", unchanged.Code, unchanged.Body.Len(), unchanged.Header())
	}
	repo.file = protocol.WorktreeFile{Path: "large.txt", Content: "external edit", Hash: "changed"}
	changed := request()
	if changed.Code != http.StatusOK || !strings.Contains(changed.Body.String(), "external edit") || changed.Header().Get("ETag") == etag {
		t.Fatalf("external edit: status = %d, body = %s", changed.Code, changed.Body.String())
	}
	repo.file.Hash = "original"
	repo.err = protocol.ErrWorktreeEncoding
	invalid := request()
	if invalid.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("invalid encoding must not reuse cached contents: status = %d", invalid.Code)
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

func TestWorktreeLineHistoryRoute(t *testing.T) {
	repo := &fakeWorktreeRepo{
		fakeRepo: &fakeRepo{},
		lineHistory: protocol.LineHistory{
			Path: "notes.txt", CommitPath: "old-notes.txt", Line: 2, OID: "0123456789012345678901234567890123456789", ShortOID: "0123456", Author: "Test", Summary: "change notes",
		},
	}
	h := newSnapshotServer(repo)
	rec := worktreeRequest(t, h, http.MethodGet, "/worktree/line-history?path=notes.txt&line=2", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var history protocol.LineHistory
	if err := json.Unmarshal(rec.Body.Bytes(), &history); err != nil {
		t.Fatal(err)
	}
	if history.Path != "notes.txt" || history.CommitPath != "old-notes.txt" || history.Line != 2 || history.Generation != 1 {
		t.Fatalf("history = %#v", history)
	}
	if large := worktreeRequest(t, h, http.MethodGet, "/worktree/line-history?path=notes.txt&line=2&maxBytes=2000000", ""); large.Code != http.StatusOK || len(repo.historyBudget) != 1 || repo.historyBudget[0] != 2000000 {
		t.Fatalf("large status = %d, budget = %v", large.Code, repo.historyBudget)
	}
	invalid := worktreeRequest(t, h, http.MethodGet, "/worktree/line-history?path=notes.txt&line=zero", "")
	if invalid.Code != http.StatusBadRequest || !strings.Contains(invalid.Body.String(), "invalid-line") {
		t.Fatalf("invalid status = %d, body = %s", invalid.Code, invalid.Body.String())
	}
}

func TestWorktreeFileBlameRoute(t *testing.T) {
	repo := &fakeWorktreeRepo{
		fakeRepo: &fakeRepo{},
		fileBlame: protocol.FileBlame{
			Path:    "notes.txt",
			Commits: map[string]protocol.BlameCommit{"0123456789012345678901234567890123456789": {Author: "Test", Summary: "change notes"}},
			Ranges:  []protocol.BlameRange{{Start: 1, Count: 2, OID: "0123456789012345678901234567890123456789"}},
		},
	}
	h := newSnapshotServer(repo)
	rec := worktreeRequest(t, h, http.MethodGet, "/worktree/blame?path=notes.txt&maxBytes=2000000", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var blame protocol.FileBlame
	if err := json.Unmarshal(rec.Body.Bytes(), &blame); err != nil {
		t.Fatal(err)
	}
	if blame.Generation != 1 || len(blame.Ranges) != 1 || blame.Commits[blame.Ranges[0].OID].Author != "Test" {
		t.Fatalf("blame = %#v", blame)
	}
	if len(repo.historyBudget) != 1 || repo.historyBudget[0] != 2000000 {
		t.Fatalf("budget = %v", repo.historyBudget)
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

func TestWorktreeRoutesRejectUnsupportedEncoding(t *testing.T) {
	repo := &fakeWorktreeRepo{fakeRepo: &fakeRepo{}, err: protocol.ErrWorktreeEncoding}
	h := newSnapshotServer(repo)
	for _, request := range []struct{ method, path, body string }{
		{http.MethodGet, "/worktree/file?path=malformed.txt", ""},
		{http.MethodPut, "/worktree/file", `{"path":"malformed.txt","content":"after","expectedHash":"before"}`},
		{http.MethodPost, "/worktree/file", `{"path":"malformed.txt","content":"after"}`},
		{http.MethodGet, "/worktree/compare?left=malformed.txt&right=notes.txt", ""},
	} {
		rec := worktreeRequest(t, h, request.method, request.path, request.body)
		if rec.Code != http.StatusUnsupportedMediaType || !strings.Contains(rec.Body.String(), "unsupported-encoding") {
			t.Fatalf("%s %s: status = %d, body = %s", request.method, request.path, rec.Code, rec.Body.String())
		}
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
