package agentrun

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	acp "github.com/caelis-labs/acp-go-sdk"
	"github.com/caelis-labs/acp-go-sdk/transport/stdio"
)

func TestMain(m *testing.M) {
	if os.Getenv("GITNA_FAKE_AGENT") != "" {
		mode := os.Args[1]
		if mode == "sleep" {
			time.Sleep(time.Hour)
			os.Exit(0)
		}
		if mode == "garbage" {
			fmt.Println("not a protocol message")
			os.Exit(0)
		}
		fake := &fakeAgent{mode: mode}
		conn, err := stdio.NewAgentConnection(fake, acp.ConnectionOptions{})
		if err != nil {
			os.Exit(1)
		}
		fake.conn = conn
		<-conn.Done()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

type fakeAgent struct {
	mode   string
	model  string
	root   string
	authed bool
	conn   *acp.AgentSideConnection
}

func (f *fakeAgent) Initialize(_ context.Context, p acp.InitializeRequest) (acp.InitializeResponse, error) {
	if p.ClientCapabilities.Terminal || p.ClientCapabilities.Fs.ReadTextFile || p.ClientCapabilities.Fs.WriteTextFile {
		return acp.InitializeResponse{}, errors.New("unexpected client capability")
	}
	r := acp.InitializeResponse{ProtocolVersion: 1, AuthMethods: []acp.AuthMethod{}}
	if f.mode == "version" {
		r.ProtocolVersion = 2
	}
	if f.mode == "auth" {
		r.AuthMethods = []acp.AuthMethod{
			{Agent: &acp.AuthMethodAgent{Id: "login", Name: "Sign in", Description: new("Sign in here")}},
			{Terminal: &acp.AuthMethodTerminalInline{Id: "terminal", Name: "Terminal", Type: "terminal"}},
		}
	}
	return r, nil
}

func (f *fakeAgent) Authenticate(_ context.Context, p acp.AuthenticateRequest) (acp.AuthenticateResponse, error) {
	if p.MethodId != "login" {
		return acp.AuthenticateResponse{}, acp.NewAuthRequired(nil)
	}
	f.authed = true
	return acp.AuthenticateResponse{}, nil
}

func (f *fakeAgent) NewSession(_ context.Context, p acp.NewSessionRequest) (acp.NewSessionResponse, error) {
	if f.mode == "auth" && !f.authed {
		return acp.NewSessionResponse{}, acp.NewAuthRequired(nil)
	}
	f.root = p.Cwd
	f.model = "small"
	options := acp.SessionConfigSelectOptionsUngrouped{{Value: "small", Name: "Small"}, {Value: "large", Name: "Large"}}
	model := acp.NewSessionConfigOptionSelect("small", acp.SessionConfigSelectOptions{Ungrouped: &options})
	model.Select.Id, model.Select.Name, model.Select.Category = "model", "Model", new(acp.SessionConfigOptionCategoryModel)
	return acp.NewSessionResponse{SessionId: "session", ConfigOptions: []acp.SessionConfigOption{model}}, nil
}

func (f *fakeAgent) SetSessionConfigOption(_ context.Context, p acp.SetSessionConfigOptionRequest) (acp.SetSessionConfigOptionResponse, error) {
	if p.ValueId == nil || p.ValueId.ConfigId != "model" {
		return acp.SetSessionConfigOptionResponse{}, errors.New("unknown option")
	}
	f.model = string(p.ValueId.Value)
	return acp.SetSessionConfigOptionResponse{ConfigOptions: []acp.SessionConfigOption{}}, nil
}

func (f *fakeAgent) Cancel(context.Context, acp.CancelNotification) error { return nil }

func (f *fakeAgent) Prompt(ctx context.Context, _ acp.PromptRequest) (acp.PromptResponse, error) {
	send := func(update acp.SessionUpdate) {
		f.conn.SessionUpdate(ctx, acp.SessionNotification{SessionId: "session", Update: update})
	}
	switch f.mode {
	case "refuse":
		return acp.PromptResponse{StopReason: "refusal"}, nil
	case "narrate", "narrate-tail":
		send(acp.UpdateAgentMessageText("Before. "))
		send(acp.SessionUpdate{ToolCall: &acp.SessionUpdateToolCall{SessionUpdate: "tool_call", ToolCallId: "one", Title: "Read"}})
		send(acp.UpdateAgentMessageText("Between. "))
		send(acp.UpdateAgentThoughtText("Secret thoughts."))
		send(acp.SessionUpdate{ToolCall: &acp.SessionUpdateToolCall{SessionUpdate: "tool_call", ToolCallId: "two", Title: "Write"}})
		if f.mode == "narrate" {
			send(acp.UpdateAgentMessageText("Final answer."))
		}
	case "permission":
		r, err := f.conn.RequestPermission(ctx, acp.RequestPermissionRequest{
			SessionId: "session", ToolCall: acp.ToolCallUpdate{ToolCallId: "tool", Title: new("Write a file")},
			Options: []acp.PermissionOption{{OptionId: "allow", Name: "Allow once", Kind: "allow_once"}, {OptionId: "deny", Name: "Reject", Kind: "reject_once"}},
		})
		if err != nil {
			return acp.PromptResponse{}, err
		}
		if r.Outcome.Cancelled != nil {
			return acp.PromptResponse{StopReason: "cancelled"}, nil
		}
		send(acp.UpdateAgentMessageText(string(r.Outcome.Selected.OptionId)))
	case "edit", "exit-after-edit":
		guard := filepath.Join(f.root, "agent-active")
		lock, err := os.OpenFile(guard, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return acp.PromptResponse{}, errors.New("agents overlapped")
		}
		lock.Close()
		defer os.Remove(guard)
		time.Sleep(30 * time.Millisecond)
		file, err := os.OpenFile(filepath.Join(f.root, "agent.txt"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			return acp.PromptResponse{}, err
		}
		file.WriteString("edit\n")
		file.Close()
		if f.mode == "exit-after-edit" {
			os.Exit(1)
		}
		send(acp.UpdateAgentMessageText("Edited."))
	case "child":
		exe, _ := os.Executable()
		child := exec.Command(exe, "sleep")
		if err := child.Start(); err != nil {
			return acp.PromptResponse{}, err
		}
		os.WriteFile(filepath.Join(f.root, "child.pid"), []byte(strconv.Itoa(child.Process.Pid)), 0o600)
		fallthrough
	case "hang":
		<-ctx.Done()
		return acp.PromptResponse{StopReason: "cancelled"}, nil
	case "model":
		send(acp.UpdateAgentMessageText("Model " + f.model))
	default:
		send(acp.UpdateAgentMessageText("Hello."))
	}
	return acp.PromptResponse{StopReason: "end_turn"}, nil
}

func fakeDefinition(t *testing.T, mode string) Definition {
	t.Helper()
	t.Setenv("GITNA_FAKE_AGENT", "1")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return Definition{ID: mode, Name: mode, Executable: exe, Args: []string{mode}}
}

func TestVerifyAcceptsAnAgent(t *testing.T) {
	if err := Verify(t.Context(), fakeDefinition(t, "reply"), t.TempDir(), ""); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyRejectsAProgramThatIsNotAnAgent(t *testing.T) {
	for _, mode := range []string{"garbage", "plain", "version"} {
		t.Run(mode, func(t *testing.T) {
			def := fakeDefinition(t, mode)
			if mode == "plain" {
				t.Setenv("GITNA_FAKE_AGENT", "")
				def.Args = []string{"-test.run=^$"}
			}
			if err := Verify(t.Context(), def, t.TempDir(), ""); err == nil {
				t.Fatal("accepted a non-agent")
			}
		})
	}
}

func TestVerifyReportsAuthMethods(t *testing.T) {
	def := fakeDefinition(t, "auth")
	root := t.TempDir()
	err := Verify(t.Context(), def, root, "")
	auth, ok := errors.AsType[*AuthError](err)
	if !ok || !errors.Is(err, ErrAuthRequired) || len(auth.Methods) != 2 || auth.Methods[0].ID != "login" || auth.Methods[0].Description != "Sign in here" || auth.Methods[0].Interactive || !auth.Methods[1].Interactive {
		t.Fatalf("auth: %+v", err)
	}
	if err := Verify(t.Context(), def, root, "login"); err != nil {
		t.Fatal(err)
	}
}

func TestRunReturnsTheReply(t *testing.T) {
	reply, err := Run(t.Context(), fakeDefinition(t, "reply"), t.TempDir(), "Question", Hooks{})
	if err != nil || reply != "Hello." {
		t.Fatalf("reply=%q err=%v", reply, err)
	}
}

func TestRunReplyIsTheFinalMessage(t *testing.T) {
	for _, mode := range []string{"narrate", "narrate-tail"} {
		t.Run(mode, func(t *testing.T) {
			updates := 0
			reply, err := Run(t.Context(), fakeDefinition(t, mode), t.TempDir(), "Question", Hooks{Activity: func(string) { updates++ }})
			want := "Final answer."
			if mode == "narrate-tail" {
				want = "Before. Between."
			}
			if err != nil || reply != want || updates < 5 {
				t.Fatalf("reply=%q updates=%d err=%v", reply, updates, err)
			}
		})
	}
}

func TestRunWithoutTextFailsWithTheStopReason(t *testing.T) {
	reply, err := Run(t.Context(), fakeDefinition(t, "refuse"), t.TempDir(), "Question", Hooks{})
	if reply != "" || err == nil || !strings.Contains(err.Error(), "refusal") {
		t.Fatalf("reply=%q err=%v", reply, err)
	}
}

func TestRunRelaysPermissionChoice(t *testing.T) {
	for _, allow := range []bool{true, false} {
		t.Run(strconv.FormatBool(allow), func(t *testing.T) {
			calls := 0
			reply, err := Run(t.Context(), fakeDefinition(t, "permission"), t.TempDir(), "Question", Hooks{Permission: func(_ context.Context, r PermissionRequest) (string, bool) {
				calls++
				if r.ID == "" || r.Title != "Write a file" || len(r.Options) != 2 || r.Options[0].ID != "allow" {
					t.Errorf("request: %+v", r)
				}
				return "allow", allow
			}})
			if calls != 1 || (allow && (err != nil || reply != "allow")) || (!allow && !errors.Is(err, context.Canceled)) {
				t.Fatalf("calls=%d reply=%q err=%v", calls, reply, err)
			}
		})
	}
}

func TestRunCancelStopsTheProcessTree(t *testing.T) {
	assertCancelStopsTheProcessTree(t, fakeDefinition(t, "child"))
}

func assertCancelStopsTheProcessTree(t *testing.T, def Definition) {
	t.Helper()
	root := t.TempDir()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := Run(ctx, def, root, "Question", Hooks{}); done <- err }()
	var pid int
	deadline := time.After(10 * time.Second)
	for pid == 0 {
		data, _ := os.ReadFile(filepath.Join(root, "child.pid"))
		pid, _ = strconv.Atoi(string(data))
		select {
		case <-deadline:
			t.Fatal("child never started")
		case <-time.After(10 * time.Millisecond):
		}
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("run never stopped")
	}
	if runtime.GOOS == "windows" {
		data, err := exec.Command("tasklist.exe", "/FI", fmt.Sprintf("PID eq %d", pid), "/NH").Output()
		if err != nil || strings.Contains(string(data), strconv.Itoa(pid)) {
			t.Fatalf("child still running: %s, %v", data, err)
		}
	} else {
		p, err := os.FindProcess(pid)
		if err == nil && p.Signal(syscall.Signal(0)) == nil {
			t.Fatalf("child %d still exists", pid)
		}
	}
}

func TestRunFailsWhenTheAgentExits(t *testing.T) {
	root := t.TempDir()
	_, err := Run(t.Context(), fakeDefinition(t, "exit-after-edit"), root, "Question", Hooks{})
	if err == nil {
		t.Fatal("unexpected success")
	}
	if data, err := os.ReadFile(filepath.Join(root, "agent.txt")); err != nil || string(data) != "edit\n" {
		t.Fatalf("edit=%q err=%v", data, err)
	}
}

func TestModels(t *testing.T) {
	def := fakeDefinition(t, "model")
	models, err := ListModels(t.Context(), def, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	want := Models{Default: "small", Options: []Model{{ID: "small", Name: "Small"}, {ID: "large", Name: "Large"}}}
	if !reflect.DeepEqual(models, want) {
		t.Fatalf("models = %+v", models)
	}
	for model, reply := range map[string]string{"": "Model small", "large": "Model large"} {
		def.Model = model
		if got, err := Run(t.Context(), def, t.TempDir(), "Question", Hooks{}); err != nil || got != reply {
			t.Fatalf("model %q: %q, %v", model, got, err)
		}
	}
	def.Model = "gone"
	if _, err := Run(t.Context(), def, t.TempDir(), "Question", Hooks{}); err == nil || !strings.Contains(err.Error(), "gone") {
		t.Fatalf("missing model: %v", err)
	}
}
