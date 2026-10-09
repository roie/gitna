package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

type commitSearchFake struct {
	fakeRepo
	search func(context.Context, string, bool, int) (protocol.GraphPage, error)
}

func (f *commitSearchFake) SearchCommits(ctx context.Context, query string, all bool, skip int) (protocol.GraphPage, error) {
	return f.search(ctx, query, all, skip)
}

func TestCommitSearchRoute(t *testing.T) {
	repo := &commitSearchFake{search: func(ctx context.Context, query string, all bool, skip int) (protocol.GraphPage, error) {
		if query != "fix [literal]" || !all || skip != 100 {
			t.Fatalf("search arguments: %q %t %d", query, all, skip)
		}
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("search has no deadline")
		}
		return protocol.GraphPage{Commits: []protocol.GraphCommit{{OID: "abc", Subject: "fix [literal]"}}}, nil
	}}
	h := newSnapshotServer(repo)
	request := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/commits/search?q=fix+%5Bliteral%5D&all=1&skip=100", nil)
	request.Host = testHost
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	var page protocol.GraphPage
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Generation == 0 || len(page.Commits) != 1 || page.Commits[0].OID != "abc" {
		t.Fatalf("page: %+v", page)
	}
}

func TestCommitSearchRejectsInvalidRequests(t *testing.T) {
	repo := &commitSearchFake{search: func(context.Context, string, bool, int) (protocol.GraphPage, error) {
		t.Fatal("invalid request reached repository")
		return protocol.GraphPage{}, nil
	}}
	h := newSnapshotServer(repo)
	for _, query := range []string{"skip=-1", "skip=bad", "skip=10001", "q=" + strings.Repeat("a", 1025)} {
		request := httptest.NewRequest(http.MethodGet, "/g/"+testToken+"/api/v1/commits/search?"+query, nil)
		request.Host = testHost
		response := httptest.NewRecorder()
		h.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%q: status %d", query, response.Code)
		}
	}
}
