package server

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRevealPathRoute(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		callback   bool
		failure    bool
		status     int
	}{
		{"file", `{"path":"nested/notes.txt"}`, true, false, http.StatusNoContent},
		{"empty", `{"path":""}`, true, false, http.StatusBadRequest},
		{"malformed", `{`, true, false, http.StatusBadRequest},
		{"missing", `{"path":"missing"}`, true, true, http.StatusBadRequest},
		{"unavailable", `{"path":"notes.txt"}`, false, false, http.StatusNotImplemented},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got string
			options := Options{Token: testToken, Host: testHost, Repo: &fakeRepo{}}
			if tc.callback {
				options.RevealPath = func(_ context.Context, path string) error {
					got = path
					if tc.failure {
						return errors.New("missing path")
					}
					return nil
				}
			}
			srv, err := New(newTestFS(), options)
			if err != nil {
				t.Fatal(err)
			}
			req := httptest.NewRequest(http.MethodPost, "/g/"+testToken+"/api/v1/worktree/reveal", bytes.NewBufferString(tc.body))
			req.Host = testHost
			req.Header.Set("Origin", "http://"+testHost)
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			srv.Handler().ServeHTTP(rec, req)
			if rec.Code != tc.status {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body)
			}
			if tc.status == http.StatusNoContent && got != "nested/notes.txt" {
				t.Fatalf("path=%q", got)
			}
			if (tc.name == "empty" || tc.name == "malformed") && got != "" {
				t.Fatal("called reveal on invalid body")
			}
		})
	}
}
