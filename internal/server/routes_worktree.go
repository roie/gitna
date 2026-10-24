package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"

	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
)

// JSON may escape each source byte as a six-byte \uXXXX sequence.
const worktreeRequestBodyLimit = gitx.DefaultDiffBytes*6 + 16<<10

type worktreeResourceRepository interface {
	ReadWorktreeResource(context.Context, string) ([]byte, error)
}

type worktreeRepository interface {
	ReadWorktreeFile(context.Context, string, ...int64) (protocol.WorktreeFile, error)
	CompareWorktreeFiles(context.Context, string, string) (protocol.FileDiff, error)
	WriteWorktreeFile(context.Context, string, string, string, ...int64) (protocol.WorktreeFile, error)
	CreateWorktreeFile(context.Context, string, string, ...int64) (protocol.WorktreeFile, error)
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

func (s *Server) handleReadWorktreeResource(w http.ResponseWriter, r *http.Request) {
	repo, ok := s.repo.(worktreeResourceRepository)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "worktree resources unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ReadTimeout)
	defer cancel()
	path := r.URL.Query().Get("path")
	data, err := repo.ReadWorktreeResource(ctx, path)
	if err != nil {
		writeWorktreeError(w, r, s, err)
		return
	}
	contentType := http.DetectContentType(data)
	if contentType != "image/png" && contentType != "image/jpeg" && contentType != "image/gif" && contentType != "image/webp" {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "resource is not a supported image"})
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(data)
	}
}

func (s *Server) handleReadWorktreeFile(w http.ResponseWriter, r *http.Request) {
	repo, ok := s.worktreeRepository()
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "worktree files unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ReadTimeout)
	defer cancel()
	limit, err := worktreeRequestLimit(r, gitx.DefaultDiffBytes)
	if err != nil {
		writeMutationDecodeError(w, err)
		return
	}
	file, err := repo.ReadWorktreeFile(ctx, r.URL.Query().Get("path"), limit)
	if err != nil {
		writeWorktreeError(w, r, s, err)
		return
	}
	etag := strconv.Quote(file.Hash)
	w.Header().Set("ETag", etag)
	if file.Hash != "" && r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
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
	limit, _ := worktreeRequestLimit(r, gitx.DefaultDiffBytes)
	file, err := repo.WriteWorktreeFile(ctx, req.Path, req.Content, req.ExpectedHash, limit)
	if err != nil {
		writeWorktreeError(w, r, s, err)
		return
	}
	s.gen.Add(1)
	writeJSON(w, http.StatusOK, file)
}

func (s *Server) handleCreateWorktreeFile(w http.ResponseWriter, r *http.Request) {
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
	limit, _ := worktreeRequestLimit(r, gitx.DefaultDiffBytes)
	file, err := repo.CreateWorktreeFile(ctx, req.Path, req.Content, limit)
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
	limit, err := worktreeRequestLimit(r, gitx.DefaultDiffBytes)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit*6+16<<10))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing json.RawMessage
	err = decoder.Decode(&trailing)
	if err == io.EOF {
		return nil
	}
	if err == nil {
		return errors.New("request body must contain exactly one JSON value")
	}
	return err
}

func worktreeRequestLimit(r *http.Request, fallback int64) (int64, error) {
	value := r.URL.Query().Get("maxBytes")
	if value == "" {
		return fallback, nil
	}
	limit, err := strconv.ParseInt(value, 10, 64)
	// Leave room for JSON escaping and envelope overhead without integer overflow.
	if err != nil || limit <= 0 || limit > (1<<63-1-32<<10)/6 {
		return 0, errors.New("maxBytes must be a positive byte budget")
	}
	return max(fallback, limit), nil
}

func writeWorktreeError(w http.ResponseWriter, r *http.Request, s *Server, err error) {
	switch {
	case errors.Is(err, os.ErrNotExist):
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error(), "code": "file-not-found"})
	case errors.Is(err, protocol.ErrWorktreeFileTooLarge):
		body := map[string]any{"error": err.Error(), "code": "file-too-large"}
		var limitError *gitx.WorktreeFileLimitError
		if errors.As(err, &limitError) {
			body["sizeBytes"] = limitError.SizeBytes
			body["limitBytes"] = limitError.LimitBytes
		}
		writeJSON(w, http.StatusRequestEntityTooLarge, body)
	case errors.Is(err, protocol.ErrWorktreeBinary):
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]any{"error": err.Error(), "code": "binary-file"})
	case errors.Is(err, protocol.ErrWorktreeEncoding):
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]any{"error": err.Error(), "code": "unsupported-encoding"})
	case errors.Is(err, protocol.ErrWorktreeConflict):
		writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error(), "code": "stale-file"})
	case errors.Is(err, protocol.ErrWorktreeEntryExists):
		writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error(), "code": "entry-exists"})
	default:
		writeMutationError(w, r, s, err)
	}
}
