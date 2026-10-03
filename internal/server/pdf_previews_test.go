package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/roie/gitna/internal/gitx"
)

func pdfTestApp(t *testing.T) (*PDFPreviews, http.Handler, string) {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "sample.pdf"), []byte("%PDF-1.4\n"+strings.Repeat(" ", 1024)), 0600); err != nil {
		t.Fatal(err)
	}
	previews := NewPDFPreviews("127.0.0.1:5678", "http://"+testHost)
	t.Cleanup(previews.Close)
	app, err := New(newTestFS(), Options{Token: testToken, Host: testHost, Repo: &mediaTestRepo{fakeRepo: &fakeRepo{}, disk: gitx.Repository{Root: root}}, DraftFolderKey: root, PDFPreviews: previews})
	if err != nil {
		t.Fatal(err)
	}
	return previews, app.Handler(), root
}

func createPDFLease(t *testing.T, app http.Handler) pdfPreviewLease {
	t.Helper()
	response := worktreeRequest(t, app, "POST", "/pdf-preview?path=sample.pdf", "{}")
	if response.Code != 201 {
		t.Fatalf("create=%d %s", response.Code, response.Body)
	}
	var lease pdfPreviewLease
	if err := json.Unmarshal(response.Body.Bytes(), &lease); err != nil {
		t.Fatal(err)
	}
	return lease
}

func pdfRequest(p *PDFPreviews, method, url, byteRange string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, url, nil)
	req.Header.Set("Range", byteRange)
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)
	return rec
}

func TestPDFPreviewOriginAndRanges(t *testing.T) {
	p, app, _ := pdfTestApp(t)
	lease := createPDFLease(t, app)
	if strings.Contains(lease.URL, testToken) || !strings.HasPrefix(lease.URL, p.Origin()+"/p/") {
		t.Fatal("application authority exposed", lease.URL)
	}
	for _, tt := range []struct {
		method, byteRange string
		status, length    int
	}{
		{"GET", "", 200, 1033}, {"HEAD", "", 200, 0}, {"GET", "bytes=0-7", 206, 8}, {"GET", "bytes=-5", 206, 5}, {"GET", "bytes=5000-", 416, -1}, {"GET", "bytes=0-1,5-6", 416, -1},
	} {
		rec := pdfRequest(p, tt.method, lease.URL, tt.byteRange)
		if rec.Code != tt.status || tt.length >= 0 && rec.Body.Len() != tt.length {
			t.Fatalf("%+v: status=%d bytes=%d", tt, rec.Code, rec.Body.Len())
		}
		if rec.Header().Get("Cache-Control") != "no-store" || rec.Header().Get("Referrer-Policy") != "no-referrer" || rec.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatal(rec.Header())
		}
		if tt.status < 400 && (rec.Header().Get("Content-Type") != "application/pdf" || !strings.HasPrefix(rec.Header().Get("Content-Disposition"), "inline;")) {
			t.Fatal(rec.Header())
		}
		if !strings.Contains(rec.Header().Get("Content-Security-Policy"), "frame-ancestors http://"+testHost) {
			t.Fatal(rec.Header())
		}
		if rec.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatal("CORS grant on PDF origin")
		}
	}
	rec := worktreeRequest(t, app, "GET", "/media?path=sample.pdf", "")
	if !strings.HasPrefix(rec.Header().Get("Content-Disposition"), "attachment;") {
		t.Fatal("PDF inline on app origin")
	}
	if !strings.Contains(rec.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Fatal("app-origin file framing allowed")
	}
}

func TestPDFPreviewAuthorityBoundaries(t *testing.T) {
	p, app, _ := pdfTestApp(t)
	lease := createPDFLease(t, app)
	for _, path := range []string{"/", "/api/v1/snapshot", "/g/" + testToken + "/api/v1/snapshot", "/p/unknown/document.pdf", "/p/" + lease.Token + "/other.pdf"} {
		if r := pdfRequest(p, "GET", p.Origin()+path, ""); r.Code != 404 {
			t.Fatalf("served %s: %d", path, r.Code)
		}
	}
	if r := pdfRequest(p, "GET", lease.URL+"?path=../secret", ""); r.Code != 404 {
		t.Fatal("query altered scope")
	}
	for _, method := range []string{"POST", "PUT", "DELETE", "OPTIONS"} {
		if r := pdfRequest(p, method, lease.URL, ""); r.Code != 405 {
			t.Fatalf("PDF origin permits %s", method)
		}
	}
	req := httptest.NewRequest("GET", lease.URL, nil)
	req.Host = "attacker.example"
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Fatal("bad Host accepted")
	}
	for _, origin := range []string{p.Origin(), "null"} {
		for _, method := range []string{"POST", "PUT", "DELETE"} {
			req := httptest.NewRequest(method, "/g/"+testToken+"/api/v1/pdf-preview?token="+lease.Token+"&path=sample.pdf", strings.NewReader("{}"))
			req.Host = testHost
			req.Header.Set("Origin", origin)
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			app.ServeHTTP(rec, req)
			if rec.Code != 403 {
				t.Fatalf("%s can %s leases: %d", origin, method, rec.Code)
			}
		}
	}
	if r := pdfRequest(p, "GET", lease.URL, ""); r.Code != 200 {
		t.Fatal("cross-origin revoke succeeded")
	}
	req = httptest.NewRequest("POST", "/api/v1/pdf-preview?path=sample.pdf", strings.NewReader("{}"))
	req.Host = testHost
	rec = httptest.NewRecorder()
	app.ServeHTTP(rec, req)
	if rec.Code != 404 {
		t.Fatal("mint without app capability")
	}
}

func TestPDFPreviewLifecycle(t *testing.T) {
	p, app, root := pdfTestApp(t)
	lease := createPDFLease(t, app)
	// Model elapsed lease time without relying on Windows' clock resolution.
	p.mu.Lock()
	lease.ExpiresAt = lease.ExpiresAt.Add(-time.Second)
	p.grants[lease.Token].expires = lease.ExpiresAt
	p.mu.Unlock()
	renewed, ok := p.renew(root, lease.Token)
	if !ok || renewed.URL != lease.URL || !renewed.ExpiresAt.After(lease.ExpiresAt) {
		t.Fatal("renewal failed")
	}
	if _, ok := p.renew("another-folder", lease.Token); ok {
		t.Fatal("cross-folder renew")
	}
	p.revoke("another-folder", lease.Token)
	if r := pdfRequest(p, "GET", lease.URL, ""); r.Code != 200 {
		t.Fatal("cross-folder revoke")
	}
	grantCtx := p.grants[lease.Token].ctx
	if r := worktreeRequest(t, app, "DELETE", "/pdf-preview?token="+lease.Token, "{}"); r.Code != 204 {
		t.Fatal(r.Code)
	}
	if grantCtx.Err() != context.Canceled {
		t.Fatal("in-flight reads not cancelled")
	}
	if r := pdfRequest(p, "GET", lease.URL, ""); r.Code != 404 {
		t.Fatal("revoked token served")
	}
	if r := worktreeRequest(t, app, "PUT", "/pdf-preview?token="+lease.Token, "{}"); r.Code != 404 {
		t.Fatal("revived revoked lease")
	}
	lease = createPDFLease(t, app)
	p.mu.Lock()
	p.grants[lease.Token].expires = time.Now().Add(20 * time.Millisecond)
	p.grants[lease.Token].timer.Reset(20 * time.Millisecond)
	expired := p.grants[lease.Token].ctx.Done()
	p.mu.Unlock()
	select {
	case <-expired:
	case <-time.After(2 * time.Second):
		t.Fatal("idle capability did not expire")
	}
	if r := pdfRequest(p, "GET", lease.URL, ""); r.Code != 404 {
		t.Fatal("expired token served")
	}
	if _, ok := p.renew(root, lease.Token); ok {
		t.Fatal("expired lease revived")
	}
	lease = createPDFLease(t, app)
	p.Close()
	if r := pdfRequest(p, "GET", lease.URL, ""); r.Code != 404 {
		t.Fatal("closed broker served")
	}
}

func TestPDFPreviewRejectsStaleAndUnsafeFiles(t *testing.T) {
	p, app, root := pdfTestApp(t)
	lease := createPDFLease(t, app)
	if err := os.WriteFile(filepath.Join(root, "sample.pdf"), []byte("%PDF-1.4\nchanged"), 0600); err != nil {
		t.Fatal(err)
	}
	if r := pdfRequest(p, "GET", lease.URL, ""); r.Code != 410 {
		t.Fatal("stale contents served")
	}
	lease = createPDFLease(t, app)
	if err := os.Remove(filepath.Join(root, "sample.pdf")); err != nil {
		t.Fatal(err)
	}
	if r := pdfRequest(p, "GET", lease.URL, ""); r.Code != 410 {
		t.Fatal("deleted file served")
	}
	if err := os.WriteFile(filepath.Join(root, "fake.pdf"), []byte("<script>alert(1)</script>"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"fake.pdf", "../outside.pdf", ".git/config.pdf", "missing.pdf"} {
		if r := worktreeRequest(t, app, "POST", "/pdf-preview?path="+path, "{}"); r.Code < 400 {
			t.Fatalf("authorized %s", path)
		}
	}
}

func TestPDFPreviewBoundedLeases(t *testing.T) {
	p, app, _ := pdfTestApp(t)
	first := createPDFLease(t, app)
	for i := 1; i < maxPDFPreviews; i++ {
		createPDFLease(t, app)
	}
	if r := worktreeRequest(t, app, "POST", "/pdf-preview?path=sample.pdf", "{}"); r.Code != 429 {
		t.Fatal("unbounded leases")
	}
	worktreeRequest(t, app, "DELETE", "/pdf-preview?token="+first.Token, "{}")
	fresh := createPDFLease(t, app)
	// A cancelled HTTP read must not return the document bytes.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest("GET", fresh.URL, nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)
	if bytes.Contains(rec.Body.Bytes(), []byte("%PDF-")) {
		t.Fatal("cancelled read delivered PDF")
	}
}
