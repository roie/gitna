package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const (
	testToken = "testcapabilitytoken1234567890123"
	testHost  = "127.0.0.1:4567"
)

func newSecuredTestHandler() http.Handler {
	stub := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	sec := Security{Token: testToken, Host: testHost}
	return sec.Wrap(stub)
}

func doReq(t *testing.T, h http.Handler, method, path, host string, mutate func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	req.Host = host
	if mutate != nil {
		mutate(req)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestCapabilityPathUsesGitnaNamespace(t *testing.T) {
	if got := CapabilityPath("token"); got != "/g/token" {
		t.Fatalf("CapabilityPath() = %q, want /g/token", got)
	}
}

func TestSecurityMissingToken(t *testing.T) {
	h := newSecuredTestHandler()
	rec := doReq(t, h, http.MethodGet, "/api/v1/snapshot", testHost, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

func TestSecurityWrongToken(t *testing.T) {
	h := newSecuredTestHandler()
	rec := doReq(t, h, http.MethodGet, "/g/wrongtoken/api/v1/snapshot", testHost, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

func TestSecurityUnexpectedHost(t *testing.T) {
	h := newSecuredTestHandler()
	rec := doReq(t, h, http.MethodGet, "/g/"+testToken+"/api/v1/snapshot", "evil.example", nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestSecurityUnexpectedHostRootDoesNotExposeToken(t *testing.T) {
	h := newSecuredTestHandler()
	rec := doReq(t, h, http.MethodGet, "/", "evil.example", nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
	if location := rec.Header().Get("Location"); location != "" {
		t.Fatalf("Location = %q, want empty", location)
	}
	for name, values := range rec.Header() {
		if strings.Contains(strings.Join(values, ","), testToken) {
			t.Fatalf("header %s exposes capability token", name)
		}
	}
	if strings.Contains(rec.Body.String(), testToken) {
		t.Fatal("response body exposes capability token")
	}
}

func TestSecurityValidSameOriginGET(t *testing.T) {
	h := newSecuredTestHandler()
	rec := doReq(t, h, http.MethodGet, "/g/"+testToken+"/api/v1/snapshot", testHost, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestSecurityPOSTCrossOrigin(t *testing.T) {
	h := newSecuredTestHandler()
	rec := doReq(t, h, http.MethodPost, "/g/"+testToken+"/api/v1/commit", testHost, func(r *http.Request) {
		r.Header.Set("Origin", "http://evil.example")
		r.Header.Set("Content-Type", "application/json")
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestSecurityPOSTMissingOrigin(t *testing.T) {
	h := newSecuredTestHandler()
	rec := doReq(t, h, http.MethodPost, "/g/"+testToken+"/api/v1/commit", testHost, func(r *http.Request) {
		r.Header.Set("Content-Type", "application/json")
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestSecurityPOSTWrongContentType(t *testing.T) {
	h := newSecuredTestHandler()
	rec := doReq(t, h, http.MethodPost, "/g/"+testToken+"/api/v1/commit", testHost, func(r *http.Request) {
		r.Header.Set("Origin", "http://"+testHost)
		r.Header.Set("Content-Type", "text/plain")
	})
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnsupportedMediaType)
	}
}

func TestSecurityValidSameOriginPOST(t *testing.T) {
	h := newSecuredTestHandler()
	rec := doReq(t, h, http.MethodPost, "/g/"+testToken+"/api/v1/commit", testHost, func(r *http.Request) {
		r.Header.Set("Origin", "http://"+testHost)
		r.Header.Set("Content-Type", "application/json")
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestSecurityOversizedBody(t *testing.T) {
	h := newSecuredTestHandler()
	body := strings.Repeat("a", int(MaxRequestBody)+1)
	req := httptest.NewRequest(http.MethodPost, "/g/"+testToken+"/api/v1/commit", strings.NewReader(body))
	req.Host = testHost
	req.Header.Set("Origin", "http://"+testHost)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusRequestEntityTooLarge)
	}
}

func TestSecurityPatchBodyUsesPatchLimit(t *testing.T) {
	h := newSecuredTestHandler()
	request := func(route string, contentLength int64) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, route+"?op=patch", strings.NewReader("{}"))
		req.Host = testHost
		req.ContentLength = contentLength
		req.Header.Set("Origin", "http://"+testHost)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	for _, route := range []string{
		"/g/" + testToken + "/api/v1/operations",
		"/g/" + testToken + "/gitna/api/v1/operations",
	} {
		if rec := request(route, MaxRequestBody+1); rec.Code != http.StatusOK {
			t.Fatalf("%s body above ordinary limit status = %d, want 200", route, rec.Code)
		}
		if rec := request(route, MaxPatchRequestBody+1); rec.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("%s body above patch limit status = %d, want 413", route, rec.Code)
		}
	}

	req := httptest.NewRequest(http.MethodPost, "/g/"+testToken+"/api/v1/commit?op=patch", strings.NewReader("{}"))
	req.Host = testHost
	req.ContentLength = MaxRequestBody + 1
	req.Header.Set("Origin", "http://"+testHost)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("non-operation route with op=patch status = %d, want 413", rec.Code)
	}
}

func TestSecurityRootRedirectsToCapabilityURL(t *testing.T) {
	h := newSecuredTestHandler()
	rec := doReq(t, h, http.MethodGet, "/", testHost, nil)
	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusFound)
	}
	want := CapabilityPath(testToken) + "/"
	if loc := rec.Header().Get("Location"); loc != want {
		t.Fatalf("location = %q, want %q", loc, want)
	}
}

func TestSecuritySetsHeaders(t *testing.T) {
	h := newSecuredTestHandler()
	rec := doReq(t, h, http.MethodGet, "/g/"+testToken+"/", testHost, nil)
	if got := rec.Header().Get("Content-Security-Policy"); !strings.Contains(got, "frame-ancestors 'none'") {
		t.Fatalf("CSP = %q, want frame-ancestors 'none'", got)
	}
	if got := rec.Header().Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q, want no-referrer", got)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q, want nosniff", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
}
