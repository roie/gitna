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

func postVerifiedPatch(t *testing.T, repo Repo, scope protocol.DiffScope, path, fullPatch, submittedPatch string, reverse bool) *httptest.ResponseRecorder {
	t.Helper()
	srv, err := New(newTestFS(), Options{Token: testToken, Host: testHost, Repo: repo})
	if err != nil {
		t.Fatal(err)
	}
	patchID, err := srv.issuePatchIdentity(srv.gen.Load(), scope, path, fullPatch)
	if err != nil {
		t.Fatal(err)
	}
	var body bytes.Buffer
	if err := json.NewEncoder(&body).Encode(mutationRequest{
		Patch:      submittedPatch,
		PatchID:    patchID,
		PatchScope: scope,
		PatchPath:  path,
		Reverse:    reverse,
	}); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/s/"+testToken+"/api/v1/operations?op="+OpPatch, &body)
	req.Host = testHost
	req.Header.Set("Origin", "http://"+testHost)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

func postOperationDirect(repo Repo, op, body string) *httptest.ResponseRecorder {
	srv := &Server{repo: repo}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/operations?op="+op, strings.NewReader(body))
	rec := httptest.NewRecorder()
	srv.handleOperation(rec, req)
	return rec
}

func postOperationUnknownLength(repo Repo, op, body string) *httptest.ResponseRecorder {
	h := newSnapshotServer(repo)
	req := httptest.NewRequest(http.MethodPost, "/s/"+testToken+"/api/v1/operations?op="+op, strings.NewReader(body))
	req.ContentLength = -1
	req.TransferEncoding = []string{"chunked"}
	req.Host = testHost
	req.Header.Set("Origin", "http://"+testHost)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func recordedMutationCalls(repo *fakeRepo) int {
	repo.mu.Lock()
	defer repo.mu.Unlock()
	return len(repo.stageOps) + len(repo.unstages) + len(repo.discards) + len(repo.deletes) + len(repo.patches)
}

func TestSuccessfulMutationsAdvanceGeneration(t *testing.T) {
	tests := []struct {
		name string
		op   string
		repo *fakeRepo
		body string
	}{
		{name: "stage", op: OpStage, repo: &fakeRepo{}, body: `{"paths":["a.txt"]}`},
		{name: "commit", op: OpCommit, repo: &fakeRepo{commitRes: protocol.OperationResult{OK: true}}, body: `{"message":"subject"}`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			srv := &Server{repo: tc.repo}
			srv.gen.Store(7)
			req := httptest.NewRequest(http.MethodPost, "/api/v1/operations?op="+tc.op, strings.NewReader(tc.body))
			rec := httptest.NewRecorder()
			srv.handleOperation(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
			}
			if got := srv.gen.Load(); got != 8 {
				t.Fatalf("generation = %d, want 8", got)
			}
		})
	}
}

func TestFailedMutationKeepsGeneration(t *testing.T) {
	srv := &Server{repo: &fakeRepo{opErr: errors.New("boom")}}
	srv.gen.Store(7)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/operations?op="+OpStage, strings.NewReader(`{"paths":["a.txt"]}`))
	rec := httptest.NewRecorder()
	srv.handleOperation(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	if got := srv.gen.Load(); got != 7 {
		t.Fatalf("generation = %d, want unchanged 7", got)
	}
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
	repo.diff.Patch = patch

	if rec := postVerifiedPatch(t, repo, protocol.DiffUnstaged, "a.txt", patch, patch, false); rec.Code != http.StatusOK {
		t.Fatalf("stage patch status = %d, want %d (%s)", rec.Code, http.StatusOK, rec.Body)
	}
	if rec := postVerifiedPatch(t, repo, protocol.DiffStaged, "a.txt", patch, patch, true); rec.Code != http.StatusOK {
		t.Fatalf("unstage patch status = %d, want %d (%s)", rec.Code, http.StatusOK, rec.Body)
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

func TestOperationPatchAcceptsBodyAboveOrdinaryLimit(t *testing.T) {
	patch := strings.Repeat("x", int(MaxRequestBody)+1)
	repo := &fakeRepo{diff: protocol.FileDiff{Patch: patch}}
	rec := postVerifiedPatch(t, repo, protocol.DiffUnstaged, "a.txt", patch, patch, false)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.patches) != 1 || repo.patches[0].patch != patch {
		t.Fatalf("patch call not recorded at expected size: %+v", repo.patches)
	}
}

func TestOperationDecoderEnforcesBodyLimits(t *testing.T) {
	for _, tc := range []struct {
		name string
		op   string
		size int64
	}{
		{name: "ordinary", op: OpStage, size: MaxRequestBody + 1},
		{name: "patch", op: OpPatch, size: MaxPatchRequestBody + 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := `{"patch":"` + strings.Repeat("x", int(tc.size)) + `"}`
			rec := postOperationDirect(&fakeRepo{}, tc.op, body)
			if rec.Code != http.StatusRequestEntityTooLarge {
				t.Fatalf("status = %d, want 413 (%s)", rec.Code, rec.Body)
			}
		})
	}
}

func TestOperationDecoderConsumesUnknownLengthBody(t *testing.T) {
	for _, tc := range []struct {
		name   string
		op     string
		prefix string
		limit  int64
	}{
		{name: "ordinary", op: OpStage, prefix: `{"paths":["a.txt"]}`, limit: MaxRequestBody},
		{name: "patch", op: OpPatch, prefix: `{"patch":"x"}`, limit: MaxPatchRequestBody},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &fakeRepo{}
			body := tc.prefix + strings.Repeat(" ", int(tc.limit)+1)
			rec := postOperationUnknownLength(repo, tc.op, body)
			if rec.Code != http.StatusRequestEntityTooLarge {
				t.Fatalf("status = %d, want 413 (%s)", rec.Code, rec.Body)
			}
			if calls := recordedMutationCalls(repo); calls != 0 {
				t.Fatalf("repository calls = %d, want none", calls)
			}
		})
	}
}

func TestOperationDecoderRejectsSecondJSONValue(t *testing.T) {
	repo := &fakeRepo{}
	body := `{"paths":["a.txt"]} {"paths":["b.txt"]}`
	rec := postOperationUnknownLength(repo, OpStage, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (%s)", rec.Code, rec.Body)
	}
	if calls := recordedMutationCalls(repo); calls != 0 {
		t.Fatalf("repository calls = %d, want none", calls)
	}
}

func TestOperationPathBatchLimit(t *testing.T) {
	paths := make([]string, pathBatchLimit)
	for i := range paths {
		paths[i] = "a"
	}
	for _, op := range []string{OpStage, OpUnstage, OpDiscard, OpDelete} {
		t.Run(op, func(t *testing.T) {
			repo := &fakeRepo{}
			if rec := postOperation(t, repo, op, mutationRequest{Paths: paths}); rec.Code != http.StatusOK {
				t.Fatalf("exact limit status = %d, want 200 (%s)", rec.Code, rec.Body)
			}

			repo = &fakeRepo{}
			overLimit := append(append([]string(nil), paths...), "b")
			rec := postOperation(t, repo, op, mutationRequest{Paths: overLimit})
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("over limit status = %d, want 400 (%s)", rec.Code, rec.Body)
			}
			var body map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body["code"] != "too-many-paths" || body["limit"] != float64(pathBatchLimit) {
				t.Fatalf("body = %#v, want too-many-paths limit %d", body, pathBatchLimit)
			}
			repo.mu.Lock()
			calls := len(repo.stageOps) + len(repo.unstages) + len(repo.discards) + len(repo.deletes)
			repo.mu.Unlock()
			if calls != 0 {
				t.Fatalf("repository called for over-limit request: %d paths", calls)
			}
		})
	}
}

type patchLimitRepo struct {
	*fakeRepo
	repository gitx.Repository
	runner     gitx.Runner
}

func (r *patchLimitRepo) StagePatch(ctx context.Context, patch []byte) error {
	return r.repository.ApplyPatch(ctx, r.runner, patch, false)
}

type unexpectedPatchRunner struct{}

func (unexpectedPatchRunner) Run(context.Context, string, ...string) (gitx.Result, error) {
	return gitx.Result{}, errors.New("unexpected Git call")
}

func (unexpectedPatchRunner) RunInput(context.Context, string, []byte, ...string) (gitx.Result, error) {
	return gitx.Result{}, errors.New("unexpected Git call")
}

func TestOperationMapsApplicationPatchLimit(t *testing.T) {
	const applicationPatchLimit = 8 << 20
	patch := strings.Repeat("x", applicationPatchLimit+1)
	repo := &patchLimitRepo{
		fakeRepo:   &fakeRepo{diff: protocol.FileDiff{Patch: patch}},
		repository: gitx.Repository{Root: t.TempDir()},
		runner:     unexpectedPatchRunner{},
	}
	rec := postVerifiedPatch(t, repo, protocol.DiffUnstaged, "a.txt", patch, patch, false)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413 (%s)", rec.Code, rec.Body)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["code"] != "patch-too-large" {
		t.Fatalf("code = %v, want patch-too-large", body["code"])
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
		{"patch too large", gitx.ErrPatchTooLarge, http.StatusRequestEntityTooLarge},
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

func TestOperationCommitRoutesRequest(t *testing.T) {
	repo := &fakeRepo{commitRes: protocol.OperationResult{OK: true}}
	rec := postOperation(t, repo, OpCommit, mutationRequest{Message: "subject\n\nbody", Amend: true})

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (%s)", rec.Code, http.StatusOK, rec.Body)
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.commits) != 1 {
		t.Fatalf("commits = %d, want 1", len(repo.commits))
	}
	if repo.commits[0].Message != "subject\n\nbody" || !repo.commits[0].Amend {
		t.Fatalf("commit request = %+v, want message + amend", repo.commits[0])
	}
	var got protocol.OperationResult
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !got.OK {
		t.Fatalf("result = %+v, want OK", got)
	}
}

func TestOperationCommitRelaysRejectedHook(t *testing.T) {
	repo := &fakeRepo{
		commitRes: protocol.OperationResult{OK: false, ExitCode: 1, Stderr: "pre-commit blocked"},
		commitErr: &gitx.CommitError{ExitCode: 1, Stderr: "pre-commit blocked"},
	}
	rec := postOperation(t, repo, OpCommit, mutationRequest{Message: "subject"})

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (hook rejection is not an HTTP error)", rec.Code, http.StatusOK)
	}
	var got protocol.OperationResult
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.OK || got.ExitCode != 1 || got.Stderr != "pre-commit blocked" {
		t.Fatalf("result = %+v, want rejected hook relayed", got)
	}
}

func TestOperationCommitMapsErrors(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want int
	}{
		{"message too large", gitx.ErrCommitMessageTooLarge, http.StatusBadRequest},
		{"infrastructure failure", errors.New("boom"), http.StatusInternalServerError},
	} {
		repo := &fakeRepo{commitErr: tc.err, commitRes: protocol.OperationResult{}}
		rec := postOperation(t, repo, OpCommit, mutationRequest{Message: "subject"})
		if rec.Code != tc.want {
			t.Fatalf("%s: status = %d, want %d", tc.name, rec.Code, tc.want)
		}
	}
}

func TestOperationBranchAndSyncOps(t *testing.T) {
	repo := &fakeRepo{}
	tests := []struct {
		op  string
		req mutationRequest
	}{
		{OpBranchCreate, mutationRequest{Name: "topic", Start: "main"}},
		{OpBranchSwitch, mutationRequest{Name: "topic"}},
		{OpBranchDelete, mutationRequest{Name: "topic", Force: true}},
		{OpFetch, mutationRequest{}},
		{OpPull, mutationRequest{}},
		{OpPush, mutationRequest{}},
		{OpPushSetUpstream, mutationRequest{Name: "topic", Remote: "origin"}},
	}
	for _, tc := range tests {
		rec := postOperation(t, repo, tc.op, tc.req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d, want %d (%s)", tc.op, rec.Code, http.StatusOK, rec.Body)
		}
	}

	repo.mu.Lock()
	defer repo.mu.Unlock()
	if got := strings.Join(repo.branchCalls, ","); got != "create:topic,switch:topic,delete:topic" {
		t.Fatalf("branch calls = %q, want create/switch/delete", got)
	}
	if len(repo.branchForces) != 1 || !repo.branchForces[0] {
		t.Fatalf("branch forces = %v, want [true]", repo.branchForces)
	}
	if got := strings.Join(repo.syncCalls, ","); got != "fetch,pull,push,push-upstream:origin:topic" {
		t.Fatalf("sync calls = %q, want fetch/pull/push/upstream", got)
	}
}

func TestOperationPushNoUpstreamStructured(t *testing.T) {
	repo := &fakeRepo{opErr: gitx.ErrNoUpstream, snap: protocol.RepoSnapshot{HeadBranch: "topic"}}
	rec := postOperation(t, repo, OpPush, mutationRequest{})

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d (%s)", rec.Code, http.StatusConflict, rec.Body)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["code"] != "no-upstream" || body["branch"] != "topic" {
		t.Fatalf("body = %v, want code no-upstream and branch topic", body)
	}
}

func TestOperationBranchDeleteNotMergedStructured(t *testing.T) {
	repo := &fakeRepo{err: gitx.ErrBranchNotMerged}
	rec := postOperation(t, repo, OpBranchDelete, mutationRequest{Name: "topic"})

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d (%s)", rec.Code, http.StatusConflict, rec.Body)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["code"] != "branch-not-merged" {
		t.Fatalf("code = %v, want branch-not-merged", body["code"])
	}
}

func TestOperationBranchOpsRejectInvalidRef(t *testing.T) {
	for _, tc := range []struct {
		op  string
		req mutationRequest
	}{
		{OpBranchCreate, mutationRequest{Name: "a b"}},
		{OpBranchSwitch, mutationRequest{Name: ""}},
		{OpBranchDelete, mutationRequest{Name: "-x"}},
		{OpPushSetUpstream, mutationRequest{Name: "main", Remote: "bad remote"}},
	} {
		repo := &fakeRepo{err: protocol.ErrInvalidRef}
		rec := postOperation(t, repo, tc.op, tc.req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want %d", tc.op, rec.Code, http.StatusBadRequest)
		}
	}
}
