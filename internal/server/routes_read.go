package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/roie/gitna/internal/protocol"
)

// timeoutReached checks whether a handler should return 504: either the
// context deadline actually expired, or the repo returned a context error
// directly (which our slowRepo tests do).
func timeoutReached(ctx context.Context, err error) bool {
	return ctx.Err() == context.DeadlineExceeded || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled)
}

// apiRoutes builds the versioned API router.
func (s *Server) apiRoutes() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/api/v1")
		switch {
		case r.Method == http.MethodGet && p == "/snapshot":
			s.handleSnapshot(w, r)
		case r.Method == http.MethodGet && p == "/diff":
			s.handleDiff(w, r)
		case r.Method == http.MethodGet && p == "/graph":
			s.handleGraph(w, r)
		case r.Method == http.MethodGet && p == "/branches":
			s.handleBranches(w, r)
		case r.Method == http.MethodGet && p == "/stashes":
			s.handleStashes(w, r)
		case r.Method == http.MethodGet && p == "/tags":
			s.handleTags(w, r)
		case r.Method == http.MethodGet && p == "/conflicts":
			s.handleConflicts(w, r)
		case r.Method == http.MethodGet && p == "/compare":
			s.handleCompare(w, r)
		case r.Method == http.MethodGet && strings.HasPrefix(p, "/commit/") && strings.HasSuffix(p, "/files"):
			s.handleCommitFiles(w, r)
		case r.Method == http.MethodGet && p == "/events":
			s.handleEvents(w, r)
		case r.Method == http.MethodPost && p == "/operations":
			s.handleOperation(w, r)
		default:
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		}
	})
}

// handleDiff returns the before/after content of one changed file in the
// requested scope. Scope comes from the scope query parameter; Path, OldPath,
// and commit/compare refs are validated by the gitx layer, and the protocol
// sentinel errors are mapped to client-friendly status codes.
func (s *Server) handleDiff(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), DiffTimeout)
	defer cancel()
	q := r.URL.Query()
	opts := protocol.DiffOptions{
		Path:        q.Get("path"),
		OldPath:     q.Get("oldPath"),
		Commit:      q.Get("commit"),
		CompareFrom: q.Get("from"),
		CompareTo:   q.Get("to"),
	}
	d, err := s.repo.Diff(ctx, protocol.DiffScope(q.Get("scope")), opts)
	if err != nil {
		if timeoutReached(ctx, err) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "diff timed out"})
			return
		}
		status := http.StatusInternalServerError
		switch {
		case errors.Is(err, protocol.ErrInvalidPath), errors.Is(err, protocol.ErrInvalidRef):
			status = http.StatusBadRequest
		case errors.Is(err, protocol.ErrNotInRepo):
			status = http.StatusBadRequest
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// handleSnapshot returns the normalized repository state. The generation
// counter advances per response so the browser can discard stale reads that
// race a newer refresh.
func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), SnapshotTimeout)
	defer cancel()
	snap, err := s.repo.Snapshot(ctx)
	if err != nil {
		if timeoutReached(ctx, err) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "snapshot timed out"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	snap.Generation = s.gen.Add(1)
	writeJSON(w, http.StatusOK, snap)
}

// graphPageSize bounds a single history page; the frontend appends pages until
// HasMore clears.
const graphPageSize = 100

// handleGraph returns a page of history in topological order. skip advances
// the page for pagination; the page size is capped so a busy repository cannot
// ship unbounded output.
func (s *Server) handleGraph(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	skip, err := parseNonNegInt(r.URL.Query().Get("skip"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	limit := graphPageSize
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid limit value"})
			return
		}
		if n > graphMaxPage {
			n = graphMaxPage
		}
		limit = n
	}
	ctx, cancel := context.WithTimeout(r.Context(), GraphTimeout)
	defer cancel()
	commits, err := s.repo.History(ctx, skip, limit)
	if err != nil {
		if timeoutReached(ctx, err) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "history timed out"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, protocol.GraphPage{
		Commits: commits,
		HasMore: len(commits) == limit,
	})
}

// handleBranches returns every local and remote branch with its upstream
// relationship, for the branch/switching UI.
func (s *Server) handleBranches(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ReadTimeout)
	defer cancel()
	branches, err := s.repo.Branches(ctx)
	if err != nil {
		if timeoutReached(ctx, err) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "branches timed out"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, branches)
}

// handleCommitFiles returns the paths changed by one commit. The OID is the
// path segment between /commit/ and /files and is validated by the gitx layer
// before reaching Git.
func (s *Server) handleCommitFiles(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ReadTimeout)
	defer cancel()
	oid := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/api/v1"), "/commit/")
	oid = strings.TrimSuffix(oid, "/files")
	files, err := s.repo.FilesChanged(ctx, oid)
	if err != nil {
		if timeoutReached(ctx, err) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "commit files timed out"})
			return
		}
		status := http.StatusInternalServerError
		if errors.Is(err, protocol.ErrInvalidRef) {
			status = http.StatusBadRequest
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, protocol.CommitFiles{Files: files})
}

// handleStashes returns the current stash list with display refs, OIDs, and
// parsed subjects for the stash management UI.
func (s *Server) handleStashes(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ReadTimeout)
	defer cancel()
	entries, err := s.repo.Stashes(ctx)
	if err != nil {
		if timeoutReached(ctx, err) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "stashes timed out"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

// handleTags returns every tag (lightweight and annotated) with its target OID
// for the tag management UI.
func (s *Server) handleTags(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ReadTimeout)
	defer cancel()
	tags, err := s.repo.Tags(ctx)
	if err != nil {
		if timeoutReached(ctx, err) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "tags timed out"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, tags)
}

// handleCompare returns the name-status change set between two refs, reusing
// the diff pipeline so the frontend compare view renders like a commit.
func (s *Server) handleCompare(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	q := r.URL.Query()
	from := q.Get("from")
	to := q.Get("to")
	if from == "" || to == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "compare requires from and to"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ReadTimeout)
	defer cancel()
	files, err := s.repo.CompareFiles(ctx, from, to)
	if err != nil {
		if timeoutReached(ctx, err) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "compare timed out"})
			return
		}
		status := http.StatusInternalServerError
		if errors.Is(err, protocol.ErrInvalidRef) {
			status = http.StatusBadRequest
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, protocol.CommitFiles{Files: files})
}

// parseNonNegInt parses a non-negative integer query value; empty means zero.
func parseNonNegInt(s string) (int, error) {
	if s == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("invalid skip value %q", s)
	}
	return n, nil
}

// handleConflicts returns the unmerged files from the index. Each entry
// carries the path and per-side OIDs for base/ours/theirs so the frontend
// can show a3-way conflict view and offer explicit resolution actions.
func (s *Server) handleConflicts(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ReadTimeout)
	defer cancel()
	conflicts, err := s.repo.Conflicts(ctx)
	if err != nil {
		if timeoutReached(ctx, err) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "conflicts timed out"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, conflicts)
}
