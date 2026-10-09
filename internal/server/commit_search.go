package server

import (
	"context"
	"net/http"

	"github.com/roie/gitna/internal/protocol"
)

type commitSearchRepo interface {
	SearchCommits(context.Context, string, bool, int) (protocol.GraphPage, error)
}

func (s *Server) handleCommitSearch(w http.ResponseWriter, r *http.Request) {
	repo, ok := s.repo.(commitSearchRepo)
	if !ok {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "commit search unavailable"})
		return
	}
	query := r.URL.Query().Get("q")
	skip, err := parseNonNegInt(r.URL.Query().Get("skip"))
	if err != nil || len(query) > 1024 || skip > 10000 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid commit search"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), GraphTimeout)
	defer cancel()
	generation := s.gen.Load()
	page, err := repo.SearchCommits(ctx, query, r.URL.Query().Get("all") == "1", skip)
	if err != nil {
		status := http.StatusInternalServerError
		if timeoutReached(ctx, err) {
			status = http.StatusGatewayTimeout
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	if generation != s.gen.Load() {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "folder changed while searching commits"})
		return
	}
	page.Generation = generation
	writeJSON(w, http.StatusOK, page)
}
