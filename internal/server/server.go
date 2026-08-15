package server

import (
	"encoding/json"
	"errors"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
)

// Options carries server configuration.
type Options struct {
	// Token is the capability token required in every session URL. When empty,
	// the server rejects all requests.
	Token string
	// Host is the only permitted Host header, e.g. "127.0.0.1:PORT".
	Host string
}

// Server serves the embedded frontend and, in later tasks, the repository API.
type Server struct {
	static   fs.FS
	api      http.Handler
	security Security
}

// New creates a Server that serves static assets from staticFS (rooted at the
// frontend build output) with SPA fallback to index.html for extensionless
// non-API GET routes. /api/ misses return JSON 404.
func New(staticFS fs.FS, opts Options) (*Server, error) {
	if staticFS == nil {
		return nil, errors.New("server: nil static filesystem")
	}
	return &Server{
		static: staticFS,
		security: Security{
			Token: opts.Token,
			Host:  opts.Host,
		},
	}, nil
}

// Handler returns the root handler for the server. When a capability token is
// configured, requests must pass the session security boundary first.
func (s *Server) Handler() http.Handler {
	return s.security.Wrap(http.HandlerFunc(s.ServeHTTP))
}

// ServeHTTP routes requests between the static frontend and the API surface.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		if s.api != nil {
			s.api.ServeHTTP(w, r)
			return
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	s.serveStatic(w, r)
}

func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "." {
		name = "index.html"
	}

	// SPA fallback: extensionless routes that are not real files serve the
	// application shell. Missing files with an extension stay 404 so bad
	// asset URLs do not silently return HTML.
	if !strings.HasSuffix(name, "/") && path.Ext(name) == "" {
		name = "index.html"
	}

	data, err := fs.ReadFile(s.static, name)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	if ct := mime.TypeByExtension(path.Ext(name)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
