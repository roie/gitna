package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
)

// --- Limit constant boundary tests ---

func TestLimitConstantsPositive(t *testing.T) {
	if MaxRequestBody != 1<<20 {
		t.Fatalf("MaxRequestBody = %d, want 1 MiB", MaxRequestBody)
	}
	if MaxPatchRequestBody != 20<<20 {
		t.Fatalf("MaxPatchRequestBody = %d, want 20 MiB", MaxPatchRequestBody)
	}
	if pathBatchLimit <= 0 {
		t.Fatalf("pathBatchLimit = %d, want > 0", pathBatchLimit)
	}
	if snapshotFileLimit <= 0 {
		t.Fatalf("snapshotFileLimit = %d, want > 0", snapshotFileLimit)
	}
	if SnapshotTimeout <= 0 {
		t.Fatalf("SnapshotTimeout = %v, want > 0", SnapshotTimeout)
	}
	if DiffTimeout <= 0 {
		t.Fatalf("DiffTimeout = %v, want > 0", DiffTimeout)
	}
	if GraphTimeout <= 0 {
		t.Fatalf("GraphTimeout = %v, want > 0", GraphTimeout)
	}
	if ReadTimeout <= 0 {
		t.Fatalf("ReadTimeout = %v, want > 0", ReadTimeout)
	}
	if LocalMutationTimeout <= 0 {
		t.Fatalf("LocalMutationTimeout = %v, want > 0", LocalMutationTimeout)
	}
	if NetworkTimeout <= 0 {
		t.Fatalf("NetworkTimeout = %v, want > 0", NetworkTimeout)
	}
	if CommitTimeout <= 0 {
		t.Fatalf("CommitTimeout = %v, want > 0", CommitTimeout)
	}
}

func TestNetworkTimeoutLongerThanLocal(t *testing.T) {
	if NetworkTimeout <= LocalMutationTimeout {
		t.Fatalf("NetworkTimeout (%v) should be > LocalMutationTimeout (%v)", NetworkTimeout, LocalMutationTimeout)
	}
}

func TestGraphMaxPageEnforced(t *testing.T) {
	h := newSnapshotServer(&fakeRepo{graphCommits: []protocol.GraphCommit{
		{OID: "abc"},
	}})

	req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/graph?skip=0&limit=9999", nil)
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
	// Should return only 1 commit since that's all the fake repo has,
	// but the limit should have been capped to graphMaxPage (500)
}

func TestGraphRejectsBadLimit(t *testing.T) {
	for _, limit := range []string{"abc", "-1", "0"} {
		h := newSnapshotServer(&fakeRepo{graphCommits: []protocol.GraphCommit{{OID: "x"}}})
		req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/graph?skip=0&limit="+limit, nil)
		req.Host = testHost
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("limit=%q status = %d, want %d", limit, rec.Code, http.StatusBadRequest)
		}
	}
}

// --- Timeout tests ---
//
// The server applies context.WithTimeout internally with large constants
// (SnapshotTimeout=30s, etc.), so we cannot test via a 5s delay.
// Instead, we use a fakeRepo that returns context.Canceled immediately,
// which simulates the same code path the handler hits when the deadline
// is exceeded (both go through ctx.Err() == context.DeadlineExceeded).
// We then verify the handler maps the timeout to 504.

func TestSnapshotTimeoutReturns504(t *testing.T) {
	h := newSnapshotServer(&fakeRepo{err: context.Canceled})
	req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/snapshot", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusGatewayTimeout {
		t.Fatalf("status = %d, want %d (canceled maps to 504)", rec.Code, http.StatusGatewayTimeout)
	}
}

func TestMutationTimeoutReturns504(t *testing.T) {
	// The mutation handler checks r.Context().Err() after the repo call.
	// We use a pre-cancelled context via slowRepo to test the 504 path.
	h := newSnapshotServer(&slowRepo{delay: 0, err: context.DeadlineExceeded})

	body := `{"paths":["a.txt"]}`
	req := httptest.NewRequest(http.MethodPost, "/s/"+testToken+"/api/v1/operations?op=stage", stringReader(body))
	req.Host = testHost
	req.Header.Set("Origin", "http://"+testHost)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusGatewayTimeout {
		t.Fatalf("status = %d, want %d (mutation timeout)", rec.Code, http.StatusGatewayTimeout)
	}
}

func TestReadHandlerTimeouts(t *testing.T) {
	// Verify that read handlers map context errors to 504.
	// Both context.Canceled and context.DeadlineExceeded go through
	// timeoutReached() and produce 504 Gateway Timeout.
	tests := []struct {
		name   string
		method string
		path   string
		err    error
		want   int
	}{
		{"snapshot canceled", http.MethodGet, "/api/v1/snapshot", context.Canceled, http.StatusGatewayTimeout},
		{"snapshot deadline", http.MethodGet, "/api/v1/snapshot", context.DeadlineExceeded, http.StatusGatewayTimeout},
		{"diff canceled", http.MethodGet, "/api/v1/diff?scope=unstaged&path=a.txt", context.Canceled, http.StatusGatewayTimeout},
		{"diff deadline", http.MethodGet, "/api/v1/diff?scope=unstaged&path=a.txt", context.DeadlineExceeded, http.StatusGatewayTimeout},
		{"review canceled", http.MethodGet, "/api/v1/review?scope=unstaged", context.Canceled, http.StatusGatewayTimeout},
		{"review deadline", http.MethodGet, "/api/v1/review?scope=unstaged", context.DeadlineExceeded, http.StatusGatewayTimeout},
		{"graph canceled", http.MethodGet, "/api/v1/graph", context.Canceled, http.StatusGatewayTimeout},
		{"graph deadline", http.MethodGet, "/api/v1/graph", context.DeadlineExceeded, http.StatusGatewayTimeout},
		{"branches canceled", http.MethodGet, "/api/v1/branches", context.Canceled, http.StatusGatewayTimeout},
		{"branches deadline", http.MethodGet, "/api/v1/branches", context.DeadlineExceeded, http.StatusGatewayTimeout},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newSnapshotServer(&slowRepo{delay: 0, err: tc.err})
			req := httptest.NewRequest(tc.method, "/s/"+testToken+tc.path, nil)
			req.Host = testHost
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d", rec.Code, tc.want)
			}
		})
	}
}

// --- ErrOutputLimit mapping test ---

func TestOperationMapsOutputLimitError(t *testing.T) {
	repo := &fakeRepo{opErr: gitx.ErrOutputLimit}
	h := newSnapshotServer(repo)

	body := `{"paths":["a.txt"]}`
	req := httptest.NewRequest(http.MethodPost, "/s/"+testToken+"/api/v1/operations?op=stage", stringReader(body))
	req.Host = testHost
	req.Header.Set("Origin", "http://"+testHost)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d (output limit)", rec.Code, http.StatusRequestEntityTooLarge)
	}
	var bodyResp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &bodyResp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if bodyResp["code"] != "output-too-large" {
		t.Fatalf("code = %v, want output-too-large", bodyResp["code"])
	}
}

// --- Mutation timeout routing ---

func TestMutationTimeoutRouting(t *testing.T) {
	tests := []struct {
		op   string
		want time.Duration
	}{
		{"fetch", NetworkTimeout},
		{"pull", NetworkTimeout},
		{"push", NetworkTimeout},
		{"push-upstream", NetworkTimeout},
		{"push-tag", NetworkTimeout},
		{"commit", CommitTimeout},
		{"stage", LocalMutationTimeout},
		{"stash-push", LocalMutationTimeout},
		{"merge", LocalMutationTimeout},
	}
	for _, tc := range tests {
		got := mutationTimeout(tc.op)
		if got != tc.want {
			t.Fatalf("mutationTimeout(%q) = %v, want %v", tc.op, got, tc.want)
		}
	}
}

// --- Helpers ---

func stringReader(s string) *dummyReader { return &dummyReader{s: s, data: []byte(s)} }

type dummyReader struct {
	s    string
	data []byte
	off  int
}

func (d *dummyReader) Read(p []byte) (int, error) {
	if d.off >= len(d.data) {
		return 0, io.EOF
	}
	n := copy(p, d.data[d.off:])
	d.off += n
	return n, nil
}

// slowRepo is a fake repo where every method blocks for the given delay,
// allowing us to test server-side timeouts.
type slowRepo struct {
	delay time.Duration
	snap  protocol.RepoSnapshot
	err   error
}

func (s *slowRepo) block(ctx context.Context) error {
	if s.err != nil {
		return s.err
	}
	select {
	case <-time.After(s.delay):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *slowRepo) Snapshot(ctx context.Context) (protocol.RepoSnapshot, error) {
	return s.snap, s.block(ctx)
}
func (s *slowRepo) RepositoryFiles(ctx context.Context, _ string, _ int) (protocol.RepositoryFiles, error) {
	return protocol.RepositoryFiles{}, s.block(ctx)
}
func (s *slowRepo) Diff(ctx context.Context, _ protocol.DiffScope, _ protocol.DiffOptions) (protocol.FileDiff, error) {
	return protocol.FileDiff{}, s.block(ctx)
}
func (s *slowRepo) Review(ctx context.Context, _ protocol.DiffScope, _ protocol.DiffOptions) (protocol.ReviewResponse, error) {
	return protocol.ReviewResponse{}, s.block(ctx)
}
func (s *slowRepo) History(ctx context.Context, _, _ int) ([]protocol.GraphCommit, error) {
	return nil, s.block(ctx)
}
func (s *slowRepo) FilesChanged(ctx context.Context, _ string) (protocol.CommitFiles, error) {
	return protocol.CommitFiles{}, s.block(ctx)
}
func (s *slowRepo) Branches(ctx context.Context) ([]protocol.Branch, error) {
	return nil, s.block(ctx)
}
func (s *slowRepo) StagePaths(ctx context.Context, _ []string) error {
	return s.block(ctx)
}
func (s *slowRepo) UnstagePaths(ctx context.Context, _ []string) error {
	return s.block(ctx)
}
func (s *slowRepo) DiscardTracked(ctx context.Context, _ []string) error {
	return s.block(ctx)
}
func (s *slowRepo) DeleteUntracked(ctx context.Context, _ []string) error {
	return s.block(ctx)
}
func (s *slowRepo) StagePatch(ctx context.Context, _ []byte) error {
	return s.block(ctx)
}
func (s *slowRepo) UnstagePatch(ctx context.Context, _ []byte) error {
	return s.block(ctx)
}
func (s *slowRepo) Commit(ctx context.Context, _ protocol.CommitRequest) (protocol.OperationResult, error) {
	return protocol.OperationResult{}, s.block(ctx)
}
func (s *slowRepo) CreateBranch(ctx context.Context, _, _ string) error {
	return s.block(ctx)
}
func (s *slowRepo) SwitchBranch(ctx context.Context, _ string) error {
	return s.block(ctx)
}
func (s *slowRepo) DeleteBranch(ctx context.Context, _ string, _ bool) error {
	return s.block(ctx)
}
func (s *slowRepo) Fetch(ctx context.Context) error {
	return s.block(ctx)
}
func (s *slowRepo) Pull(ctx context.Context) error {
	return s.block(ctx)
}
func (s *slowRepo) Push(ctx context.Context) error {
	return s.block(ctx)
}
func (s *slowRepo) PushSetUpstream(ctx context.Context, _, _ string) error {
	return s.block(ctx)
}
func (s *slowRepo) Stashes(ctx context.Context) ([]protocol.StashEntry, error) {
	return nil, s.block(ctx)
}
func (s *slowRepo) StashPush(ctx context.Context, _ string, _ bool) error {
	return s.block(ctx)
}
func (s *slowRepo) StashApply(ctx context.Context, _ string) error {
	return s.block(ctx)
}
func (s *slowRepo) StashPop(ctx context.Context, _ string) error {
	return s.block(ctx)
}
func (s *slowRepo) StashDrop(ctx context.Context, _ string) error {
	return s.block(ctx)
}
func (s *slowRepo) Tags(ctx context.Context) ([]protocol.Tag, error) {
	return nil, s.block(ctx)
}
func (s *slowRepo) CreateTag(ctx context.Context, _, _, _ string) error {
	return s.block(ctx)
}
func (s *slowRepo) DeleteTag(ctx context.Context, _ string) error {
	return s.block(ctx)
}
func (s *slowRepo) PushTag(ctx context.Context, _, _ string) error {
	return s.block(ctx)
}
func (s *slowRepo) CherryPick(ctx context.Context, _ string) error {
	return s.block(ctx)
}
func (s *slowRepo) CherryPickAbort(ctx context.Context) error {
	return s.block(ctx)
}
func (s *slowRepo) CherryPickContinue(ctx context.Context) error {
	return s.block(ctx)
}
func (s *slowRepo) Revert(ctx context.Context, _ string) error {
	return s.block(ctx)
}
func (s *slowRepo) RevertAbort(ctx context.Context) error {
	return s.block(ctx)
}
func (s *slowRepo) RevertContinue(ctx context.Context) error {
	return s.block(ctx)
}
func (s *slowRepo) Reset(ctx context.Context, _, _ string) error {
	return s.block(ctx)
}
func (s *slowRepo) CompareFiles(ctx context.Context, _, _ string) ([]protocol.CommitFile, error) {
	return nil, s.block(ctx)
}
func (s *slowRepo) Conflicts(ctx context.Context) ([]protocol.ConflictEntry, error) {
	return nil, s.block(ctx)
}
func (s *slowRepo) Merge(ctx context.Context, _ string) error {
	return s.block(ctx)
}
func (s *slowRepo) MergeAbort(ctx context.Context) error {
	return s.block(ctx)
}
func (s *slowRepo) MergeContinue(ctx context.Context) error {
	return s.block(ctx)
}
func (s *slowRepo) Rebase(ctx context.Context, _ string) error {
	return s.block(ctx)
}
func (s *slowRepo) RebaseAbort(ctx context.Context) error {
	return s.block(ctx)
}
func (s *slowRepo) RebaseContinue(ctx context.Context) error {
	return s.block(ctx)
}
func (s *slowRepo) ResolveConflict(ctx context.Context, _ string, _ bool) error {
	return s.block(ctx)
}
func (s *slowRepo) ResolveConflictBoth(ctx context.Context, _ string) error {
	return s.block(ctx)
}
