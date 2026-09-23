package server

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type worktreeMediaRepository interface {
	OpenWorktreeMedia(context.Context, string) (*os.File, error)
}

func mediaType(path string, header []byte) string {
	detected := http.DetectContentType(header)
	switch strings.ToLower(filepath.Ext(path)) {
	case ".pdf":
		if detected == "application/pdf" {
			return detected
		}
	case ".wav":
		if detected == "audio/wave" {
			return "audio/wav"
		}
	case ".mp3":
		if detected == "audio/mpeg" {
			return detected
		}
	case ".ogg", ".oga":
		if detected == "application/ogg" {
			return "audio/ogg"
		}
	case ".ogv":
		if detected == "application/ogg" {
			return "video/ogg"
		}
	case ".webm":
		if detected == "video/webm" {
			return detected
		}
	case ".mp4", ".m4v":
		if detected == "video/mp4" {
			return "video/mp4"
		}
	case ".m4a":
		if detected == "video/mp4" {
			return "audio/mp4"
		}
		// Go's MP4 sniffer does not recognize the M4A brand emitted by AAC encoders.
		if len(header) >= 16 && string(header[4:12]) == "ftypM4A " {
			size := binary.BigEndian.Uint32(header[:4])
			if size >= 16 && size%4 == 0 && uint64(size) <= uint64(len(header)) {
				return "audio/mp4"
			}
		}
	case ".flac":
		if len(header) >= 4 && string(header[:4]) == "fLaC" {
			return "audio/flac"
		}
	}
	return ""
}

func supportedMediaPath(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".pdf", ".wav", ".mp3", ".ogg", ".oga", ".ogv", ".webm", ".mp4", ".m4v", ".m4a", ".flac":
		return true
	}
	return false
}

func (s *Server) handleWorktreeMedia(w http.ResponseWriter, r *http.Request) {
	// These bytes must never become an executable app-origin document, even when
	// someone navigates directly to the media URL instead of using native controls.
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	path := r.URL.Query().Get("path")
	if !supportedMediaPath(path) {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "Unsupported media format."})
		return
	}
	repo, ok := s.repo.(worktreeMediaRepository)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Media unavailable."})
		return
	}
	file, err := repo.OpenWorktreeMedia(r.Context(), path)
	if err != nil {
		writeWorktreeError(w, r, s, err)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		writeWorktreeError(w, r, s, err)
		return
	}
	var header [512]byte
	n, err := file.ReadAt(header[:], 0)
	if err != nil && err != io.EOF {
		writeWorktreeError(w, r, s, err)
		return
	}
	contentType := mediaType(path, header[:n])
	download := r.URL.Query().Get("download") == "1"
	// PDFs are never inline on the privileged app origin. Native previews use
	// the separate PDF-only origin and their own file-scoped capabilities.
	if strings.EqualFold(filepath.Ext(path), ".pdf") {
		download = true
	}
	if download {
		contentType = "application/octet-stream"
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filepath.Base(path)}))
	} else if contentType == "" {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "This file is not a supported media container. Download it to open it locally."})
		return
	}
	w.Header().Set("Content-Type", contentType)
	serveMediaFile(w, r, file, info, r.Context())
}

func serveMediaFile(w http.ResponseWriter, r *http.Request, file *os.File, info os.FileInfo, ctx context.Context) {
	// Native players need single byte ranges. Refuse multipart amplification and
	// oversized range parsing; the standard library handles valid/suffix/416 cases.
	if value := r.Header.Get("Range"); len(value) > 256 || strings.Contains(value, ",") {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", info.Size()))
		http.Error(w, "Only a single byte range is supported.", http.StatusRequestedRangeNotSatisfiable)
		return
	}
	http.ServeContent(mediaResponse{w}, r, "", time.Time{}, &mediaReader{Context: ctx, File: file})
}

type mediaResponse struct{ http.ResponseWriter }

func (w mediaResponse) WriteHeader(status int) {
	// ServeContent clears Cache-Control on range errors by default.
	w.Header().Set("Cache-Control", "no-store")
	w.ResponseWriter.WriteHeader(status)
}

type mediaReader struct {
	context.Context
	*os.File
}

func (r *mediaReader) Read(p []byte) (int, error) {
	if err := r.Err(); err != nil {
		return 0, err
	}
	return r.File.Read(p)
}
