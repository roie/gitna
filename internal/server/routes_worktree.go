package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"

	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
)

// JSON may escape each source byte as a six-byte \uXXXX sequence.
const worktreeRequestBodyLimit = gitx.DefaultDiffBytes*6 + 16<<10

type worktreeRepository interface {
	ReadWorktreeFile(context.Context, string) (protocol.WorktreeFile, error)
	CompareWorktreeFiles(context.Context, string, string) (protocol.FileDiff, error)
	WriteWorktreeFile(context.Context, string, string, string) (protocol.WorktreeFile, error)
	CreateWorktreeEntry(context.Context, string, bool) error
	RenameWorktreeEntry(context.Context, string, string) error
}

type worktreeFileRequest struct {
	Path         string `json:"path"`
	Content      string `json:"content"`
	ExpectedHash string `json:"expectedHash"`
}

type worktreeEntryRequest struct {
	Path        string `json:"path"`
	Directory   bool   `json:"directory"`
	Source      string `json:"source"`
	Destination string `json:"destination"`
}

func (s *Server) worktreeRepository() (worktreeRepository, bool) {
	repo, ok := s.repo.(worktreeRepository)
	return repo, ok
}

func (s *Server) handleReadWorktreeFile(w http.ResponseWriter, r *http.Request) {
	repo, ok := s.worktreeRepository()
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "worktree files unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ReadTimeout)
	defer cancel()
	file, err := repo.ReadWorktreeFile(ctx, r.URL.Query().Get("path"))
	if err != nil {
		writeWorktreeError(w, r, s, err)
		return
	}
	writeJSON(w, http.StatusOK, file)
}

func (s *Server) handleCompareWorktreeFiles(w http.ResponseWriter, r *http.Request) {
	repo, ok := s.worktreeRepository()
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "worktree files unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ReadTimeout)
	defer cancel()
	comparison, err := repo.CompareWorktreeFiles(
		ctx,
		r.URL.Query().Get("left"),
		r.URL.Query().Get("right"),
	)
	if err != nil {
		writeWorktreeError(w, r, s, err)
		return
	}
	writeJSON(w, http.StatusOK, comparison)
}

func (s *Server) handleWriteWorktreeFile(w http.ResponseWriter, r *http.Request) {
	repo, ok := s.worktreeRepository()
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "worktree files unavailable"})
		return
	}
	var req worktreeFileRequest
	if err := decodeWorktreeRequest(w, r, &req); err != nil {
		writeMutationDecodeError(w, err)
		return
	}
	ctx, cancel := withTimeout(r.Context(), LocalMutationTimeout)
	defer cancel()
	file, err := repo.WriteWorktreeFile(ctx, req.Path, req.Content, req.ExpectedHash)
	if err != nil {
		writeWorktreeError(w, r, s, err)
		return
	}
	s.gen.Add(1)
	writeJSON(w, http.StatusOK, file)
}

func (s *Server) handleCreateWorktreeEntry(w http.ResponseWriter, r *http.Request) {
	repo, ok := s.worktreeRepository()
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "worktree files unavailable"})
		return
	}
	var req worktreeEntryRequest
	if err := decodeWorktreeRequest(w, r, &req); err != nil {
		writeMutationDecodeError(w, err)
		return
	}
	ctx, cancel := withTimeout(r.Context(), LocalMutationTimeout)
	defer cancel()
	if err := repo.CreateWorktreeEntry(ctx, req.Path, req.Directory); err != nil {
		writeWorktreeError(w, r, s, err)
		return
	}
	s.gen.Add(1)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleRenameWorktreeEntry(w http.ResponseWriter, r *http.Request) {
	repo, ok := s.worktreeRepository()
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "worktree files unavailable"})
		return
	}
	var req worktreeEntryRequest
	if err := decodeWorktreeRequest(w, r, &req); err != nil {
		writeMutationDecodeError(w, err)
		return
	}
	ctx, cancel := withTimeout(r.Context(), LocalMutationTimeout)
	defer cancel()
	if err := repo.RenameWorktreeEntry(ctx, req.Source, req.Destination); err != nil {
		writeWorktreeError(w, r, s, err)
		return
	}
	s.gen.Add(1)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func decodeWorktreeRequest(w http.ResponseWriter, r *http.Request, target any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, worktreeRequestBodyLimit))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing json.RawMessage
	err := decoder.Decode(&trailing)
	if err == io.EOF {
		return nil
	}
	if err == nil {
		return errors.New("request body must contain exactly one JSON value")
	}
	return err
}

func writeWorktreeError(w http.ResponseWriter, r *http.Request, s *Server, err error) {
	switch {
	case errors.Is(err, os.ErrNotExist):
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error(), "code": "file-not-found"})
	case errors.Is(err, protocol.ErrWorktreeFileTooLarge):
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": err.Error(), "code": "file-too-large"})
	case errors.Is(err, protocol.ErrWorktreeBinary):
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]any{"error": err.Error(), "code": "binary-file"})
	case errors.Is(err, protocol.ErrWorktreeConflict):
		writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error(), "code": "stale-file"})
	case errors.Is(err, protocol.ErrWorktreeEntryExists):
		writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error(), "code": "entry-exists"})
	default:
		writeMutationError(w, r, s, err)
	}
}
