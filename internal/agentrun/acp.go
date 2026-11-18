package agentrun

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	acp "github.com/caelis-labs/acp-go-sdk"
	"github.com/caelis-labs/acp-go-sdk/transport/stdio"
)

type AuthMethod struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Interactive bool   `json:"interactive"`
}

var ErrAuthRequired = errors.New("agent authentication required")

type AuthError struct{ Methods []AuthMethod }

func (e *AuthError) Error() string { return ErrAuthRequired.Error() }
func (e *AuthError) Unwrap() error { return ErrAuthRequired }

type PermissionOption struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}
type PermissionRequest struct {
	ID      string             `json:"id"`
	Title   string             `json:"title"`
	Options []PermissionOption `json:"options"`
}

type Hooks struct {
	// Activity receives what the agent is doing, such as "Running a command",
	// and the tool's own title. Both are empty while it writes.
	Activity func(label, detail string)
	// Text receives everything the agent has written so far. It only grows;
	// the finished reply, which drops text written before its last tool call,
	// replaces it.
	Text       func(string)
	Permission func(context.Context, PermissionRequest) (optionID string, ok bool)
}

type runClient struct {
	hooks Hooks
	mu    sync.Mutex
	all   strings.Builder
	tail  strings.Builder
	kind  acp.ToolKind
	title string
}

func (c *runClient) SessionUpdate(_ context.Context, p acp.SessionNotification) error {
	u := p.Update
	c.mu.Lock()
	if u.AgentMessageChunk != nil {
		c.kind, c.title = "", ""
		if u.AgentMessageChunk.Content.Text != nil {
			text := u.AgentMessageChunk.Content.Text.Text
			c.all.WriteString(text)
			c.tail.WriteString(text)
		}
	}
	if u.ToolCall != nil {
		c.tail.Reset()
		c.kind, c.title = u.ToolCall.Kind, u.ToolCall.Title
		if c.kind == "" {
			c.kind = acp.ToolKindOther
		}
	}
	if u := u.ToolCallUpdate; u != nil {
		if u.Kind != nil {
			c.kind = *u.Kind
		}
		if u.Title != nil {
			c.title = *u.Title
		}
	}
	label, detail := toolLabel(c.kind), c.title
	text := strings.TrimSpace(c.all.String())
	c.mu.Unlock()
	if c.hooks.Text != nil && u.AgentMessageChunk != nil {
		c.hooks.Text(text)
	}
	if c.hooks.Activity != nil {
		c.hooks.Activity(label, detail)
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
	return stdio.StartClient(context.WithoutCancel(ctx), client, stdio.Command{Executable: def.Executable, Args: def.Args, Dir: root}, acp.ConnectionOptions{
		AcceptNotification: func(method string) bool { return method == acp.ClientMethodSessionUpdate },
	})
}

func shutdown(process *stdio.ClientProcess) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	process.Shutdown(ctx)
}

func newSession(ctx context.Context, process *stdio.ClientProcess, root, method string) (acp.NewSessionResponse, error) {
	conn := process.Connection
	init, err := conn.Initialize(ctx, acp.InitializeRequest{ProtocolVersion: 1})
	if err != nil {
		return acp.NewSessionResponse{}, err
	}
	if init.ProtocolVersion != 1 {
		return acp.NewSessionResponse{}, fmt.Errorf("unsupported ACP protocol version %d", init.ProtocolVersion)
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
			return acp.NewSessionResponse{}, errors.New("this authentication method cannot run in Gitna")
		}
		if _, err := conn.Authenticate(ctx, acp.AuthenticateRequest{MethodId: acp.AuthMethodId(method)}); err != nil {
			return acp.NewSessionResponse{}, authError(err)
		}
	}
	session, err := conn.NewSession(ctx, acp.NewSessionRequest{Cwd: root, McpServers: []acp.McpServer{}})
	return session, authError(err)
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
	started, err := newSession(ctx, process, root, "")
	if err != nil {
		return "", err
	}
	session := started.SessionId
	if err := setModel(ctx, process.Connection, started, def.Model); err != nil {
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

// Model is one model an agent offers.
type Model struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Models are the models an agent offers and the one it uses by default.
type Models struct {
	Default string  `json:"default"`
	Options []Model `json:"options"`
}

var ErrNoModels = errors.New("This agent does not offer a choice of model")

// modelOption returns the agent's model selector from its session options.
func modelOption(options []acp.SessionConfigOption) (*acp.SessionConfigOptionSelect, []Model) {
	for _, o := range options {
		s := o.Select
		if s == nil || s.Category == nil || *s.Category != acp.SessionConfigOptionCategoryModel {
			continue
		}
		var flat []acp.SessionConfigSelectOption
		if s.Options.Ungrouped != nil {
			flat = *s.Options.Ungrouped
		}
		if s.Options.Grouped != nil {
			for _, g := range *s.Options.Grouped {
				flat = append(flat, g.Options...)
			}
		}
		models := make([]Model, len(flat))
		for i, m := range flat {
			models[i] = Model{ID: string(m.Value), Name: m.Name}
		}
		return s, models
	}
	return nil, nil
}

func setModel(ctx context.Context, conn *acp.ClientSideConnection, session acp.NewSessionResponse, model string) error {
	if model == "" {
		return nil
	}
	option, models := modelOption(session.ConfigOptions)
	if option == nil || !slices.ContainsFunc(models, func(m Model) bool { return m.ID == model }) {
		return fmt.Errorf("This agent no longer offers the model %s. Choose another model in Agents", model)
	}
	if string(option.CurrentValue) == model {
		return nil
	}
	_, err := conn.SetSessionConfigOption(ctx, acp.SetSessionConfigOptionRequest{ValueId: &acp.SetSessionConfigOptionValueId{
		SessionId: session.SessionId, ConfigId: option.Id, Value: acp.SessionConfigValueId(model),
	}})
	return err
}

// ListModels starts the agent, reads the models it offers, and stops it.
func ListModels(ctx context.Context, def Definition, root string) (Models, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	process, err := startClient(ctx, def, root, &runClient{})
	if err != nil {
		return Models{}, err
	}
	defer shutdown(process)
	session, err := newSession(ctx, process, root, "")
	if err != nil {
		return Models{}, err
	}
	option, models := modelOption(session.ConfigOptions)
	if option == nil {
		return Models{}, ErrNoModels
	}
	return Models{Default: string(option.CurrentValue), Options: models}, nil
}

func toolLabel(kind acp.ToolKind) string {
	switch kind {
	case "":
		return ""
	case acp.ToolKindRead:
		return "Reading"
	case acp.ToolKindEdit, acp.ToolKindDelete, acp.ToolKindMove:
		return "Editing files"
	case acp.ToolKindSearch:
		return "Searching"
	case acp.ToolKindExecute:
		return "Running a command"
	case acp.ToolKindThink:
		return "Thinking"
	case acp.ToolKindFetch:
		return "Fetching"
	default:
		return "Using a tool"
	}
}
