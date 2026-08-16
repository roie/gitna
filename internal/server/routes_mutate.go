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
	OpStage   = "stage"
	OpUnstage = "unstage"
	OpDiscard = "discard"
	OpDelete  = "delete"
	OpPatch   = "patch"
	OpCommit  = "commit"
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
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown operation"})
		return
	}
	if err != nil {
		status := http.StatusInternalServerError
		switch {
		case errors.Is(err, protocol.ErrInvalidPath), errors.Is(err, protocol.ErrNotInRepo):
			status = http.StatusBadRequest
		case errors.Is(err, gitx.ErrPatchDoesNotApply):
			status = http.StatusConflict
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
