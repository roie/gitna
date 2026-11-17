package server

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/roie/gitna/internal/agentrun"
	"github.com/roie/gitna/internal/conversations"
)

func (c *Conversations) ensureAgents() {
	if c.Agents != nil {
		c.Agents.Ensure(agentrun.Repo{Root: c.Root, Open: c.Open, Locate: func(ctx context.Context, list []conversations.Conversation) []conversations.Conversation {
			s, err := c.Open()
			if err != nil {
				return nil
			}
			return s.Locate(ctx, list, c.Sources, "")
		}})
	}
}

func (c *Conversations) browserControl(w http.ResponseWriter, r *http.Request, rest string) bool {
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	add := rest == "/agents" && r.Method == http.MethodPost
	del := len(parts) == 2 && parts[0] == "agents" && r.Method == http.MethodDelete
	leave := len(parts) == 3 && parts[0] == "participants" && parts[2] == "leave" && r.Method == http.MethodPost
	control := len(parts) == 3 && parts[0] == "runs" && (parts[2] == "cancel" || parts[2] == "permission") && r.Method == http.MethodPost
	retry := len(parts) == 4 && parts[1] == "messages" && parts[3] == "retry" && r.Method == http.MethodPost
	if !add && !del && !leave && !control && !retry {
		return false
	}
	if c.Agents == nil || c.Settings == nil {
		writeJSON(w, 503, map[string]string{"error": "agents unavailable"})
		return true
	}
	var err error
	switch {
	case add:
		c.addAgent(w, r)
		return true
	case del:
		err = c.Settings.Update(func(s *agentrun.Settings) error {
			i := slices.IndexFunc(s.Agents, func(d agentrun.Definition) bool { return d.ID == parts[1] })
			if i < 0 {
				return conversations.ErrNotFound
			}
			s.Agents = slices.Delete(s.Agents, i, i+1)
			return nil
		})
	case leave:
		var s *conversations.Store
		s, err = c.Open()
		if err == nil {
			err = s.Leave(parts[1])
		}
	case retry:
		var body struct {
			Participant string `json:"participant"`
		}
		if !decodeConversationRequest(w, r, &body) {
			return true
		}
		err = c.Agents.Retry(c.Root, parts[0], parts[2], body.Participant)
	case control:
		id, parseErr := strconv.ParseUint(parts[1], 10, 64)
		if parseErr != nil {
			err = conversations.ErrNotFound
			break
		}
		if parts[2] == "cancel" {
			err = c.Agents.Cancel(c.Root, id)
		} else {
			var body struct {
				RequestID string `json:"requestId"`
				OptionID  string `json:"optionId"`
			}
			if !decodeConversationRequest(w, r, &body) {
				return true
			}
			err = c.Agents.Answer(c.Root, id, body.RequestID, body.OptionID)
		}
	}
	if err != nil {
		writeAgentError(w, err)
	} else {
		writeJSON(w, 200, struct{}{})
	}
	return true
}
func writeAgentError(w http.ResponseWriter, err error) {
	if errors.Is(err, agentrun.ErrNotRunner) {
		writeJSON(w, 409, map[string]string{"code": "other-process"})
		return
	}
	writeConversationError(w, err)
}
func (c *Conversations) addAgent(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name       string `json:"name"`
		Command    string `json:"command"`
		AuthMethod string `json:"authMethod"`
		Definition string `json:"definition"`
	}
	if !decodeConversationRequest(w, r, &body) {
		return
	}
	var def agentrun.Definition
	var err error
	if body.Definition != "" {
		for _, d := range c.Settings.Get().Agents {
			if d.ID == body.Definition {
				def = d
				break
			}
		}
		if def.ID == "" {
			writeConversationError(w, conversations.ErrNotFound)
			return
		}
	} else {
		def, err = agentrun.Resolve(body.Name, body.Command)
		if err != nil {
			writeJSON(w, 422, map[string]string{"error": err.Error()})
			return
		}
	}
	if err = agentrun.Verify(r.Context(), def, c.Root, body.AuthMethod); err != nil {
		if auth, ok := errors.AsType[*agentrun.AuthError](err); ok {
			writeJSON(w, 409, struct {
				Code    string                `json:"code"`
				Methods []agentrun.AuthMethod `json:"methods"`
			}{"auth-required", auth.Methods})
		} else {
			writeJSON(w, 422, map[string]string{"error": "The command did not start an ACP agent. Check that it includes the agent's ACP option. " + err.Error()})
		}
		return
	}
	if body.Definition == "" {
		if err = c.Settings.Update(func(s *agentrun.Settings) error { s.Agents = append(s.Agents, def); return nil }); err != nil {
			writeAgentError(w, err)
			return
		}
	}
	store, err := c.Open()
	if err != nil {
		writeAgentError(w, err)
		return
	}
	p, err := store.JoinNative(def.Name, def.ID)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	c.ensureAgents()
	writeJSON(w, 200, struct {
		Definition  agentrun.Definition       `json:"definition"`
		Participant conversations.Participant `json:"participant"`
	}{def, p})
}

func (c *Conversations) settings(w http.ResponseWriter) {
	var settings agentrun.Settings
	if c.Settings != nil {
		settings = c.Settings.Get()
	}
	enabled := c.Enabled != nil && c.Enabled()
	available, setup := []agentrun.Found{}, []agentrun.Setup{}
	if enabled {
		available, setup = agentrun.Discover(settings.Agents)
	}
	writeJSON(w, http.StatusOK, struct {
		Enabled   bool                  `json:"enabled"`
		Agents    []agentrun.Definition `json:"agents"`
		Available []agentrun.Found      `json:"available"`
		Setup     []agentrun.Setup      `json:"setup"`
	}{Enabled: enabled, Agents: nonNil(settings.Agents), Available: available, Setup: setup})
}
