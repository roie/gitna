package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

type openFolderRequest struct {
	Path string `json:"path"`
}

func (s *Server) handleOpenFolder(w http.ResponseWriter, r *http.Request) {
	if s.openFolder == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "folder opening unavailable"})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, MaxRequestBody)
	var request openFolderRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	request.Path = strings.TrimSpace(request.Path)
	if request.Path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "folder path is required"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), LocalMutationTimeout)
	defer cancel()
	result, err := s.openFolder(ctx, request.Path)
	if err != nil {
		if timeoutReached(ctx, err) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "folder open timed out"})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleRevealFolder(w http.ResponseWriter, r *http.Request) {
	if s.revealFolder == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "folder reveal unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), LocalMutationTimeout)
	defer cancel()
	if err := s.revealFolder(ctx); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
