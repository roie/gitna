package server

import (
	"net/http"
	"strings"
)

// apiRoutes builds the versioned API router. Mutation routes are registered by
// later tasks.
func (s *Server) apiRoutes() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/api/v1")
		switch {
		case r.Method == http.MethodGet && p == "/snapshot":
			s.handleSnapshot(w, r)
		default:
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		}
	})
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
