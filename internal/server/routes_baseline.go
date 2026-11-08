package server

import (
	"context"
	"net/http"

	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
)

func (s *Server) handleIndexBaseline(w http.ResponseWriter, r *http.Request) {
	repo, ok := s.repo.(interface {
		IndexBaseline(context.Context, string, ...int64) (protocol.EditorBaseline, error)
	})
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "index baseline unavailable"})
		return
	}
	limit, err := worktreeRequestLimit(r, gitx.DefaultDiffBytes)
	if err != nil {
		writeMutationDecodeError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ReadTimeout)
	defer cancel()
	baseline, err := repo.IndexBaseline(ctx, r.URL.Query().Get("path"), limit)
	if err != nil {
		writeWorktreeError(w, r, s, err)
		return
	}
	writeJSON(w, http.StatusOK, baseline)
}
