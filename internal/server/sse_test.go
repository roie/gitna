package server

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/roie/gitna/internal/watch"
)

// startEventsServer runs the full handler stack against a real listener so the
// SSE stream can be consumed incrementally with proper flushing.
func startEventsServer(t *testing.T, events <-chan watch.InvalidationKind) *httptest.Server {
	t.Helper()
	ts := httptest.NewUnstartedServer(http.NotFoundHandler())
	host := ts.Listener.Addr().String()
	srv, err := New(newTestFS(), Options{
		Token:  testToken,
		Host:   host,
		Repo:   &fakeRepo{},
		Events: events,
	})
	if err != nil {
		t.Fatal(err)
	}
	ts.Config.Handler = srv.Handler()
	ts.Start()
	t.Cleanup(ts.Close)
	return ts
}

func eventsURL(ts *httptest.Server) string {
	return ts.URL + "/s/" + testToken + "/api/v1/events"
}

func readUntil(t *testing.T, br *bufio.Reader, needle string) string {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	var seen strings.Builder
	for time.Now().Before(deadline) {
		line, err := br.ReadString('\n')
		seen.WriteString(line)
		if strings.Contains(line, needle) {
			return seen.String()
		}
		if err != nil && err != io.EOF {
			t.Fatalf("read: %v", err)
		}
		if err == io.EOF {
			time.Sleep(10 * time.Millisecond)
		}
	}
	t.Fatalf("timed out waiting for %q; stream so far:\n%s", needle, seen.String())
	return ""
}

func TestEventsStreamsInvalidationKinds(t *testing.T) {
	src := make(chan watch.InvalidationKind, 4)
	ts := startEventsServer(t, src)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, eventsURL(ts), nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.StatusCode, http.StatusOK)
	}
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content-type = %q, want text/event-stream", ct)
	}

	br := bufio.NewReader(res.Body)
	readUntil(t, br, ": connected")

	src <- watch.InvalidateSnapshot
	readUntil(t, br, "event: snapshot-invalidated")

	src <- watch.InvalidateGraph
	readUntil(t, br, "event: graph-invalidated")
}

func TestEventsStreamClosesWithoutSource(t *testing.T) {
	ts := startEventsServer(t, nil)
	res, err := http.Get(eventsURL(ts))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.StatusCode, http.StatusOK)
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), ": connected") {
		t.Fatalf("body = %q, want connected comment", body)
	}
}

// TestEventsSlowClientDoesNotBlockOthers proves a subscriber that stops reading
// cannot stall the hub or the other connected clients: its buffer fills and
// events are dropped for it while others keep receiving.
func TestEventsSlowClientDoesNotBlockOthers(t *testing.T) {
	src := make(chan watch.InvalidationKind, 4)
	ts := startEventsServer(t, src)

	slow, err := net.Dial("tcp", ts.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer slow.Close()
	fmt.Fprintf(slow, "GET /s/%s/api/v1/events HTTP/1.1\r\nHost: %s\r\n\r\n",
		testToken, ts.Listener.Addr().String())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, eventsURL(ts), nil)
	if err != nil {
		t.Fatal(err)
	}
	fast, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer fast.Body.Close()
	br := bufio.NewReader(fast.Body)
	readUntil(t, br, ": connected")

	for i := 0; i < 200; i++ {
		src <- watch.InvalidateSnapshot
	}
	readUntil(t, br, "event: snapshot-invalidated")
}
