package server

import (
	"context"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/roie/gitna/internal/session"
)

const pdfLeaseDuration = 5 * time.Minute
const maxPDFPreviews = 64

var errPDFPreviewLimit = errors.New("too many PDF previews")
var errNotPDF = errors.New("not a PDF document")

type pdfGrant struct {
	owner   string
	open    func(context.Context) (*os.File, error)
	info    os.FileInfo
	name    string
	expires time.Time
	ctx     context.Context
	cancel  context.CancelFunc
	timer   *time.Timer
}

// PDFPreviews serves only individually authorized PDF files, on a separate
// loopback origin. It has no app API, cookies, or application capability.
type PDFPreviews struct {
	host      string
	appOrigin string
	mu        sync.Mutex
	grants    map[string]*pdfGrant
	closed    bool
}

type pdfPreviewLease struct {
	Token     string    `json:"token"`
	URL       string    `json:"url"`
	ExpiresAt time.Time `json:"expiresAt"`
}

func NewPDFPreviews(host, appOrigin string) *PDFPreviews {
	return &PDFPreviews{host: host, appOrigin: appOrigin, grants: make(map[string]*pdfGrant)}
}

func (p *PDFPreviews) Origin() string { return "http://" + p.host }

func (p *PDFPreviews) create(ctx context.Context, owner, path string, repo worktreeMediaRepository) (pdfPreviewLease, error) {
	if !strings.EqualFold(filepath.Ext(path), ".pdf") {
		return pdfPreviewLease{}, errNotPDF
	}
	file, err := repo.OpenWorktreeMedia(ctx, path)
	if err != nil {
		return pdfPreviewLease{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return pdfPreviewLease{}, err
	}
	var header [512]byte
	n, err := file.ReadAt(header[:], 0)
	if err != nil && err != io.EOF {
		return pdfPreviewLease{}, err
	}
	if mediaType(path, header[:n]) != "application/pdf" {
		return pdfPreviewLease{}, errNotPDF
	}
	token, err := session.NewToken()
	if err != nil {
		return pdfPreviewLease{}, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return pdfPreviewLease{}, errors.New("PDF previews closed")
	}
	p.removeExpiredLocked()
	if len(p.grants) >= maxPDFPreviews {
		return pdfPreviewLease{}, errPDFPreviewLimit
	}
	grantCtx, cancel := context.WithCancel(context.Background())
	grant := &pdfGrant{
		owner:   owner,
		open:    func(ctx context.Context) (*os.File, error) { return repo.OpenWorktreeMedia(ctx, path) },
		info:    info,
		name:    filepath.Base(path),
		expires: time.Now().Add(pdfLeaseDuration),
		ctx:     grantCtx,
		cancel:  cancel,
	}
	p.grants[token] = grant
	grant.timer = time.AfterFunc(pdfLeaseDuration, func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		p.removeExpiredLocked()
	})
	return p.lease(token, grant), nil
}

func (p *PDFPreviews) lease(token string, grant *pdfGrant) pdfPreviewLease {
	return pdfPreviewLease{Token: token, URL: p.Origin() + "/p/" + token + "/" + url.PathEscape(grant.name), ExpiresAt: grant.expires}
}

func (p *PDFPreviews) removeLocked(token string) {
	if grant := p.grants[token]; grant != nil {
		delete(p.grants, token)
		grant.timer.Stop()
		grant.cancel()
	}
}

func (p *PDFPreviews) removeExpiredLocked() {
	now := time.Now()
	for token, grant := range p.grants {
		if !now.Before(grant.expires) {
			p.removeLocked(token)
		}
	}
}

func (p *PDFPreviews) renew(owner, token string) (pdfPreviewLease, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.removeExpiredLocked()
	grant := p.grants[token]
	if grant == nil || grant.owner != owner {
		return pdfPreviewLease{}, false
	}
	grant.expires = time.Now().Add(pdfLeaseDuration)
	grant.timer.Reset(pdfLeaseDuration)
	return p.lease(token, grant), true
}

func (p *PDFPreviews) revoke(owner, token string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if grant := p.grants[token]; grant != nil && grant.owner == owner {
		p.removeLocked(token)
	}
}

func (p *PDFPreviews) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	for token := range p.grants {
		p.removeLocked(token)
	}
}

func (p *PDFPreviews) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	// Native PDF scripting does not obey all CSP directives. Origin separation
	// and the absence of privileged routes are the application security boundary.
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors "+p.appOrigin)
	if r.Host != p.host {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	parts := strings.Split(r.URL.Path, "/")
	if len(parts) != 4 || parts[1] != "p" || r.URL.RawQuery != "" {
		http.NotFound(w, r)
		return
	}
	p.mu.Lock()
	p.removeExpiredLocked()
	grant := p.grants[parts[2]]
	p.mu.Unlock()
	if grant == nil || parts[3] != grant.name {
		http.NotFound(w, r)
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	stop := context.AfterFunc(grant.ctx, cancel)
	defer stop()
	defer cancel()
	if grant.ctx.Err() != nil {
		http.NotFound(w, r)
		return
	}
	file, err := grant.open(ctx)
	if err != nil {
		http.Error(w, "PDF is no longer available", http.StatusGone)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !os.SameFile(info, grant.info) || info.Size() != grant.info.Size() || !info.ModTime().Equal(grant.info.ModTime()) {
		http.Error(w, "PDF changed; reload the preview", http.StatusGone)
		return
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": grant.name}))
	serveMediaFile(w, r, file, info, ctx)
}

func (s *Server) handlePDFPreview(w http.ResponseWriter, r *http.Request) {
	if s.pdfPreviews == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "PDF preview unavailable"})
		return
	}
	owner := s.draftFolderKey
	switch r.Method {
	case http.MethodPost:
		repo, ok := s.repo.(worktreeMediaRepository)
		if !ok {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "PDF preview unavailable"})
			return
		}
		lease, err := s.pdfPreviews.create(r.Context(), owner, r.URL.Query().Get("path"), repo)
		if errors.Is(err, errNotPDF) {
			writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "Not a PDF document"})
			return
		}
		if errors.Is(err, errPDFPreviewLimit) {
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "Close a PDF preview and try again"})
			return
		}
		if err != nil {
			writeWorktreeError(w, r, s, err)
			return
		}
		writeJSON(w, http.StatusCreated, lease)
	case http.MethodPut:
		lease, ok := s.pdfPreviews.renew(owner, r.URL.Query().Get("token"))
		if !ok {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusOK, lease)
	case http.MethodDelete:
		s.pdfPreviews.revoke(owner, r.URL.Query().Get("token"))
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}
