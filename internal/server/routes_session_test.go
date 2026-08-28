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

func TestFoldersRouteReturnsCurrentAndRecentCatalog(t *testing.T) {
	catalog := protocol.FolderCatalog{
		Current: protocol.Folder{Path: "/current", Name: "current", Repository: true},
		Recent: []protocol.Folder{
			{Path: "/current", Name: "current", Repository: true},
			{Path: "/previous", Name: "previous", Repository: true},
		},
	}
	srv, err := New(newTestFS(), Options{
		Token:   testToken,
		Host:    testHost,
		Repo:    &fakeRepo{},
		Folders: func() protocol.FolderCatalog { return catalog },
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/folders", nil)
	req.Host = testHost
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var got protocol.FolderCatalog
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Current.Path != "/current" || len(got.Recent) != 2 || got.Recent[1].Path != "/previous" {
		t.Fatalf("catalog = %#v", got)
	}
}

func TestOpenFolderRouteUsesExplicitSessionCallback(t *testing.T) {
	var opened string
	srv, err := New(newTestFS(), Options{
		Token: testToken,
		Host:  testHost,
		Repo:  &fakeRepo{},
		OpenFolder: func(_ context.Context, path string) (protocol.OpenFolderResult, error) {
			opened = path
			return protocol.OpenFolderResult{Root: "/resolved/folder", Href: "../folder/"}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	before := srv.gen.Load()
	body, _ := json.Marshal(map[string]string{"path": "/requested/folder"})
	req := httptest.NewRequest(http.MethodPost, "/g/"+testToken+"/api/v1/folder", bytes.NewReader(body))
	req.Host = testHost
	req.Header.Set("Origin", "http://"+testHost)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if opened != "/requested/folder" {
		t.Fatalf("opened = %q", opened)
	}
	if srv.gen.Load() != before {
		t.Fatalf("generation = %d, want unchanged %d", srv.gen.Load(), before)
	}
	var result protocol.OpenFolderResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Root != "/resolved/folder" || result.Href != "../folder/" {
		t.Fatalf("result = %#v", result)
	}
}

func TestRemoveRecentFolderRouteUsesBoundedSessionCallback(t *testing.T) {
	var removed string
	srv, err := New(newTestFS(), Options{
		Token: testToken,
		Host:  testHost,
		Repo:  &fakeRepo{},
		RemoveRecentFolder: func(_ context.Context, path string) error {
			removed = path
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"path": "/recent/folder"})
	req := httptest.NewRequest(http.MethodDelete, "/g/"+testToken+"/api/v1/folders/recent", bytes.NewReader(body))
	req.Host = testHost
	req.Header.Set("Origin", "http://"+testHost)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent || removed != "/recent/folder" {
		t.Fatalf("status = %d removed = %q", rec.Code, removed)
	}
}

func TestRemoveRecentFolderRouteRejectsInvalidBody(t *testing.T) {
	srv, err := New(newTestFS(), Options{
		Token:              testToken,
		Host:               testHost,
		Repo:               &fakeRepo{},
		RemoveRecentFolder: func(context.Context, string) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodDelete, "/g/"+testToken+"/api/v1/folders/recent", bytes.NewBufferString(`{"path":""}`))
	req.Host = testHost
	req.Header.Set("Origin", "http://"+testHost)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (%s)", rec.Code, rec.Body)
	}
}

func TestRevealFolderRouteUsesCurrentSessionCallback(t *testing.T) {
	called := false
	srv, err := New(newTestFS(), Options{
		Token: testToken,
		Host:  testHost,
		Repo:  &fakeRepo{},
		RevealFolder: func(context.Context) error {
			called = true
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/g/"+testToken+"/api/v1/folder/reveal", nil)
	req.Host = testHost
	req.Header.Set("Origin", "http://"+testHost)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent || !called {
		t.Fatalf("status = %d called = %v", rec.Code, called)
	}
}
