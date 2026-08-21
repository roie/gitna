package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
)

// Mutation operation names accepted by POST /api/v1/operations.
const (
	OpStage           = "stage"
	OpUnstage         = "unstage"
	OpDiscard         = "discard"
	OpDelete          = "delete"
	OpPatch           = "patch"
	OpCommit          = "commit"
	OpBranchCreate    = "create-branch"
	OpBranchSwitch    = "switch-branch"
	OpBranchDelete    = "delete-branch"
	OpFetch           = "fetch"
	OpPull            = "pull"
	OpPush            = "push"
	OpPushSetUpstream = "push-upstream"
	OpStashPush       = "stash-push"
	OpStashApply      = "stash-apply"
	OpStashPop        = "stash-pop"
	OpStashDrop       = "stash-drop"
	OpTagCreate       = "create-tag"
	OpTagDelete       = "delete-tag"
	OpTagPush         = "push-tag"
	OpCherryPick         = "cherry-pick"
	OpCherryPickAbort    = "cherry-pick-abort"
	OpCherryPickContinue = "cherry-pick-continue"
	OpRevert             = "revert"
	OpRevertAbort        = "revert-abort"
	OpRevertContinue     = "revert-continue"
	OpReset           = "reset"
	OpMerge           = "merge"
	OpMergeAbort      = "merge-abort"
	OpMergeContinue   = "merge-continue"
	OpRebase          = "rebase"
	OpRebaseAbort     = "rebase-abort"
	OpRebaseContinue  = "rebase-continue"
	OpResolveOurs     = "resolve-ours"
	OpResolveTheirs   = "resolve-theirs"
	OpResolveBoth     = "resolve-both"
)

// mutationRequest is the JSON body shared by all operations. Only the fields
// relevant to the operation are read.
type mutationRequest struct {
	// Paths selects files for path-level operations (stage, unstage, discard,
	// delete).
	Paths []string `json:"paths"`
	// Patch is a unified diff for whole-hunk staging/unstaging. PatchID binds it
	// to the full diff, path, scope, and repository generation issued by /diff.
	Patch      string             `json:"patch"`
	PatchID    string             `json:"patchId"`
	PatchScope protocol.DiffScope `json:"scope"`
	PatchPath  string             `json:"path"`
	// Reverse applies the patch to the index in reverse (unstage).
	Reverse bool `json:"reverse"`
	// Message and Amend carry the commit request for the commit operation.
	Message string `json:"message"`
	Amend   bool   `json:"amend"`
	// Name selects a branch for branch operations and names the branch for
	// create-branch and push-upstream.
	Name string `json:"name"`
	// Start is the ref or oid a new branch is created at; empty means HEAD.
	Start string `json:"start,omitempty"`
	// Remote names the remote for push-upstream.
	Remote string `json:"remote,omitempty"`
	// Force requests a force branch delete after explicit confirmation.
	Force bool `json:"force"`
	// Ref names the stash entry or history target for stash apply/pop/drop,
	// cherry-pick, revert, and reset.
	Ref string `json:"ref,omitempty"`
	// Mode selects the reset mode (soft, mixed, or hard).
	Mode string `json:"mode,omitempty"`
	// IncludeUntracked requests that a stash push carry untracked files too.
	IncludeUntracked bool `json:"includeUntracked"`
}

// mutationTimeout returns the per-operation timeout. Network operations get a
// longer deadline; local mutations and commits get shorter ones.
func mutationTimeout(op string) time.Duration {
	switch op {
	case OpFetch, OpPull, OpPush, OpPushSetUpstream, OpTagPush:
		return NetworkTimeout
	case OpCommit:
		return CommitTimeout
	default:
		return LocalMutationTimeout
	}
}

// withTimeout creates a context with the given deadline, derived from the
// request context so client disconnection still propagates.
func withTimeout(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, d)
}

// handleCommit runs a commit/amend. Hooks run normally; a rejected commit is
// not an HTTP error — git's exit code and output are relayed in the body so the
// composer can show the hook's reason while preserving the user's text.
func (s *Server) handleCommit(w http.ResponseWriter, r *http.Request, req mutationRequest) {
	ctx, cancel := withTimeout(r.Context(), CommitTimeout)
	defer cancel()
	result, err := s.repo.Commit(ctx, protocol.CommitRequest{Message: req.Message, Amend: req.Amend})
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "commit timed out"})
			return
		}
		var commitErr *gitx.CommitError
		switch {
		case errors.As(err, &commitErr):
			writeJSON(w, http.StatusOK, result)
		case errors.Is(err, gitx.ErrCommitMessageTooLarge):
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		default:
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		}
		return
	}
	if result.OK {
		s.gen.Add(1)
	}
	writeJSON(w, http.StatusOK, result)
}

func writeMutationDecodeError(w http.ResponseWriter, err error) {
	var maxBytesErr *http.MaxBytesError
	if errors.As(err, &maxBytesErr) {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "request body too large"})
		return
	}
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
}

// handleOperation runs one repository mutation. Sentinel errors from the gitx
// layer map to client-friendly statuses: invalid paths are 400, and a patch
// that no longer applies because the index changed is 409.
func (s *Server) handleOperation(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	op := r.URL.Query().Get("op")
	var req mutationRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, operationRequestBodyLimit(op)))
	if err := dec.Decode(&req); err != nil {
		writeMutationDecodeError(w, err)
		return
	}
	var trailing json.RawMessage
	if err := dec.Decode(&trailing); err != io.EOF {
		writeMutationDecodeError(w, err)
		return
	}

	switch op {
	case OpStage, OpUnstage, OpDiscard, OpDelete:
		if len(req.Paths) > pathBatchLimit {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error": "too many paths",
				"code":  "too-many-paths",
				"limit": pathBatchLimit,
			})
			return
		}
	case OpResolveOurs, OpResolveTheirs, OpResolveBoth:
		if len(req.Paths) != 1 {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error": "conflict resolution requires exactly one path",
				"code":  "invalid-path-count",
			})
			return
		}
	}

	ctx, cancel := withTimeout(r.Context(), mutationTimeout(op))
	defer cancel()
	var err error
	switch op {
	case OpStage:
		err = s.repo.StagePaths(ctx, req.Paths)
	case OpUnstage:
		err = s.repo.UnstagePaths(ctx, req.Paths)
	case OpDiscard:
		err = s.repo.DiscardTracked(ctx, req.Paths)
	case OpDelete:
		err = s.repo.DeleteUntracked(ctx, req.Paths)
	case OpPatch:
		err = s.validatePatchMutation(ctx, req)
		if err == nil {
			patch := []byte(req.Patch)
			if req.Reverse {
				err = s.repo.UnstagePatch(ctx, patch)
			} else {
				err = s.repo.StagePatch(ctx, patch)
			}
		}
	case OpCommit:
		s.handleCommit(w, r, req)
		return
	case OpBranchCreate:
		err = s.repo.CreateBranch(ctx, req.Name, req.Start)
	case OpBranchSwitch:
		err = s.repo.SwitchBranch(ctx, req.Name)
	case OpBranchDelete:
		err = s.repo.DeleteBranch(ctx, req.Name, req.Force)
	case OpFetch:
		err = s.repo.Fetch(ctx)
	case OpPull:
		err = s.repo.Pull(ctx)
	case OpPush:
		err = s.repo.Push(ctx)
	case OpPushSetUpstream:
		err = s.repo.PushSetUpstream(ctx, req.Remote, req.Name)
	case OpStashPush:
		err = s.repo.StashPush(ctx, req.Message, req.IncludeUntracked)
	case OpStashApply:
		err = s.repo.StashApply(ctx, req.Ref)
	case OpStashPop:
		err = s.repo.StashPop(ctx, req.Ref)
	case OpStashDrop:
		err = s.repo.StashDrop(ctx, req.Ref)
	case OpTagCreate:
		err = s.repo.CreateTag(ctx, req.Name, req.Start, req.Message)
	case OpTagDelete:
		err = s.repo.DeleteTag(ctx, req.Name)
	case OpTagPush:
		err = s.repo.PushTag(ctx, req.Remote, req.Name)
	case OpCherryPick:
		err = s.repo.CherryPick(ctx, req.Ref)
	case OpCherryPickAbort:
		err = s.repo.CherryPickAbort(ctx)
	case OpCherryPickContinue:
		err = s.repo.CherryPickContinue(ctx)
	case OpRevert:
		err = s.repo.Revert(ctx, req.Ref)
	case OpRevertAbort:
		err = s.repo.RevertAbort(ctx)
	case OpRevertContinue:
		err = s.repo.RevertContinue(ctx)
	case OpReset:
		err = s.repo.Reset(ctx, req.Ref, req.Mode)
	case OpMerge:
		err = s.repo.Merge(ctx, req.Name)
	case OpMergeAbort:
		err = s.repo.MergeAbort(ctx)
	case OpMergeContinue:
		err = s.repo.MergeContinue(ctx)
	case OpRebase:
		err = s.repo.Rebase(ctx, req.Name)
	case OpRebaseAbort:
		err = s.repo.RebaseAbort(ctx)
	case OpRebaseContinue:
		err = s.repo.RebaseContinue(ctx)
	case OpResolveOurs:
		err = s.repo.ResolveConflict(ctx, req.Paths[0], false)
	case OpResolveTheirs:
		err = s.repo.ResolveConflict(ctx, req.Paths[0], true)
	case OpResolveBoth:
		err = s.repo.ResolveConflictBoth(ctx, req.Paths[0])
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown operation"})
		return
	}
	if err != nil {
		writeMutationError(w, r, s, err)
		return
	}
	s.gen.Add(1)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// writeMutationError maps a mutation error to an HTTP status and JSON body.
// It handles context cancellation, output limits, and all gitx sentinel errors.
func writeMutationError(w http.ResponseWriter, r *http.Request, s *Server, err error) {
	// Check both the request context and whether the error itself is a
	// context error (the repo may have returned ctx.Err() directly).
	if ctxErr := r.Context().Err(); ctxErr != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "operation timed out"})
		return
	}
	status := http.StatusInternalServerError
	body := map[string]any{"error": err.Error()}
	switch {
	case errors.Is(err, gitx.ErrPatchTooLarge):
		status = http.StatusRequestEntityTooLarge
		body["code"] = "patch-too-large"
	case errors.Is(err, gitx.ErrOutputLimit):
		status = http.StatusRequestEntityTooLarge
		body["code"] = "output-too-large"
	case errors.Is(err, protocol.ErrInvalidPath), errors.Is(err, protocol.ErrNotInRepo), errors.Is(err, protocol.ErrInvalidRef), errors.Is(err, gitx.ErrInvalidResetMode):
		status = http.StatusBadRequest
	case errors.Is(err, gitx.ErrAlreadyInProgress):
		status = http.StatusConflict
		body["code"] = "already-in-progress"
	case errors.Is(err, errStalePatchIdentity):
		status = http.StatusConflict
		body["code"] = "stale-patch"
	case errors.Is(err, gitx.ErrPatchDoesNotApply):
		status = http.StatusConflict
		body["code"] = "patch-does-not-apply"
	case errors.Is(err, gitx.ErrPushRejected):
		status = http.StatusConflict
	case errors.Is(err, gitx.ErrNoUpstream):
		status = http.StatusConflict
		body["code"] = "no-upstream"
		if snap, serr := s.repo.Snapshot(r.Context()); serr == nil {
			body["branch"] = snap.HeadBranch
		}
	case errors.Is(err, gitx.ErrBranchNotMerged):
		status = http.StatusConflict
		body["code"] = "branch-not-merged"
	case errors.Is(err, gitx.ErrNoStash):
		status = http.StatusNotFound
	case errors.Is(err, gitx.ErrNoTag):
		status = http.StatusNotFound
	case errors.Is(err, gitx.ErrStashConflict), errors.Is(err, gitx.ErrConflict):
		status = http.StatusConflict
		body["code"] = "conflict"
	case errors.Is(err, gitx.ErrTagExists):
		status = http.StatusConflict
		body["code"] = "tag-exists"
	}
	writeJSON(w, status, body)
}
