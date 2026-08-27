package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

func TestWorkspacesRouteReturnsCurrentAndRecentCatalog(t *testing.T) {
	catalog := protocol.WorkspaceCatalog{
		Current: protocol.Workspace{Path: "/current", Name: "current", Repository: true},
		Recent: []protocol.Workspace{
			{Path: "/current", Name: "current", Repository: true},
			{Path: "/previous", Name: "previous", Repository: true},
		},
	}
	srv, err := New(newTestFS(), Options{
		Token:      testToken,
		Host:       testHost,
		Repo:       &fakeRepo{},
		Workspaces: func() protocol.WorkspaceCatalog { return catalog },
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/s/"+testToken+"/api/v1/workspaces", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var got protocol.WorkspaceCatalog
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Current.Path != "/current" || len(got.Recent) != 2 || got.Recent[1].Path != "/previous" {
		t.Fatalf("catalog = %#v", got)
	}
}

func TestSwitchRepositoryRouteUsesExplicitSessionCallback(t *testing.T) {
	var switched string
	srv, err := New(newTestFS(), Options{
		Token: testToken,
		Host:  testHost,
		Repo:  &fakeRepo{},
		SwitchRepository: func(_ context.Context, path string) (string, error) {
			switched = path
			return "/resolved/repo", nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	before := srv.gen.Load()
	body, _ := json.Marshal(map[string]string{"path": "/requested/repo"})
	req := httptest.NewRequest(http.MethodPost, "/s/"+testToken+"/api/v1/repository", bytes.NewReader(body))
	req.Host = testHost
	req.Header.Set("Origin", "http://"+testHost)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if switched != "/requested/repo" {
		t.Fatalf("switched = %q", switched)
	}
	if srv.gen.Load() != before+1 {
		t.Fatalf("generation = %d, want %d", srv.gen.Load(), before+1)
	}
}

func TestRevealRepositoryRouteUsesCurrentSessionCallback(t *testing.T) {
	called := false
	srv, err := New(newTestFS(), Options{
		Token: testToken,
		Host:  testHost,
		Repo:  &fakeRepo{},
		RevealRepository: func(context.Context) error {
			called = true
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/s/"+testToken+"/api/v1/repository/reveal", nil)
	req.Host = testHost
	req.Header.Set("Origin", "http://"+testHost)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent || !called {
		t.Fatalf("status = %d called = %v", rec.Code, called)
	}
}
