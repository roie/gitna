package server

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/prefs"
)

func newPreferencesServer(t *testing.T, file *prefs.File) *Server {
	t.Helper()
	srv, err := New(newTestFS(), Options{Token: testToken, Host: testHost, Preferences: file})
	if err != nil {
		t.Fatal(err)
	}
	return srv
}

func TestPreferencesRoundTripThroughPutAndScript(t *testing.T) {
	srv := newPreferencesServer(t, prefs.Open(filepath.Join(t.TempDir(), "preferences.json")))
	put := worktreeRequest(t, srv.Handler(), http.MethodPut, "/preferences", `{"key":"theme","value":"dark"}`)
	if put.Code != http.StatusNoContent {
		t.Fatalf("PUT status = %d, body = %s", put.Code, put.Body.String())
	}
	req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/preferences.js", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if !strings.Contains(rec.Body.String(), `"theme":"dark"`) {
		t.Fatalf("script = %s", rec.Body.String())
	}
}

func TestPreferencesRejectsUnknownKeyAndOversizedValue(t *testing.T) {
	srv := newPreferencesServer(t, prefs.Open(filepath.Join(t.TempDir(), "preferences.json")))
	for _, body := range []string{
		`{"key":"other","value":"x"}`,
		`{"key":"theme","value":"` + strings.Repeat("x", 513) + `"}`,
	} {
		if rec := worktreeRequest(t, srv.Handler(), http.MethodPut, "/preferences", body); rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d for %.40s", rec.Code, body)
		}
	}
}

func TestPreferenceChangedAfterSuccessfulWrite(t *testing.T) {
	var keys []string
	srv, err := New(newTestFS(), Options{Token: testToken, Host: testHost, Preferences: prefs.Open(filepath.Join(t.TempDir(), "preferences.json")), PreferenceChanged: func(key string) { keys = append(keys, key) }})
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{`{"key":"gitna:conversations","value":"true"}`, `{"key":"unknown","value":"x"}`} {
		worktreeRequest(t, srv.Handler(), http.MethodPut, "/preferences", body)
	}
	if len(keys) != 1 || keys[0] != "gitna:conversations" {
		t.Fatalf("callbacks: %v", keys)
	}
}

func TestPreferencesWithoutStoreIsUnavailable(t *testing.T) {
	srv := newPreferencesServer(t, nil)
	rec := worktreeRequest(t, srv.Handler(), http.MethodPut, "/preferences", `{"key":"theme","value":"dark"}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", rec.Code)
	}
}
