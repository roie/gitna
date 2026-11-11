package agentclient

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/roie/gitna/internal/agentlink"
)

func publish(t *testing.T, dir string, pid int, url, token string) {
	t.Helper()
	if _, err := agentlink.Publish(dir, agentlink.Endpoint{PID: pid, URL: url, Token: token}); err != nil {
		t.Fatal(err)
	}
}

func stalePort(t *testing.T) string {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	return "http://" + address
}

func TestDiscoverSkipsStaleAndOtherRepositoryEndpoints(t *testing.T) {
	dir := t.TempDir()
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"not open"}`, http.StatusNotFound)
	}))
	defer other.Close()
	var participant, auth string
	live := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agent/v1/session" || r.URL.Query().Get("repo") != "/work/repo" {
			http.NotFound(w, r)
			return
		}
		participant, auth = r.Header.Get("Gitna-Participant"), r.Header.Get("Authorization")
		w.Write([]byte(`{"repo":"/work/repo"}`))
	}))
	defer live.Close()
	publish(t, dir, 1, stalePort(t), "stale")
	publish(t, dir, 2, other.URL, "other")
	publish(t, dir, 3, live.URL, "live-token")

	started := time.Now()
	client, session, err := Discover(context.Background(), dir, "/work/repo", "agent:p_1")
	if err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Errorf("discovery took %v; stale endpoints must not be retried", elapsed)
	}
	if client.endpoint.PID != 3 || string(session) != `{"repo":"/work/repo"}` {
		t.Fatalf("client = %+v, session = %s", client.endpoint, session)
	}
	if participant != "agent:p_1" || auth != "Bearer live-token" {
		t.Fatalf("headers = %q, %q", participant, auth)
	}
}

func TestDiscoverReportsNoSessionAndAuthFailures(t *testing.T) {
	dir := t.TempDir()
	if _, _, err := Discover(context.Background(), dir, "/r", "agent:a"); !errors.Is(err, ErrNoSession) {
		t.Fatalf("empty dir: %v", err)
	}
	publish(t, dir, 1, stalePort(t), "stale")
	if _, _, err := Discover(context.Background(), dir, "/r", "agent:a"); !errors.Is(err, ErrNoSession) {
		t.Fatalf("stale only: %v", err)
	}
	denied := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"invalid agent token"}`, http.StatusUnauthorized)
	}))
	defer denied.Close()
	publish(t, dir, 2, denied.URL, "wrong")
	_, _, err := Discover(context.Background(), dir, "/r", "agent:a")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusUnauthorized || apiErr.Message != "invalid agent token" {
		t.Fatalf("denied: %v", err)
	}
}

func TestDoRetriesUnavailableWithTheSameBody(t *testing.T) {
	var bodies []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 64)
		n, _ := r.Body.Read(buf)
		bodies = append(bodies, string(buf[:n]))
		if len(bodies) == 1 {
			http.Error(w, `{"error":"busy"}`, http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte(`{"id":"m1"}`))
	}))
	defer server.Close()
	client := &Client{endpoint: agentlink.Endpoint{URL: server.URL, Token: "t"}, repo: "/r", participant: "agent:a", http: server.Client()}
	var out struct{ ID string }
	if err := client.Do(context.Background(), http.MethodPost, "/conversations/c1/messages", nil, map[string]string{"id": "m1", "body": "hi"}, &out); err != nil {
		t.Fatal(err)
	}
	if out.ID != "m1" || len(bodies) != 2 || bodies[0] != bodies[1] {
		t.Fatalf("out = %+v, bodies = %q", out, bodies)
	}

	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"already used"}`, http.StatusConflict)
	}))
	defer failing.Close()
	client.endpoint.URL = failing.URL
	var apiErr *APIError
	if err := client.Do(context.Background(), http.MethodPost, "/x", nil, nil, nil); !errors.As(err, &apiErr) || apiErr.Status != http.StatusConflict {
		t.Fatalf("conflict: %v", err)
	}
}
