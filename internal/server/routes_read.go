package server

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/roie/gitna/internal/protocol"
)

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
	q := r.URL.Query()
	opts := protocol.DiffOptions{
		Path:        q.Get("path"),
		OldPath:     q.Get("oldPath"),
		Commit:      q.Get("commit"),
		CompareFrom: q.Get("from"),
		CompareTo:   q.Get("to"),
	}
	d, err := s.repo.Diff(r.Context(), protocol.DiffScope(q.Get("scope")), opts)
	if err != nil {
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
	snap, err := s.repo.Snapshot(r.Context())
	if err != nil {
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
	commits, err := s.repo.History(r.Context(), skip, graphPageSize)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, protocol.GraphPage{
		Commits: commits,
		HasMore: len(commits) == graphPageSize,
	})
}

// handleCommitFiles returns the paths changed by one commit. The OID is the
// path segment between /commit/ and /files and is validated by the gitx layer
// before reaching Git.
func (s *Server) handleCommitFiles(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	oid := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/api/v1"), "/commit/")
	oid = strings.TrimSuffix(oid, "/files")
	files, err := s.repo.FilesChanged(r.Context(), oid)
	if err != nil {
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
