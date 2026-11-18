package server

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	acp "github.com/caelis-labs/acp-go-sdk"
	"github.com/caelis-labs/acp-go-sdk/transport/stdio"
	"github.com/roie/gitna/internal/agentrun"
	"github.com/roie/gitna/internal/conversations"
)

func TestMain(m *testing.M) {
	if os.Getenv("GITNA_SERVER_FAKE_AGENT") == "1" {
		if os.Args[1] == "garbage" {
			fmt.Println("not ACP")
			os.Exit(0)
		}
		f := &routeAgent{mode: os.Args[1]}
		conn, err := stdio.NewAgentConnection(f, acp.ConnectionOptions{})
		if err != nil {
			os.Exit(1)
		}
		f.conn = conn
		<-conn.Done()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

type routeAgent struct {
	mode   string
	conn   *acp.AgentSideConnection
	authed bool
	root   string
}

func (f *routeAgent) Initialize(context.Context, acp.InitializeRequest) (acp.InitializeResponse, error) {
	r := acp.InitializeResponse{ProtocolVersion: 1, AuthMethods: []acp.AuthMethod{}}
	if f.mode == "auth" {
		r.AuthMethods = []acp.AuthMethod{{Agent: &acp.AuthMethodAgent{Id: "login", Name: "Sign in"}}}
	}
	return r, nil
}
func (f *routeAgent) Authenticate(context.Context, acp.AuthenticateRequest) (acp.AuthenticateResponse, error) {
	f.authed = true
	return acp.AuthenticateResponse{}, nil
}
func (f *routeAgent) NewSession(_ context.Context, p acp.NewSessionRequest) (acp.NewSessionResponse, error) {
	if f.mode == "auth" && !f.authed {
		return acp.NewSessionResponse{}, acp.NewAuthRequired(nil)
	}
	f.root = p.Cwd
	return acp.NewSessionResponse{SessionId: "session"}, nil
}
func (f *routeAgent) Cancel(context.Context, acp.CancelNotification) error { return nil }
func (f *routeAgent) Prompt(ctx context.Context, _ acp.PromptRequest) (acp.PromptResponse, error) {
	if f.mode == "permission" {
		_, err := f.conn.RequestPermission(ctx, acp.RequestPermissionRequest{SessionId: "session", ToolCall: acp.ToolCallUpdate{ToolCallId: "tool", Title: new("Edit file")}, Options: []acp.PermissionOption{{OptionId: "yes", Name: "Allow", Kind: "allow_once"}}})
		if err != nil {
			return acp.PromptResponse{}, err
		}
	}
	if f.mode == "activity" {
		ticker := time.NewTicker(time.Millisecond)
		defer ticker.Stop()
		for {
			if _, err := os.Stat(filepath.Join(f.root, "activity")); err == nil {
				break
			}
			select {
			case <-ctx.Done():
				return acp.PromptResponse{}, ctx.Err()
			case <-ticker.C:
			}
		}
		f.conn.SessionUpdate(ctx, acp.SessionNotification{SessionId: "session", Update: acp.SessionUpdate{ToolCall: &acp.SessionUpdateToolCall{SessionUpdate: "tool_call", ToolCallId: "read", Title: "Read file"}}})
	}
	if f.mode == "hang" || f.mode == "activity" {
		<-ctx.Done()
		return acp.PromptResponse{StopReason: "cancelled"}, nil
	}
	f.conn.SessionUpdate(ctx, acp.SessionNotification{SessionId: "session", Update: acp.UpdateAgentMessageText("Done.")})
	return acp.PromptResponse{StopReason: "end_turn"}, nil
}
func managedFixture(t *testing.T) conversationFixture {
	t.Helper()
	f := newConversationFixture(t)
	settings, err := agentrun.Open(filepath.Join(t.TempDir(), "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	f.backend.Settings = settings
	f.backend.Enabled = func() bool { return true }
	f.backend.Agents = agentrun.NewManager(settings, f.backend.Enabled)
	t.Cleanup(f.backend.Agents.Close)
	t.Setenv("GITNA_SERVER_FAKE_AGENT", "1")
	return f
}
func commandBody(t *testing.T, mode string) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]string{"name": "Native", "command": `"` + exe + `" ` + mode})
	return string(data)
}
func addNative(t *testing.T, f conversationFixture, mode string) conversations.Participant {
	t.Helper()
	r := f.browserDo(t, "POST", "/conversations/agents", commandBody(t, mode))
	if r.Code != 200 {
		t.Fatalf("add: %d %s", r.Code, r.Body)
	}
	return decodeBody[struct{ Participant conversations.Participant }](t, r).Participant
}
func createFor(t *testing.T, f conversationFixture, p conversations.Participant) conversations.Conversation {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"anchor": map[string]any{"path": "main.go", "side": "additions", "startLine": 3, "endLine": 3}, "body": "Explain", "to": []string{p.ID}})
	r := f.browserDo(t, "POST", "/conversations", string(body))
	if r.Code != 200 {
		t.Fatalf("create: %d %s", r.Code, r.Body)
	}
	return decodeBody[conversations.Conversation](t, r)
}
func awaitRun(t *testing.T, f conversationFixture, cid, state string) conversations.Conversation {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		s, _ := f.backend.Open()
		c, _ := s.Get(cid)
		if len(c.Runs) > 0 && c.Runs[len(c.Runs)-1].State == state {
			return c
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("run never became %s", state)
	return conversations.Conversation{}
}
func TestAgentRoutes(t *testing.T) {
	f := managedFixture(t)
	p := addNative(t, f, "reply")
	if p.Agent == "" {
		t.Fatal("not native")
	}
	c := createFor(t, f, p)
	c = awaitRun(t, f, c.ID, "completed")
	if len(c.Messages) != 2 {
		t.Fatalf("messages: %+v", c.Messages)
	}
	retry := fmt.Sprintf("/conversations/%s/messages/%s/retry", c.ID, c.Messages[0].ID)
	r := f.browserDo(t, "POST", retry, `{"participant":"`+p.ID+`"}`)
	if r.Code != 200 {
		t.Fatalf("retry: %d %s", r.Code, r.Body)
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		s, _ := f.backend.Open()
		c, _ = s.Get(c.ID)
		if len(c.Messages) == 3 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(c.Messages) != 3 {
		t.Fatal("retry has no reply")
	}
	r = f.browserDo(t, "POST", "/conversations/participants/"+p.ID+"/leave", `{}`)
	if r.Code != 200 {
		t.Fatalf("leave: %d %s", r.Code, r.Body)
	}
	body, _ := json.Marshal(map[string]string{"definition": p.Agent})
	r = f.browserDo(t, "POST", "/conversations/agents", string(body))
	if r.Code != 200 {
		t.Fatalf("saved add: %d %s", r.Code, r.Body)
	}
	r = f.browserDo(t, "DELETE", "/conversations/agents/"+p.Agent, "")
	if r.Code != 200 || len(f.backend.Settings.Get().Agents) != 0 {
		t.Fatalf("delete: %d %s", r.Code, r.Body)
	}
}
func TestAgentVerificationFailureSavesNothing(t *testing.T) {
	f := managedFixture(t)
	for _, mode := range []string{"garbage", "auth"} {
		r := f.browserDo(t, "POST", "/conversations/agents", commandBody(t, mode))
		want := 422
		if mode == "auth" {
			want = 409
		}
		if r.Code != want {
			t.Fatalf("%s: %d %s", mode, r.Code, r.Body)
		}
		if mode == "garbage" && !strings.Contains(r.Body.String(), "did not start an ACP agent") {
			t.Fatalf("garbage: %s", r.Body)
		}
		if mode == "auth" {
			v := decodeBody[struct {
				Code    string
				Methods []agentrun.AuthMethod
			}](t, r)
			if v.Code != "auth-required" || len(v.Methods) != 1 {
				t.Fatalf("auth: %+v", v)
			}
		}
	}
	s, _ := f.backend.Open()
	agents, _ := s.Agents()
	if len(f.backend.Settings.Get().Agents) != 0 || len(agents) != 1 {
		t.Fatalf("saved or joined: %+v", agents)
	}
	var body map[string]string
	json.Unmarshal([]byte(commandBody(t, "auth")), &body)
	body["authMethod"] = "login"
	data, _ := json.Marshal(body)
	if r := f.browserDo(t, "POST", "/conversations/agents", string(data)); r.Code != 200 {
		t.Fatalf("auth retry: %d %s", r.Code, r.Body)
	}
}
func TestRunControlRoutes(t *testing.T) {
	for _, mode := range []string{"hang", "permission"} {
		t.Run(mode, func(t *testing.T) {
			f := managedFixture(t)
			p := addNative(t, f, mode)
			c := createFor(t, f, p)
			c = awaitRun(t, f, c.ID, "running")
			id := strconv.FormatUint(c.Runs[0].ID, 10)
			if mode == "permission" {
				deadline := time.Now().Add(10 * time.Second)
				var live []agentrun.Live
				for time.Now().Before(deadline) {
					live, _ = f.backend.Agents.Live(f.root)
					if len(live) > 0 && live[0].Permission != nil {
						break
					}
					time.Sleep(time.Millisecond)
				}
				if len(live) == 0 || live[0].Permission == nil {
					t.Fatal("no permission")
				}
				r := f.browserDo(t, "POST", "/conversations/runs/"+id+"/permission", `{"requestId":"unknown","optionId":"yes"}`)
				if r.Code != 404 {
					t.Fatalf("unknown permission %d %s", r.Code, r.Body)
				}
				r = f.browserDo(t, "POST", "/conversations/runs/"+id+"/permission", `{"requestId":"`+live[0].Permission.ID+`","optionId":"yes"}`)
				if r.Code != 200 {
					t.Fatalf("permission %d %s", r.Code, r.Body)
				}
				awaitRun(t, f, c.ID, "completed")
			} else {
				r := f.browserDo(t, "POST", "/conversations/runs/"+id+"/cancel", `{}`)
				if r.Code != 200 {
					t.Fatalf("cancel %d %s", r.Code, r.Body)
				}
				awaitRun(t, f, c.ID, "cancelled")
			}
		})
	}
}
func TestNativeRoutesAreBrowserOnly(t *testing.T) {
	f := managedFixture(t)
	for _, route := range []struct{ method, path string }{{"GET", "/settings"}, {"POST", "/agents"}, {"DELETE", "/agents/a"}, {"POST", "/participants/a/leave"}, {"POST", "/runs/1/cancel"}, {"POST", "/runs/1/permission"}, {"POST", "/c/messages/m/retry"}, {"POST", "/agents/adapters/codex-acp"}, {"DELETE", "/agents/adapters/codex-acp"}, {"POST", "/agents/a/models"}, {"POST", "/agents/a/model"}} {
		r := f.agentDo(t, route.method, "/conversations"+route.path, `{}`, nil)
		if r.Code != 404 {
			t.Fatalf("%s: %d %s", route.path, r.Code, r.Body)
		}
		for _, token := range []string{"", "wrong"} {
			req := httptest.NewRequest(route.method, "/g/"+token+"/api/v1/conversations"+route.path, strings.NewReader(`{}`))
			req.Host = testHost
			req.Header.Set("Origin", "http://"+testHost)
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			f.browser.ServeHTTP(rec, req)
			if rec.Code < 400 {
				t.Fatalf("unprotected %s", route.path)
			}
		}
	}
	if r := f.browserDo(t, "POST", "/conversations/agents", `{"name":"`+strings.Repeat("x", int(MaxRequestBody))+`"}`); r.Code < 400 {
		t.Fatal("oversized body accepted")
	}
}
func TestRunFramesHaveNoID(t *testing.T) {
	f := managedFixture(t)
	p := addNative(t, f, "activity")
	c := createFor(t, f, p)
	awaitRun(t, f, c.ID, "running")
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	req := httptest.NewRequest("GET", "/g/"+testToken+"/api/v1/conversations/events", nil).WithContext(ctx)
	req.Host = testHost
	srv := httptest.NewServer(f.browser)
	defer srv.Close()
	req.URL.Scheme = "http"
	req.URL.Host = strings.TrimPrefix(srv.URL, "http://")
	req.RequestURI = ""
	res, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	scanner := bufio.NewScanner(res.Body)
	nextRun := func() string {
		t.Helper()
		var frame strings.Builder
		for scanner.Scan() {
			line := scanner.Text()
			if line != "" {
				frame.WriteString(line + "\n")
				continue
			}
			text := frame.String()
			frame.Reset()
			if strings.Contains(text, "event: run\n") {
				if strings.Contains(text, "id: ") {
					t.Fatalf("live frame has durable ID: %s", text)
				}
				return text
			}
		}
		t.Fatalf("no live frame: %v", scanner.Err())
		return ""
	}
	if !strings.Contains(nextRun(), "Writing a reply") {
		t.Fatal("missing live snapshot")
	}
	if err := os.WriteFile(filepath.Join(f.root, "activity"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	for !strings.Contains(nextRun(), "Read file") {
	}
}
func TestRunRoutesWithoutManager(t *testing.T) {
	f := newConversationFixture(t)
	if r := f.browserDo(t, "POST", "/conversations/runs/1/cancel", `{}`); r.Code != 503 {
		t.Fatalf("nil manager: %d", r.Code)
	}
}
func TestRunRoutesFromOtherProcess(t *testing.T) {
	f := managedFixture(t)
	r := f.browserDo(t, "POST", "/conversations/runs/1/cancel", `{}`)
	if r.Code != 409 || !strings.Contains(r.Body.String(), `"other-process"`) {
		t.Fatalf("other process: %d %s", r.Code, r.Body)
	}
}

func TestRememberedAgents(t *testing.T) {
	f := managedFixture(t)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	saved := map[string]agentrun.Definition{}
	for _, name := range []string{"Disconnected", "Named", "Everyone"} {
		def, err := agentrun.Resolve(name, `"`+exe+`" reply`)
		if err != nil {
			t.Fatal(err)
		}
		saved[name] = def
		if err := f.backend.Settings.Update(func(s *agentrun.Settings) error { s.Agents = append(s.Agents, def); return nil }); err != nil {
			t.Fatal(err)
		}
	}
	store, _ := f.backend.Open()
	list := func() map[string]string {
		t.Helper()
		r := f.browserDo(t, "GET", "/conversations", "")
		if r.Code != 200 {
			t.Fatalf("list: %d %s", r.Code, r.Body)
		}
		out := map[string]string{}
		for _, p := range decodeBody[conversationList](t, r).Agents {
			out[p.Name] = p.ID
		}
		return out
	}
	agents := list()
	for name, def := range saved {
		if agents[name] != "def:"+def.ID {
			t.Fatalf("remembered %s = %q in %v", name, agents[name], agents)
		}
	}
	if natives, _ := store.Natives(); len(natives) != 0 {
		t.Fatalf("listing joined %+v", natives)
	}
	for _, p := range decodeBody[conversationList](t, f.agentDo(t, "GET", "/conversations", "", nil)).Agents {
		if strings.HasPrefix(p.ID, "def:") {
			t.Fatalf("agent sees remembered %+v", p)
		}
	}

	if r := f.browserDo(t, "POST", "/conversations/participants/def:"+saved["Disconnected"].ID+"/leave", `{}`); r.Code != 200 {
		t.Fatalf("disconnect: %d %s", r.Code, r.Body)
	}
	if _, ok := list()["Disconnected"]; ok {
		t.Fatal("disconnected agent still listed")
	}
	body, _ := json.Marshal(map[string]string{"definition": saved["Disconnected"].ID})
	if r := f.browserDo(t, "POST", "/conversations/agents", string(body)); r.Code != 200 {
		t.Fatalf("reconnect: %d %s", r.Code, r.Body)
	}
	if id := list()["Disconnected"]; id == "" || strings.HasPrefix(id, "def:") {
		t.Fatalf("reconnected as %q", id)
	}

	c := createFor(t, f, conversations.Participant{ID: "def:" + saved["Named"].ID})
	named := list()["Named"]
	if strings.HasPrefix(named, "def:") || !slices.Equal(c.Messages[0].To, []string{named}) {
		t.Fatalf("named joined as %q, message to %v", named, c.Messages[0].To)
	}
	awaitRun(t, f, c.ID, "completed")
	if _, ok := list()["Everyone"]; !ok || !strings.HasPrefix(list()["Everyone"], "def:") {
		t.Fatal("unaddressed agent was joined")
	}

	reply, _ := json.Marshal(map[string]any{"body": "All of you", "to": []string{"all"}})
	if r := f.browserDo(t, "POST", "/conversations/"+c.ID+"/messages", string(reply)); r.Code != 200 {
		t.Fatalf("reply all: %d %s", r.Code, r.Body)
	}
	if id := list()["Everyone"]; strings.HasPrefix(id, "def:") {
		t.Fatal("@all did not join the remembered agent")
	}
	if r := f.browserDo(t, "POST", "/conversations/"+c.ID+"/messages", `{"body":"x","to":["def:missing"]}`); r.Code != 400 {
		t.Fatalf("unknown remembered: %d %s", r.Code, r.Body)
	}
}

func TestRememberedAgentRunsOnTheFirstMessage(t *testing.T) {
	f := managedFixture(t)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	def, err := agentrun.Resolve("Helper", `"`+exe+`" reply`)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.backend.Settings.Update(func(s *agentrun.Settings) error { s.Agents = append(s.Agents, def); return nil }); err != nil {
		t.Fatal(err)
	}
	c := createFor(t, f, conversations.Participant{ID: "def:" + def.ID})
	awaitRun(t, f, c.ID, "completed")
}

func TestAgentModel(t *testing.T) {
	f := managedFixture(t)
	p := addNative(t, f, "reply")
	if r := f.browserDo(t, "POST", "/conversations/agents/"+p.Agent+"/models", `{}`); r.Code != 422 || !strings.Contains(r.Body.String(), "does not offer") {
		t.Fatalf("models: %d %s", r.Code, r.Body)
	}
	if r := f.browserDo(t, "POST", "/conversations/agents/"+p.Agent+"/model", `{"model":"large"}`); r.Code != 200 {
		t.Fatalf("save: %d %s", r.Code, r.Body)
	}
	if got := f.backend.Settings.Get().Agents[0].Model; got != "large" {
		t.Fatalf("model = %q", got)
	}
	if r := f.browserDo(t, "POST", "/conversations/agents/missing/model", `{"model":"large"}`); r.Code != 404 {
		t.Fatalf("missing: %d %s", r.Code, r.Body)
	}
}
