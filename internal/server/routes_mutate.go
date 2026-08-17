package server

import (
	"encoding/json"
	"errors"
	"net/http"

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
	OpCherryPick      = "cherry-pick"
	OpRevert          = "revert"
	OpReset           = "reset"
	OpMerge           = "merge"
	OpMergeAbort      = "merge-abort"
	OpMergeContinue   = "merge-continue"
	OpRebase          = "rebase"
	OpRebaseAbort     = "rebase-abort"
	OpRebaseContinue  = "rebase-continue"
	OpResolveOurs     = "resolve-ours"
	OpResolveTheirs   = "resolve-theirs"
)

// mutationRequest is the JSON body shared by all operations. Only the fields
// relevant to the operation are read.
type mutationRequest struct {
	// Paths selects files for path-level operations (stage, unstage, discard,
	// delete).
	Paths []string `json:"paths"`
	// Patch is a unified diff for whole-hunk staging/unstaging.
	Patch string `json:"patch"`
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

// maxMutationBytes bounds the JSON request body; patches are capped at a lower
// limit by the gitx layer anyway.
const maxMutationBytes = 1 << 20

// handleCommit runs a commit/amend. Hooks run normally; a rejected commit is
// not an HTTP error — git's exit code and output are relayed in the body so the
// composer can show the hook's reason while preserving the user's text.
func handleCommit(w http.ResponseWriter, r *http.Request, repo Repo, req mutationRequest) {
	result, err := repo.Commit(r.Context(), protocol.CommitRequest{Message: req.Message, Amend: req.Amend})
	if err != nil {
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
	writeJSON(w, http.StatusOK, result)
}

// handleOperation runs one repository mutation. Sentinel errors from the gitx
// layer map to client-friendly statuses: invalid paths are 400, and a patch
// that no longer applies because the index changed is 409.
func (s *Server) handleOperation(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	var req mutationRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxMutationBytes))
	if err := dec.Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	op := r.URL.Query().Get("op")
	var err error
	switch op {
	case OpStage:
		err = s.repo.StagePaths(r.Context(), req.Paths)
	case OpUnstage:
		err = s.repo.UnstagePaths(r.Context(), req.Paths)
	case OpDiscard:
		err = s.repo.DiscardTracked(r.Context(), req.Paths)
	case OpDelete:
		err = s.repo.DeleteUntracked(r.Context(), req.Paths)
	case OpPatch:
		patch := []byte(req.Patch)
		if req.Reverse {
			err = s.repo.UnstagePatch(r.Context(), patch)
		} else {
			err = s.repo.StagePatch(r.Context(), patch)
		}
	case OpCommit:
		handleCommit(w, r, s.repo, req)
		return
	case OpBranchCreate:
		err = s.repo.CreateBranch(r.Context(), req.Name, req.Start)
	case OpBranchSwitch:
		err = s.repo.SwitchBranch(r.Context(), req.Name)
	case OpBranchDelete:
		err = s.repo.DeleteBranch(r.Context(), req.Name, req.Force)
	case OpFetch:
		err = s.repo.Fetch(r.Context())
	case OpPull:
		err = s.repo.Pull(r.Context())
	case OpPush:
		err = s.repo.Push(r.Context())
	case OpPushSetUpstream:
		err = s.repo.PushSetUpstream(r.Context(), req.Remote, req.Name)
	case OpStashPush:
		err = s.repo.StashPush(r.Context(), req.Message, req.IncludeUntracked)
	case OpStashApply:
		err = s.repo.StashApply(r.Context(), req.Ref)
	case OpStashPop:
		err = s.repo.StashPop(r.Context(), req.Ref)
	case OpStashDrop:
		err = s.repo.StashDrop(r.Context(), req.Ref)
	case OpTagCreate:
		err = s.repo.CreateTag(r.Context(), req.Name, req.Start, req.Message)
	case OpTagDelete:
		err = s.repo.DeleteTag(r.Context(), req.Name)
	case OpTagPush:
		err = s.repo.PushTag(r.Context(), req.Remote, req.Name)
	case OpCherryPick:
		err = s.repo.CherryPick(r.Context(), req.Ref)
	case OpRevert:
		err = s.repo.Revert(r.Context(), req.Ref)
	case OpReset:
		err = s.repo.Reset(r.Context(), req.Ref, req.Mode)
	case OpMerge:
		err = s.repo.Merge(r.Context(), req.Name)
	case OpMergeAbort:
		err = s.repo.MergeAbort(r.Context())
	case OpMergeContinue:
		err = s.repo.MergeContinue(r.Context())
	case OpRebase:
		err = s.repo.Rebase(r.Context(), req.Name)
	case OpRebaseAbort:
		err = s.repo.RebaseAbort(r.Context())
	case OpRebaseContinue:
		err = s.repo.RebaseContinue(r.Context())
	case OpResolveOurs:
		err = s.repo.ResolveConflict(r.Context(), req.Paths[0], false)
	case OpResolveTheirs:
		err = s.repo.ResolveConflict(r.Context(), req.Paths[0], true)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown operation"})
		return
	}
	if err != nil {
		status := http.StatusInternalServerError
		body := map[string]any{"error": err.Error()}
		switch {
		case errors.Is(err, protocol.ErrInvalidPath), errors.Is(err, protocol.ErrNotInRepo), errors.Is(err, protocol.ErrInvalidRef), errors.Is(err, gitx.ErrInvalidResetMode):
			status = http.StatusBadRequest
		case errors.Is(err, gitx.ErrAlreadyInProgress):
			status = http.StatusConflict
			body["code"] = "already-in-progress"
		case errors.Is(err, gitx.ErrPatchDoesNotApply):
			status = http.StatusConflict
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
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
