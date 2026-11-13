package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/agentlink"
	"github.com/roie/gitna/internal/conversations"
	"github.com/roie/gitna/internal/server"
	"github.com/roie/gitna/skills"
)

// gitnaProcess serves one repository's conversations to agents, like a
// running Gitna, and publishes its endpoint for discovery.
func gitnaProcess(t *testing.T, repo, storeDir string, pid int) func() {
	t.Helper()
	library := conversations.NewLibrary(storeDir)
	backend := &server.Conversations{Root: repo, Sources: conversations.Sources{Content: conversations.WorktreeContent(repo)}, Open: func() (*conversations.Store, error) { return library.Store(repo) }}
	api := &server.AgentAPI{Token: "secret", Resolve: func(_ context.Context, path string) (*server.Conversations, error) {
		if path != repo {
			return nil, server.ErrFolderNotOpen
		}
		return backend, nil
	}}
	httpServer := httptest.NewServer(api)
	api.Host = strings.TrimPrefix(httpServer.URL, "http://")
	dir, err := agentlink.Dir()
	if err != nil {
		t.Fatal(err)
	}
	remove, err := agentlink.Publish(dir, agentlink.Endpoint{PID: pid, URL: httpServer.URL, Token: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	return func() {
		remove()
		httpServer.Close()
		library.Close()
	}
}

func TestConversationsCLIRoundTrip(t *testing.T) {
	config := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", config)
	t.Setenv("AppData", config)
	t.Setenv("HOME", config)
	repo := t.TempDir()
	os.WriteFile(filepath.Join(repo, "a.go"), []byte("one\ntwo\nthree\n"), 0o644)
	storeDir := t.TempDir()
	stop := gitnaProcess(t, repo, storeDir, 1)
	defer func() { stop() }()

	cli := func(stdin string, args ...string) (int, string, string) {
		var stdout, stderr bytes.Buffer
		code := runConversationsCLI(context.Background(), append(args, "--repo", repo), strings.NewReader(stdin), &stdout, &stderr)
		return code, stdout.String(), stderr.String()
	}
	run := func(stdin string, args ...string) map[string]any {
		t.Helper()
		code, stdout, stderr := cli(stdin, args...)
		if code != 0 {
			t.Fatalf("%v exited %d: %s", args, code, stderr)
		}
		var out map[string]any
		if err := json.Unmarshal([]byte(stdout), &out); err != nil {
			t.Fatalf("%v output %q: %v", args, stdout, err)
		}
		return out
	}
	join := func(name string) string {
		t.Helper()
		participant := run("", "join", "--as", name)["participant"].(map[string]any)
		if participant["name"] != name || participant["kind"] != "agent" {
			t.Fatalf("joined = %+v", participant)
		}
		return participant["id"].(string)
	}
	pending := func(participant string) []any {
		t.Helper()
		return run("", "pending", "--participant", participant)["pending"].([]any)
	}

	// Two agents may show the same name but get their own ids.
	first, second := join("Helper"), join("Helper")
	if first == second {
		t.Fatalf("both joins returned %q", first)
	}
	if unnamed := run("", "join")["participant"].(map[string]any); unnamed["name"] != "Agent" || unnamed["id"] == first {
		t.Fatalf("join without --as = %+v", unnamed)
	}

	created := run("First line\n\"quoted\" $HOME `ticks`\n", "create", "--path", "a.go", "--lines", "2-3", "--id", "c-first", "--participant", first)
	anchor := created["anchor"].(map[string]any)
	if anchor["code"] != "two\nthree" || created["messages"].([]any)[0].(map[string]any)["body"] != "First line\n\"quoted\" $HOME `ticks`" {
		t.Fatalf("created = %+v", created)
	}
	id := created["id"].(string)
	store, err := conversations.NewLibrary(storeDir).Store(repo)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Reply(conversations.Participant{ID: "human:local", Kind: "human", Name: "Ada"}, id, "m-human", "Please explain"); err != nil {
		t.Fatal(err)
	}
	store.Close()

	// The first agent's own message is not in its inbox; the second sees both.
	if got := pending(first); len(got) != 1 {
		t.Fatalf("first pending = %+v", got)
	}
	if got := pending(second); len(got) != 2 {
		t.Fatalf("second pending = %+v", got)
	}
	seq := run("", "pending", "--wait", "1", "--participant", first)["pending"].([]any)[0].(map[string]any)["message"].(map[string]any)["seq"].(float64)
	run("", "reply", id, "--id", "m-because", "--body", "Because.", "--participant", first)
	if cursor := run("", "ack", strconv.FormatFloat(seq, 'f', 0, 64), "--participant", first)["cursor"]; cursor != seq {
		t.Fatalf("cursor = %v, want %v", cursor, seq)
	}
	// Acknowledgments stay with the agent that made them.
	if got := pending(first); len(got) != 0 {
		t.Fatalf("first pending after ack = %+v", got)
	}
	if got := pending(second); len(got) != 3 {
		t.Fatalf("second pending after first's ack = %+v", got)
	}

	// The same id reconnects to the same inbox, also after Gitna restarts.
	stop()
	stop = gitnaProcess(t, repo, storeDir, 2)
	session := run("", "session", "--participant", first)
	if participant := session["participant"].(map[string]any); participant["id"] != first || participant["name"] != "Helper" || session["cursor"] != seq {
		t.Fatalf("session after restart = %+v", session)
	}
	if got := pending(first); len(got) != 0 {
		t.Fatalf("first pending after restart = %+v", got)
	}
	if got := pending(second); len(got) != 3 {
		t.Fatalf("second pending after restart = %+v", got)
	}

	// A retried reply with the same --id and body is stored once.
	run("", "reply", id, "--id", "m-retry", "--body", "Once.", "--participant", second)
	run("", "reply", id, "--id", "m-retry", "--body", "Once.", "--participant", second)
	shown := run("", "show", id, "--participant", second)
	if messages := shown["messages"].([]any); len(messages) != 4 {
		t.Fatalf("messages after retry = %+v", messages)
	}
	if author := shown["messages"].([]any)[3].(map[string]any)["author"].(map[string]any); author["id"] != second || author["name"] != "Helper" {
		t.Fatalf("retry author = %+v", author)
	}
	if status := run("", "resolve", id, "--participant", first)["status"]; status != "resolved" {
		t.Fatalf("resolve status = %v", status)
	}
	if status := run("", "reopen", id, "--participant", first)["status"]; status != "open" {
		t.Fatalf("reopen status = %v", status)
	}
	if listed := run("", "list", "--path", "a.go", "--participant", first)["conversations"].([]any); len(listed) != 1 {
		t.Fatalf("list = %+v", listed)
	}
	events := run("", "events", "--after", "0", "--timeout", "1", "--participant", first)["events"].([]any)
	if last := events[len(events)-1].(map[string]any); last["type"] != "conversation.reopened" {
		t.Fatalf("last event = %+v", last)
	}

	fails := func(wantCode int, want string, args ...string) {
		t.Helper()
		code, _, stderr := cli("", args...)
		var failure struct{ Error string }
		if code != wantCode || json.Unmarshal([]byte(stderr), &failure) != nil || !strings.Contains(failure.Error, want) {
			t.Fatalf("%v: code %d, stderr %s", args, code, stderr)
		}
	}
	fails(2, "--participant ID", "list")
	fails(2, "unknown command", "nope", "--participant", first)
	fails(1, "unknown participant", "pending", "--participant", "agent:p_never")
	fails(1, "--id is required", "reply", id, "--body", "x", "--participant", first)
	fails(1, "not found", "show", "c_missing", "--participant", first)
	fails(1, "already used", "reply", id, "--id", "m-retry", "--body", "Changed.", "--participant", second)
	stop()
	fails(1, "no running Gitna", "list", "--participant", first)
}

// TestSkillMatchesCLI keeps the skill's examples runnable: every command it
// shows exists, uses only flags the CLI accepts, and carries the identity and
// message id the CLI requires.
func TestSkillMatchesCLI(t *testing.T) {
	flags := map[string]bool{}
	for _, name := range []string{"repo", "as", "participant", "path", "lines", "source", "revision", "id", "body", "body-file", "wait", "timeout", "after"} {
		flags[name] = true
	}
	var usage bytes.Buffer
	if code := runConversationsCLI(context.Background(), []string{"--help"}, nil, &usage, &bytes.Buffer{}); code != 0 {
		t.Fatal("help failed")
	}
	if strings.Contains(skills.Gitna, "gitna conversations skill") || !strings.Contains(skills.Gitna, "`gitna skill`") {
		t.Error("the skill must point to `gitna skill`, not a conversations subcommand")
	}
	command := regexp.MustCompile("gitna conversations ([a-z]+)([^`\n]*)")
	seen := map[string]bool{}
	for _, match := range command.FindAllStringSubmatch(skills.Gitna, -1) {
		name, rest := match[1], match[2]
		seen[name] = true
		if _, ok := conversationCommands[name]; !ok {
			t.Errorf("skill uses unknown command %q", name)
		}
		if !strings.Contains(usage.String(), "  "+name) {
			t.Errorf("--help does not list %q", name)
		}
		for _, flag := range regexp.MustCompile(`--([a-z-]+)`).FindAllStringSubmatch(rest, -1) {
			if !flags[flag[1]] {
				t.Errorf("skill passes unknown flag --%s to %s", flag[1], name)
			}
		}
		if name != joinCommand && !strings.Contains(rest, "--participant") {
			t.Errorf("command without --participant: %s", match[0])
		}
		if (name == "create" || name == "reply") && !strings.Contains(rest, "--id <") {
			t.Errorf("%s must take a fresh --id placeholder, not a sample id: %s", name, match[0])
		}
	}
	for name := range conversationCommands {
		if !seen[name] {
			t.Errorf("skill does not mention %q", name)
		}
	}
	prose := strings.Join(strings.Fields(skills.Gitna), " ")
	for _, phrase := range []string{"print JSON", "prints this skill as Markdown", "1 when a command fails", "exit status 2 when the command line is invalid", "pending --wait", `it is "Agent" when you leave out`} {
		if !strings.Contains(prose, phrase) {
			t.Errorf("skill does not say %q", phrase)
		}
	}
}

// TestSkillFollowsAgentSkillsFormat checks the frontmatter rules of
// https://agentskills.io/specification and that the public texts name no
// particular agent.
func TestSkillFollowsAgentSkillsFormat(t *testing.T) {
	front, body, ok := strings.Cut(strings.TrimPrefix(skills.Gitna, "---\n"), "\n---\n")
	if !ok || !strings.HasPrefix(skills.Gitna, "---\n") || strings.TrimSpace(body) == "" {
		t.Fatal("SKILL.md needs YAML frontmatter followed by a body")
	}
	fields := map[string]string{}
	key := ""
	for _, line := range strings.Split(front, "\n") {
		if name, value, found := strings.Cut(line, ":"); found && !strings.HasPrefix(line, " ") {
			key = name
			fields[key] = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(value), ">-"))
			continue
		}
		fields[key] = strings.TrimSpace(fields[key] + " " + strings.TrimSpace(line))
	}
	for name := range fields {
		switch name {
		case "name", "description", "license", "compatibility", "metadata", "allowed-tools":
		default:
			t.Errorf("unknown frontmatter field %q", name)
		}
	}
	if fields["name"] != "gitna" {
		t.Errorf("name = %q, want the directory name gitna", fields["name"])
	}
	if description := fields["description"]; description == "" || len(description) > 1024 {
		t.Errorf("description has %d characters, want 1-1024", len(description))
	}
	var usage bytes.Buffer
	printUsage(&usage)
	printConversationsUsage(&usage)
	readme, err := os.ReadFile("../../README.md")
	if err != nil {
		t.Fatal(err)
	}
	public := strings.ToLower(skills.Gitna + usage.String() + string(readme))
	for _, provider := range []string{"claude", "codex", "copilot", "gemini", "cursor agent"} {
		if strings.Contains(public, provider) {
			t.Errorf("public docs mention %q", provider)
		}
	}
}
