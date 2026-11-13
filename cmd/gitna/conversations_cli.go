package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/roie/gitna/internal/agentclient"
	"github.com/roie/gitna/internal/agentlink"
	"github.com/roie/gitna/internal/conversations"
)

// conversationsCommand is the provisional CLI entry point for agents. Command
// names live only here and in conversationCommands so they can change without
// touching the protocol, storage, or their tests.
const conversationsCommand = "conversations"

type conversationCall struct {
	ctx        context.Context
	client     *agentclient.Client
	root       string
	positional []string
	flags      *conversationFlags
	stdin      io.Reader
}

type conversationFlags struct {
	repo, as, participant, path, lines, source, revision, id, body, bodyFile string
	wait, timeout                                                            float64
	after                                                                    uint64
	to                                                                       recipientsFlag
}

// recipientsFlag collects repeated --to participant ids.
type recipientsFlag []string

func (r *recipientsFlag) String() string { return strings.Join(*r, ",") }

func (r *recipientsFlag) Set(value string) error {
	*r = append(*r, value)
	return nil
}

type conversationOperation struct {
	args    string
	summary string
	run     func(*conversationCall) (any, error)
}

// joinCommand asks Gitna for a new participant id. Every other command
// passes that id with --participant.
const joinCommand = "join"

var conversationCommands = map[string]conversationOperation{
	joinCommand: {"[--as NAME]", "Join as a new participant shown as NAME (default \"Agent\"); prints the participant id to reuse", func(c *conversationCall) (any, error) {
		var out json.RawMessage
		return out, c.client.Do(c.ctx, http.MethodPost, "/participants", nil, map[string]string{"name": c.flags.as}, &out)
	}},
	"session": {"", "Show the Gitna session for this repository", func(c *conversationCall) (any, error) {
		var out json.RawMessage
		return out, c.client.Do(c.ctx, http.MethodGet, "/session", nil, nil, &out)
	}},
	"list": {"[--path FILE]", "List conversations with their current code locations", func(c *conversationCall) (any, error) {
		query := url.Values{}
		if c.flags.path != "" {
			query.Set("path", filepath.ToSlash(c.flags.path))
		}
		var out json.RawMessage
		return out, c.client.Do(c.ctx, http.MethodGet, "/conversations", query, nil, &out)
	}},
	"show": {"ID", "Show one conversation", func(c *conversationCall) (any, error) {
		id, err := c.arg(0, "conversation id")
		if err != nil {
			return nil, err
		}
		var out json.RawMessage
		return out, c.client.Do(c.ctx, http.MethodGet, "/conversations/"+url.PathEscape(id), nil, nil, &out)
	}},
	"create": {"--path FILE --lines N[-M] --id ID [--to PARTICIPANT_ID]... [--source worktree|index|commit] [--revision COMMIT_ID] [--body TEXT | --body-file FILE]", "Start a conversation on lines of a worktree file, the index, or a commit; the body defaults to stdin", func(c *conversationCall) (any, error) {
		anchor, err := c.anchor()
		if err != nil {
			return nil, err
		}
		body, err := c.body()
		if err != nil {
			return nil, err
		}
		id, err := c.messageID()
		if err != nil {
			return nil, err
		}
		var out json.RawMessage
		return out, c.client.Do(c.ctx, http.MethodPost, "/conversations", nil,
			map[string]any{"id": id, "anchor": anchor, "body": body, "to": c.flags.to}, &out)
	}},
	"reply": {"ID --id MESSAGE_ID [--to PARTICIPANT_ID]... [--body TEXT | --body-file FILE]", "Reply to a conversation; the body defaults to stdin", func(c *conversationCall) (any, error) {
		id, err := c.arg(0, "conversation id")
		if err != nil {
			return nil, err
		}
		body, err := c.body()
		if err != nil {
			return nil, err
		}
		messageID, err := c.messageID()
		if err != nil {
			return nil, err
		}
		var out json.RawMessage
		return out, c.client.Do(c.ctx, http.MethodPost, "/conversations/"+url.PathEscape(id)+"/messages", nil,
			map[string]any{"id": messageID, "body": body, "to": c.flags.to}, &out)
	}},
	"leave": {"", "Stop taking part: you are no longer a default recipient; your id keeps working", func(c *conversationCall) (any, error) {
		var out json.RawMessage
		return out, c.client.Do(c.ctx, http.MethodPost, "/participants/leave", nil, struct{}{}, &out)
	}},
	"pending": {"[--wait SECONDS]", "List unacknowledged messages addressed to you, optionally waiting for one", func(c *conversationCall) (any, error) {
		query := url.Values{}
		if c.flags.wait > 0 {
			query.Set("timeout", strconv.FormatFloat(c.flags.wait, 'f', -1, 64))
		}
		var out json.RawMessage
		return out, c.client.Do(c.ctx, http.MethodGet, "/conversations/pending", query, nil, &out)
	}},
	"ack": {"SEQ", "Mark messages up to SEQ as processed", func(c *conversationCall) (any, error) {
		value, err := c.arg(0, "sequence number")
		if err != nil {
			return nil, err
		}
		seq, err := strconv.ParseUint(value, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid sequence number %q", value)
		}
		var out json.RawMessage
		return out, c.client.Do(c.ctx, http.MethodPost, "/conversations/ack", nil, map[string]uint64{"seq": seq}, &out)
	}},
	"events": {"[--after SEQ] [--timeout SECONDS]", "Wait for conversation events after SEQ", func(c *conversationCall) (any, error) {
		query := url.Values{"after": {strconv.FormatUint(c.flags.after, 10)}}
		if c.flags.timeout > 0 {
			query.Set("timeout", strconv.FormatFloat(c.flags.timeout, 'f', -1, 64))
		}
		var out json.RawMessage
		return out, c.client.Do(c.ctx, http.MethodGet, "/conversations/wait", query, nil, &out)
	}},
	"resolve": {"ID", "Resolve a conversation", statusOperation("resolve")},
	"reopen":  {"ID", "Reopen a resolved conversation", statusOperation("reopen")},
}

func statusOperation(action string) func(*conversationCall) (any, error) {
	return func(c *conversationCall) (any, error) {
		id, err := c.arg(0, "conversation id")
		if err != nil {
			return nil, err
		}
		var out json.RawMessage
		return out, c.client.Do(c.ctx, http.MethodPost, "/conversations/"+url.PathEscape(id)+"/"+action, nil, struct{}{}, &out)
	}
}

func runConversationsCLI(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fail := func(code int, err error) int {
		encoder := json.NewEncoder(stderr)
		encoder.SetEscapeHTML(false)
		_ = encoder.Encode(map[string]string{"error": err.Error()})
		return code
	}
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		printConversationsUsage(stdout)
		return 0
	}
	operation, ok := conversationCommands[args[0]]
	if !ok {
		return fail(2, fmt.Errorf("unknown command %q; run 'gitna %s --help'", args[0], conversationsCommand))
	}
	flags := &conversationFlags{}
	set := flag.NewFlagSet(args[0], flag.ContinueOnError)
	set.SetOutput(io.Discard)
	set.StringVar(&flags.repo, "repo", ".", "")
	set.StringVar(&flags.as, "as", "", "")
	set.StringVar(&flags.participant, "participant", "", "")
	set.StringVar(&flags.path, "path", "", "")
	set.StringVar(&flags.lines, "lines", "", "")
	set.StringVar(&flags.source, "source", conversations.SourceWorktree, "")
	set.StringVar(&flags.revision, "revision", "", "")
	set.StringVar(&flags.id, "id", "", "")
	set.StringVar(&flags.body, "body", "", "")
	set.StringVar(&flags.bodyFile, "body-file", "", "")
	set.Float64Var(&flags.wait, "wait", 0, "")
	set.Float64Var(&flags.timeout, "timeout", 0, "")
	set.Uint64Var(&flags.after, "after", 0, "")
	set.Var(&flags.to, "to", "")
	var positional []string
	rest := args[1:]
	for {
		if err := set.Parse(rest); err != nil {
			return fail(2, err)
		}
		if set.NArg() == 0 {
			break
		}
		positional = append(positional, set.Arg(0))
		rest = set.Args()[1:]
	}
	if args[0] != joinCommand && flags.participant == "" {
		return fail(2, fmt.Errorf("pass --participant ID; run 'gitna %s %s' once to get an id, then reuse it for every command, also after reconnecting", conversationsCommand, joinCommand))
	}
	repo, err := filepath.Abs(flags.repo)
	if err != nil {
		return fail(1, err)
	}
	dir, err := agentlink.Dir()
	if err != nil {
		return fail(1, err)
	}
	client, sessionData, err := agentclient.Discover(ctx, dir, repo, flags.participant)
	if err != nil {
		return fail(1, err)
	}
	var session struct {
		Root string `json:"root"`
	}
	_ = json.Unmarshal(sessionData, &session)
	result, err := operation.run(&conversationCall{
		ctx: ctx, client: client, root: session.Root, positional: positional, flags: flags, stdin: stdin,
	})
	if err != nil {
		var apiErr *agentclient.APIError
		if errors.As(err, &apiErr) && apiErr.Status < 500 {
			return fail(1, errors.New(apiErr.Message))
		}
		return fail(1, err)
	}
	encoder := json.NewEncoder(stdout)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(result); err != nil {
		return fail(1, err)
	}
	return 0
}

// messageID is the caller's id for a new message. Generating one here would
// make a retried command store the message twice.
func (c *conversationCall) messageID() (string, error) {
	if c.flags.id == "" {
		return "", errors.New("--id is required: choose a new unique id for this message, and reuse it only to retry this same message")
	}
	return c.flags.id, nil
}

func (c *conversationCall) arg(index int, name string) (string, error) {
	if index >= len(c.positional) {
		return "", fmt.Errorf("missing %s", name)
	}
	return c.positional[index], nil
}

func (c *conversationCall) body() (string, error) {
	switch {
	case c.flags.body != "":
		return c.flags.body, nil
	case c.flags.bodyFile != "" && c.flags.bodyFile != "-":
		data, err := os.ReadFile(c.flags.bodyFile)
		return string(data), err
	}
	if file, ok := c.stdin.(*os.File); ok && c.flags.bodyFile == "" {
		if info, err := file.Stat(); err == nil && info.Mode()&os.ModeCharDevice != 0 {
			return "", errors.New("message body required: pass --body, --body-file, or pipe it on stdin")
		}
	}
	data, err := io.ReadAll(io.LimitReader(c.stdin, conversations.MaxBodyBytes+1))
	return string(data), err
}

// anchor names the selected lines; Gitna records their code and context.
func (c *conversationCall) anchor() (conversations.Anchor, error) {
	if c.flags.path == "" || c.flags.lines == "" {
		return conversations.Anchor{}, errors.New("--path and --lines are required")
	}
	startText, endText, ranged := strings.Cut(c.flags.lines, "-")
	start, err := strconv.Atoi(startText)
	end := start
	if err == nil && ranged {
		end, err = strconv.Atoi(endText)
	}
	if err != nil || start < 1 || end < start {
		return conversations.Anchor{}, fmt.Errorf("invalid --lines %q; use N or N-M", c.flags.lines)
	}
	path := c.flags.path
	if filepath.IsAbs(path) {
		if path, err = filepath.Rel(c.root, path); err != nil {
			return conversations.Anchor{}, err
		}
	}
	return conversations.Anchor{
		Path: filepath.ToSlash(filepath.Clean(path)), Source: c.flags.source, Revision: c.flags.revision,
		StartLine: start, EndLine: end,
	}, nil
}

func printConversationsUsage(output io.Writer) {
	fmt.Fprintf(output, `Experimental agent interface to Gitna conversations. Command names may change.

Usage:
  gitna %s COMMAND [arguments] [--repo DIR] --participant ID

Talks to the running Gitna that has the repository open. Output is JSON;
errors are {"error": "..."} on stderr. Exit status 2 means the command line
was invalid; 1 means the command failed.

Identity: run 'join' once, with --as NAME for the name people see (default
"Agent"). Gitna returns a participant id that owns your inbox and
acknowledgments. Pass it with --participant to every other command, also
after reconnecting. Several participants may share a NAME.

Routing: a message is pending only for the participants it is addressed to.
Name them with --to ID. A person's message without --to goes to the agents
last addressed in the conversation, otherwise the agent that wrote there
last, otherwise the only joined agent; with several joined agents it stays
unassigned. Agent messages without --to notify no other agent.

Commands:
`, conversationsCommand)
	names := make([]string, 0, len(conversationCommands))
	for name := range conversationCommands {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		operation := conversationCommands[name]
		fmt.Fprintf(output, "  %-8s %s\n           %s\n", name, operation.args, operation.summary)
	}
}
