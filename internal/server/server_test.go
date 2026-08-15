package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func newTestFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html": &fstest.MapFile{
			Data: []byte("<!doctype html><title>gitna</title>"),
		},
		"assets/app.js": &fstest.MapFile{
			Data: []byte("console.log('gitna')"),
		},
	}
}

func TestServesIndexAtRoot(t *testing.T) {
	srv, err := New(newTestFS(), Options{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if !strings.Contains(rec.Body.String(), "gitna") {
		t.Fatalf("body %q does not contain index content", rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("content-type = %q, want text/html", ct)
	}
}

func TestServesAssets(t *testing.T) {
	srv, err := New(newTestFS(), Options{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Body.String(); got != "console.log('gitna')" {
		t.Fatalf("body = %q, want asset content", got)
	}
}

func TestSpaFallbackForExtensionlessRoutes(t *testing.T) {
	srv, err := New(newTestFS(), Options{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/some/spa/route", nil)
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (SPA fallback to index)", rec.Code, http.StatusOK)
	}
	if !strings.Contains(rec.Body.String(), "gitna") {
		t.Fatalf("body %q does not contain index content", rec.Body.String())
	}
}

func TestMissingAssetReturnsNotFound(t *testing.T) {
	srv, err := New(newTestFS(), Options{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/assets/missing.js", nil)
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

func TestAPIMissReturnsJSON404(t *testing.T) {
	srv, err := New(newTestFS(), Options{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/does-not-exist", nil)
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("content-type = %q, want application/json", ct)
	}
}

func TestNewRejectsNilFS(t *testing.T) {
	if _, err := New(nil, Options{}); err == nil {
		t.Fatal("New(nil, ...) = nil error, want error")
	}
}
