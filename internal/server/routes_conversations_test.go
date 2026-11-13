package server

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/roie/gitna/internal/conversations"
	"github.com/roie/gitna/internal/watch"
)

const testAgentToken = "agenttoken1234567890123456789012"

type conversationFixture struct {
	browser http.Handler
	agent   http.Handler
	root    string
	// joined is a participant Gitna issued, shown as "Helper".
	joined conversations.Participant
}

func newConversationFixture(t *testing.T) conversationFixture {
	t.Helper()
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "main.go"), []byte("package main\n\nfunc main() {\n\tprintln(1)\n}\n"), 0o644)
	library := conversations.NewLibrary(t.TempDir())
	t.Cleanup(func() { library.Close() })
	backend := &Conversations{
		Root:    root,
		Sources: conversations.Sources{Content: conversations.WorktreeContent(root)},
		Open:    func() (*conversations.Store, error) { return library.Store(root) },
		Human: func() conversations.Participant {
			return conversations.Participant{ID: "human:local", Kind: "human", Name: "Ada"}
		},
	}
	srv, err := New(fstest.MapFS{"index.html": {Data: []byte("<html>")}}, Options{Conversations: backend})
	if err != nil {
		t.Fatal(err)
	}
	agent := &AgentAPI{
		Token: testAgentToken, Host: testHost, Version: "test",
		Resolve: func(_ context.Context, path string) (*Conversations, error) {
			if path != root {
				return nil, ErrFolderNotOpen
			}
			return backend, nil
		},
	}
	store, err := library.Store(root)
	if err != nil {
		t.Fatal(err)
	}
	joined, err := store.Join("Helper")
	if err != nil {
		t.Fatal(err)
	}
	return conversationFixture{
		browser: Security{Token: testToken, Host: testHost}.Wrap(srv),
		agent:   agent,
		root:    root,
		joined:  joined,
	}
}

func (f conversationFixture) browserDo(t *testing.T, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "/g/"+testToken+"/api/v1"+path, strings.NewReader(body))
	req.Host = testHost
	if method != http.MethodGet {
		req.Header.Set("Origin", "http://"+testHost)
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	f.browser.ServeHTTP(rec, req)
	return rec
}

func (f conversationFixture) agentDo(t *testing.T, method, path, body string, mutate func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	separator := "?"
	if strings.Contains(path, "?") {
		separator = "&"
	}
	req := httptest.NewRequest(method, AgentPathPrefix+path+separator+"repo="+f.root, strings.NewReader(body))
	req.Host = testHost
	req.Header.Set("Authorization", "Bearer "+testAgentToken)
	req.Header.Set("Gitna-Participant", f.joined.ID)
	if method != http.MethodGet {
		req.Header.Set("Content-Type", "application/json")
	}
	if mutate != nil {
		mutate(req)
	}
	rec := httptest.NewRecorder()
	f.agent.ServeHTTP(rec, req)
	return rec
}

func decodeBody[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(rec.Body.Bytes(), &value); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return value
}

func TestHumanAndAgentExchangeThroughAPI(t *testing.T) {
	f := newConversationFixture(t)
	create := f.browserDo(t, http.MethodPost, "/conversations",
		`{"id":"c1","anchor":{"path":"main.go","side":"additions","startLine":3,"endLine":4,"code":"func main() {\n\tprintln(1)"},"body":"Why println?"}`)
	if create.Code != http.StatusOK {
		t.Fatalf("create = %d %s", create.Code, create.Body)
	}

	pending := decodeBody[pendingResponse](t, f.agentDo(t, http.MethodGet, "/conversations/pending", "", nil))
	if len(pending.Pending) != 1 || pending.Pending[0].Message.Author.Kind != "human" ||
		pending.Pending[0].Conversation.Location.Status != conversations.LocationCurrent {
		t.Fatalf("pending = %+v", pending)
	}
	reply := f.agentDo(t, http.MethodPost, "/conversations/c1/messages", `{"id":"m1","body":"Debug output.\nWill remove."}`, nil)
	if reply.Code != http.StatusOK {
		t.Fatalf("reply = %d %s", reply.Code, reply.Body)
	}
	if rec := f.agentDo(t, http.MethodPost, "/conversations/ack", `{"seq":2}`, nil); rec.Code != http.StatusOK {
		t.Fatalf("ack = %d %s", rec.Code, rec.Body)
	}
	if rec := f.agentDo(t, http.MethodGet, "/conversations/pending", "", nil); len(decodeBody[pendingResponse](t, rec).Pending) != 0 {
		t.Fatalf("pending after ack = %s", rec.Body)
	}

	os.WriteFile(filepath.Join(f.root, "main.go"), []byte("package main\n\n// note\nfunc main() {\n\tprintln(1)\n}\n"), 0o644)
	list := decodeBody[conversationList](t, f.browserDo(t, http.MethodGet, "/conversations?path=main.go", ""))
	if len(list.Conversations) != 1 || len(list.Conversations[0].Messages) != 2 ||
		*list.Conversations[0].Location != (conversations.Location{Path: "main.go", StartLine: 4, EndLine: 5, Status: "moved"}) {
		t.Fatalf("list = %+v", list)
	}
	if list.Conversations[0].Messages[1].Author.ID != f.joined.ID {
		t.Fatalf("agent author = %+v", list.Conversations[0].Messages[1].Author)
	}
	if rec := f.browserDo(t, http.MethodPost, "/conversations/c1/resolve", `{}`); rec.Code != http.StatusOK ||
		decodeBody[conversations.Conversation](t, rec).Status != "resolved" {
		t.Fatalf("resolve = %d %s", rec.Code, rec.Body)
	}
	if rec := f.browserDo(t, http.MethodPost, "/conversations/c1/delete", `{}`); rec.Code != http.StatusOK {
		t.Fatalf("delete = %d %s", rec.Code, rec.Body)
	}
	if list := decodeBody[conversationList](t, f.browserDo(t, http.MethodGet, "/conversations", "")); len(list.Conversations) != 0 {
		t.Fatalf("list after delete = %+v", list)
	}
	if rec := f.browserDo(t, http.MethodPost, "/conversations/c1/restore", `{}`); rec.Code != http.StatusOK ||
		len(decodeBody[conversations.Conversation](t, rec).Messages) != 2 {
		t.Fatalf("restore = %d %s", rec.Code, rec.Body)
	}
}

func TestCreateCapturesAnchoredCodeAndReadsArePerConversation(t *testing.T) {
	f := newConversationFixture(t)
	rec := f.agentDo(t, http.MethodPost, "/conversations", `{"id":"c1","anchor":{"path":"main.go","startLine":4,"endLine":4},"body":"Remove?"}`, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("create = %d %s", rec.Code, rec.Body)
	}
	anchor := decodeBody[conversations.Conversation](t, rec).Anchor
	want := conversations.Anchor{
		Path: "main.go", View: conversations.ViewFile, Source: conversations.SourceWorktree, Side: conversations.SideAdditions,
		StartLine: 4, EndLine: 4, Code: "\tprintln(1)", Before: "package main\n\nfunc main() {", After: "}",
	}
	if anchor != want {
		t.Fatalf("anchor = %+v, want %+v", anchor, want)
	}
	for _, body := range []string{
		`{"anchor":{"path":"main.go","startLine":99,"endLine":99},"body":"x"}`,
		`{"anchor":{"path":"missing.go","startLine":1,"endLine":1},"body":"x"}`,
		`{"anchor":{"path":"main.go","source":"commit","revision":"HEAD","startLine":1,"endLine":1},"body":"x"}`,
	} {
		if rec := f.agentDo(t, http.MethodPost, "/conversations", body, nil); rec.Code != http.StatusBadRequest {
			t.Errorf("create %s = %d %s", body, rec.Code, rec.Body)
		}
	}

	if rec := f.browserDo(t, http.MethodPost, "/conversations/c1/read", `{"seq":1}`); rec.Code != http.StatusOK {
		t.Fatalf("read = %d %s", rec.Code, rec.Body)
	}
	list := decodeBody[conversationList](t, f.browserDo(t, http.MethodGet, "/conversations", ""))
	if list.Read["c1"] != 1 || list.Participant.ID != "human:local" {
		t.Fatalf("list = %+v", list)
	}
	if agent := decodeBody[conversationList](t, f.agentDo(t, http.MethodGet, "/conversations", "", nil)); len(agent.Read) != 0 {
		t.Fatalf("one participant's reads leaked to another: %+v", agent.Read)
	}
}

func TestBrowserConversationMutationsKeepOriginProtection(t *testing.T) {
	f := newConversationFixture(t)
	req := httptest.NewRequest(http.MethodPost, "/g/"+testToken+"/api/v1/conversations", strings.NewReader(`{}`))
	req.Host = testHost
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://evil.example")
	rec := httptest.NewRecorder()
	f.browser.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("cross-origin create = %d", rec.Code)
	}
}

func TestAgentAPIRejectsBrowsersAndBadCredentials(t *testing.T) {
	f := newConversationFixture(t)
	cases := map[string]func(*http.Request){
		"missing token": func(r *http.Request) { r.Header.Del("Authorization") },
		"wrong token":   func(r *http.Request) { r.Header.Set("Authorization", "Bearer nope") },
		"browser token": func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+testToken) },
		"origin":        func(r *http.Request) { r.Header.Set("Origin", "http://"+testHost) },
		"fetch mode":    func(r *http.Request) { r.Header.Set("Sec-Fetch-Mode", "cors") },
		"host":          func(r *http.Request) { r.Host = "evil.example" },
		"impersonation": func(r *http.Request) { r.Header.Set("Gitna-Participant", "human:local") },
		"never issued":  func(r *http.Request) { r.Header.Set("Gitna-Participant", "agent:never-issued") },
		"no id":         func(r *http.Request) { r.Header.Del("Gitna-Participant") },
	}
	for name, mutate := range cases {
		if rec := f.agentDo(t, http.MethodGet, "/conversations/pending", "", mutate); rec.Code < 400 {
			t.Errorf("%s: status %d", name, rec.Code)
		}
	}
	if rec := f.agentDo(t, http.MethodGet, "/session", "", func(r *http.Request) {
		r.URL.RawQuery = "repo=" + t.TempDir()
	}); rec.Code != http.StatusNotFound {
		t.Errorf("unopened folder: status %d", rec.Code)
	}
	if rec := f.agentDo(t, http.MethodGet, "/snapshot", "", nil); rec.Code != http.StatusNotFound {
		t.Errorf("non-conversation route: status %d", rec.Code)
	}
	if rec := f.agentDo(t, http.MethodPost, "/conversations/ack", `{"seq":1}`, func(r *http.Request) {
		r.Header.Set("Content-Type", "text/plain")
	}); rec.Code != http.StatusUnsupportedMediaType {
		t.Errorf("text/plain mutation: status %d", rec.Code)
	}
	session := decodeBody[agentSession](t, f.agentDo(t, http.MethodGet, "/session", "", nil))
	if session.Root != f.root || session.Participant == nil || *session.Participant != f.joined {
		t.Fatalf("session = %+v", session)
	}
}

func TestConversationStreamResumesFromLastEventID(t *testing.T) {
	f := newConversationFixture(t)
	for _, body := range []string{
		`{"id":"c1","anchor":{"path":"main.go","startLine":1,"endLine":1,"code":"package main"},"body":"one"}`,
		`{"id":"c2","anchor":{"path":"main.go","startLine":1,"endLine":1,"code":"package main"},"body":"two"}`,
	} {
		if rec := f.browserDo(t, http.MethodPost, "/conversations", body); rec.Code != http.StatusOK {
			t.Fatalf("create = %d %s", rec.Code, rec.Body)
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Host = testHost
		f.browser.ServeHTTP(w, r)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/g/"+testToken+"/api/v1/conversations/events", nil)
	req.Header.Set("Last-Event-ID", "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	scanner := bufio.NewScanner(resp.Body)
	var ids []string
	for scanner.Scan() && len(ids) < 2 {
		if id, ok := strings.CutPrefix(scanner.Text(), "id: "); ok {
			ids = append(ids, id)
			if len(ids) == 1 {
				go f.agentDo(t, http.MethodPost, "/conversations/c1/messages", `{"body":"live"}`, nil)
			}
		}
	}
	if strings.Join(ids, ",") != "2,3" {
		t.Fatalf("event ids = %v", ids)
	}
}

func TestConversationStreamEndsWithFolderSession(t *testing.T) {
	library := conversations.NewLibrary(t.TempDir())
	t.Cleanup(func() { library.Close() })
	events := make(chan watch.InvalidationKind)
	srv, err := New(fstest.MapFS{"index.html": {Data: []byte("<html>")}}, Options{
		Events: events,
		Conversations: &Conversations{
			Open:  func() (*conversations.Store, error) { return library.Store("repo") },
			Human: func() conversations.Participant { return conversations.Participant{ID: "human:local", Kind: "human"} },
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan struct{})
	for _, path := range []string{"/api/v1/conversations/events", "/api/v1/conversations/pending?timeout=600"} {
		go func() {
			srv.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, path, nil))
			finished <- struct{}{}
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(events)
	for range 2 {
		select {
		case <-finished:
		case <-time.After(5 * time.Second):
			t.Fatal("conversation request outlived the folder session")
		}
	}
}

func TestOnlyPeopleDeleteOrRestoreConversations(t *testing.T) {
	f := newConversationFixture(t)
	if rec := f.browserDo(t, http.MethodPost, "/conversations",
		`{"id":"c1","anchor":{"path":"main.go","side":"additions","startLine":3,"endLine":3},"body":"Keep me"}`); rec.Code != http.StatusOK {
		t.Fatalf("create = %d %s", rec.Code, rec.Body)
	}
	for _, action := range []string{"delete", "restore"} {
		if rec := f.agentDo(t, http.MethodPost, "/conversations/c1/"+action, `{}`, nil); rec.Code != http.StatusForbidden {
			t.Errorf("agent %s = %d %s", action, rec.Code, rec.Body)
		}
	}
	if list := decodeBody[conversationList](t, f.browserDo(t, http.MethodGet, "/conversations", "")); len(list.Conversations) != 1 {
		t.Fatalf("list after agent delete = %+v", list)
	}
	for _, action := range []string{"resolve", "reopen"} {
		if rec := f.agentDo(t, http.MethodPost, "/conversations/c1/"+action, `{}`, nil); rec.Code != http.StatusOK {
			t.Errorf("agent %s = %d %s", action, rec.Code, rec.Body)
		}
	}
}
