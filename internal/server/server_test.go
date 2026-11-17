package server

import (
	"bytes"
	"compress/gzip"
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

func TestCachesOnlyFingerprintedStaticAssets(t *testing.T) {
	static := newTestFS()
	static["assets/index-CJOp0DRK.js"] = &fstest.MapFile{Data: []byte("console.log('fingerprinted')")}
	static["assets/worker-BPvA8L_j.js"] = &fstest.MapFile{Data: []byte("self.onmessage = () => {}")}
	static["theme-bootstrap.js"] = &fstest.MapFile{Data: []byte("console.log('bootstrap')")}
	srv, err := New(static, Options{Token: "test-token", Host: "127.0.0.1:1234"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		for _, tc := range []struct {
			path   string
			status int
			cache  string
		}{
			{"/assets/index-CJOp0DRK.js", http.StatusOK, "private, max-age=31536000, immutable"},
			{"/assets/worker-BPvA8L_j.js", http.StatusOK, "private, max-age=31536000, immutable"},
			{"/assets/app.js", http.StatusOK, "no-store"},
			{"/theme-bootstrap.js", http.StatusOK, "no-store"},
			{"/", http.StatusOK, "no-store"},
			{"/index.html", http.StatusOK, "no-store"},
			{"/some/route", http.StatusOK, "no-store"},
			{"/assets/missing-12345678.js", http.StatusNotFound, "no-store"},
			{"/api/v1/does-not-exist", http.StatusNotFound, "no-store"},
		} {
			t.Run(method+tc.path, func(t *testing.T) {
				rec := httptest.NewRecorder()
				req := httptest.NewRequest(method, "http://127.0.0.1:1234"+CapabilityPath("test-token")+tc.path, nil)
				srv.Handler().ServeHTTP(rec, req)
				if rec.Code != tc.status || rec.Header().Get("Cache-Control") != tc.cache {
					t.Fatalf("status=%d cache=%q, want status=%d cache=%q", rec.Code, rec.Header().Get("Cache-Control"), tc.status, tc.cache)
				}
			})
		}
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

func gzipBytes(t *testing.T, text string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(text)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestServesCompressedStaticAssets(t *testing.T) {
	const script = "console.log('compressed')"
	const page = "<!doctype html><title>compressed</title>"
	stored := gzipBytes(t, script)
	srv, err := New(fstest.MapFS{
		"index.html.gz":               &fstest.MapFile{Data: gzipBytes(t, page)},
		"assets/app-12345678.js.gz":   &fstest.MapFile{Data: stored},
		"assets/plain-12345678.js":    &fstest.MapFile{Data: []byte("plain")},
		"assets/plain-12345678.js.gz": &fstest.MapFile{Data: gzipBytes(t, "ignored")},
	}, Options{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	get := func(target, acceptEncoding string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, target, nil)
		if acceptEncoding != "" {
			req.Header.Set("Accept-Encoding", acceptEncoding)
		}
		srv.ServeHTTP(rec, req)
		return rec
	}

	rec := get("/assets/app-12345678.js", "br, gzip")
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Encoding") != "gzip" ||
		!strings.Contains(rec.Header().Get("Content-Type"), "javascript") ||
		rec.Header().Get("Cache-Control") != "private, max-age=31536000, immutable" ||
		rec.Header().Get("Vary") != "Accept-Encoding" || !bytes.Equal(rec.Body.Bytes(), stored) {
		t.Fatalf("gzip response: status=%d headers=%v", rec.Code, rec.Header())
	}

	rec = get("/assets/app-12345678.js", "")
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Encoding") != "" ||
		rec.Header().Get("Vary") != "Accept-Encoding" || rec.Body.String() != script {
		t.Fatalf("identity response: status=%d headers=%v body=%q", rec.Code, rec.Header(), rec.Body.String())
	}

	for _, ae := range []string{"gzip", ""} {
		rec = get("/some/route", ae)
		if rec.Code != http.StatusOK || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/html") {
			t.Fatalf("fallback ae=%q: status=%d headers=%v", ae, rec.Code, rec.Header())
		}
		if (ae == "gzip") != (rec.Header().Get("Content-Encoding") == "gzip") {
			t.Fatalf("fallback ae=%q: content-encoding=%q", ae, rec.Header().Get("Content-Encoding"))
		}
	}

	if rec = get("/assets/missing-12345678.js", "gzip"); rec.Code != http.StatusNotFound {
		t.Fatalf("missing asset status = %d, want 404", rec.Code)
	}

	rec = get("/assets/plain-12345678.js", "gzip")
	if rec.Body.String() != "plain" || rec.Header().Get("Content-Encoding") != "" {
		t.Fatalf("plain file: headers=%v body=%q", rec.Header(), rec.Body.String())
	}
}
