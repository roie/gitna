package agentrun

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	acp "github.com/caelis-labs/acp-go-sdk"
	"github.com/caelis-labs/acp-go-sdk/transport/stdio"
)

type AuthMethod struct {
	ID          string
	Name        string
	Description string
	Interactive bool
}

var ErrAuthRequired = errors.New("agent authentication required")

type AuthError struct{ Methods []AuthMethod }

func (e *AuthError) Error() string { return ErrAuthRequired.Error() }
func (e *AuthError) Unwrap() error { return ErrAuthRequired }

type PermissionOption struct{ ID, Name, Kind string }
type PermissionRequest struct {
	ID, Title string
	Options   []PermissionOption
}

type Hooks struct {
	Activity   func(string)
	Permission func(context.Context, PermissionRequest) (optionID string, ok bool)
}

type runClient struct {
	hooks Hooks
	mu    sync.Mutex
	all   strings.Builder
	tail  strings.Builder
}

func (c *runClient) SessionUpdate(_ context.Context, p acp.SessionNotification) error {
	u := p.Update
	activity := ""
	c.mu.Lock()
	if u.AgentMessageChunk != nil && u.AgentMessageChunk.Content.Text != nil {
		text := u.AgentMessageChunk.Content.Text.Text
		c.all.WriteString(text)
		c.tail.WriteString(text)
	}
	if u.ToolCall != nil {
		c.tail.Reset()
		activity = u.ToolCall.Title
	}
	if u.ToolCallUpdate != nil && u.ToolCallUpdate.Title != nil {
		activity = *u.ToolCallUpdate.Title
	}
	c.mu.Unlock()
	if c.hooks.Activity != nil {
		c.hooks.Activity(activity)
	}
	return nil
}

func (c *runClient) reply() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if reply := strings.TrimSpace(c.tail.String()); reply != "" {
		return reply
	}
	return strings.TrimSpace(c.all.String())
}

func (c *runClient) RequestPermission(ctx context.Context, p acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
	request := PermissionRequest{ID: rand.Text()}
	if p.ToolCall.Title != nil {
		request.Title = *p.ToolCall.Title
	}
	for _, option := range p.Options {
		request.Options = append(request.Options, PermissionOption{ID: string(option.OptionId), Name: option.Name, Kind: string(option.Kind)})
	}
	if c.hooks.Permission != nil {
		if id, ok := c.hooks.Permission(ctx, request); ok {
			for _, option := range p.Options {
				if string(option.OptionId) == id {
					return acp.RequestPermissionResponse{Outcome: acp.RequestPermissionOutcome{Selected: &acp.RequestPermissionOutcomeSelected{OptionId: option.OptionId}}}, nil
				}
			}
		}
	}
	return acp.RequestPermissionResponse{Outcome: acp.RequestPermissionOutcome{Cancelled: &acp.RequestPermissionOutcomeCancelled{}}}, nil
}

func startClient(ctx context.Context, def Definition, root string, client *runClient) (*stdio.ClientProcess, error) {
	return stdio.StartClient(context.WithoutCancel(ctx), client, stdio.Command{Executable: def.Executable, Args: def.Args, Dir: root}, acp.ConnectionOptions{})
}

func shutdown(process *stdio.ClientProcess) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	process.Shutdown(ctx)
}

func newSession(ctx context.Context, process *stdio.ClientProcess, root, method string) (acp.SessionId, error) {
	conn := process.Connection
	init, err := conn.Initialize(ctx, acp.InitializeRequest{ProtocolVersion: 1})
	if err != nil {
		return "", err
	}
	if init.ProtocolVersion != 1 {
		return "", fmt.Errorf("unsupported ACP protocol version %d", init.ProtocolVersion)
	}
	methods := make([]AuthMethod, 0, len(init.AuthMethods))
	for _, m := range init.AuthMethods {
		var method AuthMethod
		if m.Agent != nil {
			method.ID, method.Name = string(m.Agent.Id), m.Agent.Name
			if m.Agent.Description != nil {
				method.Description = *m.Agent.Description
			}
		} else if m.Terminal != nil {
			method.ID, method.Name, method.Interactive = string(m.Terminal.Id), m.Terminal.Name, true
			if m.Terminal.Description != nil {
				method.Description = *m.Terminal.Description
			}
		}
		methods = append(methods, method)
	}
	authError := func(err error) error {
		if request, ok := errors.AsType[*acp.RequestError](err); ok && request.Code == -32000 {
			return &AuthError{Methods: methods}
		}
		return err
	}
	if method != "" {
		found := false
		for _, m := range methods {
			if m.ID == method && !m.Interactive {
				found = true
			}
		}
		if !found {
			return "", errors.New("this authentication method cannot run in Gitna")
		}
		if _, err := conn.Authenticate(ctx, acp.AuthenticateRequest{MethodId: acp.AuthMethodId(method)}); err != nil {
			return "", authError(err)
		}
	}
	session, err := conn.NewSession(ctx, acp.NewSessionRequest{Cwd: root, McpServers: []acp.McpServer{}})
	return session.SessionId, authError(err)
}

func Verify(ctx context.Context, def Definition, root, authMethod string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	process, err := startClient(ctx, def, root, &runClient{})
	if err != nil {
		return err
	}
	defer shutdown(process)
	_, err = newSession(ctx, process, root, authMethod)
	return err
}

func Run(ctx context.Context, def Definition, root, prompt string, hooks Hooks) (string, error) {
	client := &runClient{hooks: hooks}
	process, err := startClient(ctx, def, root, client)
	if err != nil {
		return "", err
	}
	defer shutdown(process)
	session, err := newSession(ctx, process, root, "")
	if err != nil {
		return "", err
	}
	type result struct {
		response acp.PromptResponse
		err      error
	}
	done := make(chan result, 1)
	go func() {
		r, err := process.Connection.Prompt(context.WithoutCancel(ctx), acp.PromptRequest{SessionId: session, Prompt: []acp.ContentBlock{acp.TextBlock(prompt)}})
		done <- result{r, err}
	}()
	var r result
	select {
	case r = <-done:
	case <-ctx.Done():
		cancelCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		process.Connection.Cancel(cancelCtx, acp.CancelNotification{SessionId: session})
		select {
		case <-done:
		case <-cancelCtx.Done():
		}
		return "", context.Cause(ctx)
	}
	if r.err != nil {
		return "", r.err
	}
	if r.response.StopReason == "cancelled" {
		return "", context.Canceled
	}
	reply := client.reply()
	if reply == "" {
		return "", fmt.Errorf("agent stopped without a reply: %s", r.response.StopReason)
	}
	return reply, nil
}
