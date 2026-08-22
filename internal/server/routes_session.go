package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

type switchRepositoryRequest struct {
	Path string `json:"path"`
}

func (s *Server) handleSwitchRepository(w http.ResponseWriter, r *http.Request) {
	if s.switchRepository == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "repository switching unavailable"})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, MaxRequestBody)
	var request switchRepositoryRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	request.Path = strings.TrimSpace(request.Path)
	if request.Path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "repository path is required"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), LocalMutationTimeout)
	defer cancel()
	root, err := s.switchRepository(ctx, request.Path)
	if err != nil {
		if timeoutReached(ctx, err) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "repository switch timed out"})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	s.gen.Add(1)
	writeJSON(w, http.StatusOK, map[string]string{"root": root})
}

func (s *Server) handleRevealRepository(w http.ResponseWriter, r *http.Request) {
	if s.revealRepository == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "repository reveal unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), LocalMutationTimeout)
	defer cancel()
	if err := s.revealRepository(ctx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
