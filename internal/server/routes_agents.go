package server

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

// rememberedPrefix marks a saved agent definition that is connected in this
// repository but has not been joined to its log yet.
const rememberedPrefix = "def:"

// remembered returns the saved definitions with no participant in store, as
// the participants they will become. Listing them writes nothing.
func (c *Conversations) remembered(store *conversations.Store) ([]conversations.Participant, error) {
	if c.Settings == nil {
		return nil, nil
	}
	natives, err := store.Natives()
	if err != nil {
		return nil, err
	}
	var out []conversations.Participant
	for _, d := range c.Settings.Get().Agents {
		if _, ok := natives[d.ID]; !ok {
			out = append(out, conversations.Participant{ID: rememberedPrefix + d.ID, Kind: conversations.KindAgent, Name: d.Name, Agent: d.ID})
		}
	}
	return out, nil
}

// joinRemembered joins the remembered agents a person's message addresses,
// by "def:" id or by "all", and returns to with their participant ids.
func (c *Conversations) joinRemembered(store *conversations.Store, to []string) ([]string, error) {
	all := slices.Contains(to, conversations.RecipientAll)
	if !all && !slices.ContainsFunc(to, func(id string) bool { return strings.HasPrefix(id, rememberedPrefix) }) {
		return to, nil
	}
	remembered, err := c.remembered(store)
	if err != nil {
		return nil, err
	}
	out := slices.Clone(to)
	joined := map[string]string{}
	join := func(p conversations.Participant) (string, error) {
		if id, ok := joined[p.Agent]; ok {
			return id, nil
		}
		participant, err := store.JoinNative(p.Name, p.Agent)
		joined[p.Agent] = participant.ID
		return participant.ID, err
	}
	for i, id := range out {
		definition, ok := strings.CutPrefix(id, rememberedPrefix)
		if !ok {
			continue
		}
		j := slices.IndexFunc(remembered, func(p conversations.Participant) bool { return p.Agent == definition })
		if j < 0 {
			return nil, fmt.Errorf("%w: unknown recipient %q", conversations.ErrInvalid, id)
		}
		if out[i], err = join(remembered[j]); err != nil {
			return nil, err
		}
	}
	if all {
		for _, p := range remembered {
			if _, err := join(p); err != nil {
				return nil, err
			}
		}
	}
	return out, nil
}

func (c *Conversations) browserControl(w http.ResponseWriter, r *http.Request, rest string) bool {
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	add := rest == "/agents" && r.Method == http.MethodPost
	del := len(parts) == 2 && parts[0] == "agents" && r.Method == http.MethodDelete
	leave := len(parts) == 3 && parts[0] == "participants" && parts[2] == "leave" && r.Method == http.MethodPost
	control := len(parts) == 3 && parts[0] == "runs" && (parts[2] == "cancel" || parts[2] == "permission") && r.Method == http.MethodPost
	retry := len(parts) == 4 && parts[1] == "messages" && parts[3] == "retry" && r.Method == http.MethodPost
	adapter := len(parts) == 3 && parts[0] == "agents" && parts[1] == "adapters" && (r.Method == http.MethodPost || r.Method == http.MethodDelete)
	model := len(parts) == 3 && parts[0] == "agents" && parts[1] != "adapters" && (parts[2] == "models" || parts[2] == "model" || parts[2] == "name") && r.Method == http.MethodPost
	if !add && !del && !leave && !control && !retry && !adapter && !model {
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
	case model && parts[2] == "name":
		c.renameAgent(w, r, parts[1])
		return true
	case model:
		c.agentModel(w, r, parts[1], parts[2] == "models")
		return true
	case adapter && r.Method == http.MethodPost:
		c.installAdapter(w, r, parts[2])
		return true
	case adapter:
		err = agentrun.RemoveAdapter(c.Settings.Adapters, parts[2], c.Settings)
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
		id := parts[1]
		if definition, ok := strings.CutPrefix(id, rememberedPrefix); err == nil && ok {
			var ids []string
			if ids, err = c.joinRemembered(s, []string{rememberedPrefix + definition}); err == nil {
				id = ids[0]
			}
		}
		if err == nil {
			err = s.Leave(id)
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
		p, err := c.reconnect(def)
		if err != nil {
			writeAgentError(w, err)
			return
		}
		c.ensureAgents()
		writeJSON(w, 200, struct {
			Definition  agentrun.Definition       `json:"definition"`
			Participant conversations.Participant `json:"participant"`
		}{def, p})
		return
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
	if err = c.Settings.Update(func(s *agentrun.Settings) error { s.Agents = append(s.Agents, def); return nil }); err != nil {
		writeAgentError(w, err)
		return
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

// reconnect connects a saved definition in this repository without running
// it: a participant that left rejoins, and one never joined stays remembered.
func (c *Conversations) reconnect(def agentrun.Definition) (conversations.Participant, error) {
	store, err := c.Open()
	if err != nil {
		return conversations.Participant{}, err
	}
	natives, err := store.Natives()
	if err != nil {
		return conversations.Participant{}, err
	}
	native, ok := natives[def.ID]
	switch {
	case ok && native.Left:
		return store.Rejoin(native.ID)
	case ok:
		return native.Participant, nil
	}
	return conversations.Participant{ID: rememberedPrefix + def.ID, Kind: conversations.KindAgent, Name: def.Name, Agent: def.ID}, nil
}

func (c *Conversations) settings(w http.ResponseWriter) {
	var settings agentrun.Settings
	if c.Settings != nil {
		settings = c.Settings.Get()
	}
	enabled := c.Enabled != nil && c.Enabled()
	available, setup, adapters := []agentrun.Found{}, []agentrun.Setup{}, []agentrun.Adapter{}
	if enabled {
		available, setup = agentrun.Discover(settings.Agents, c.Settings.Adapters)
		adapters = agentrun.Adapters(c.Settings.Adapters)
	}
	writeJSON(w, http.StatusOK, struct {
		Enabled   bool                  `json:"enabled"`
		Agents    []agentrun.Definition `json:"agents"`
		Available []agentrun.Found      `json:"available"`
		Setup     []agentrun.Setup      `json:"setup"`
		Adapters  []agentrun.Adapter    `json:"adapters"`
	}{Enabled: enabled, Agents: nonNil(settings.Agents), Available: available, Setup: setup, Adapters: adapters})
}

// installAdapter streams the install as JSON lines: progress percentages,
// then the found agent or an error.
func (c *Conversations) installAdapter(w http.ResponseWriter, r *http.Request, program string) {
	w.Header().Set("Content-Type", "application/x-ndjson")
	rc := http.NewResponseController(w)
	enc := json.NewEncoder(w)
	send := func(v any) {
		_ = enc.Encode(v)
		_ = rc.Flush()
	}
	found, err := agentrun.Install(r.Context(), c.Settings.Adapters, program, func(percent int) {
		send(map[string]int{"progress": percent})
	})
	switch {
	case errors.Is(err, agentrun.ErrRequiresNode):
		send(map[string]string{"error": "Requires Node.js"})
	case err != nil:
		send(map[string]string{"error": err.Error()})
	default:
		send(map[string]agentrun.Found{"found": found})
	}
}

// renameAgent renames a saved agent everywhere; an empty name restores its
// default name. Other repositories catch up when their agents are next listed.
func (c *Conversations) renameAgent(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Name string `json:"name"`
	}
	if !decodeConversationRequest(w, r, &body) {
		return
	}
	name := strings.TrimSpace(body.Name)
	if len(name) > 128 {
		writeJSON(w, 400, map[string]string{"error": "an agent name must be at most 128 bytes"})
		return
	}
	err := c.Settings.Update(func(s *agentrun.Settings) error {
		i := slices.IndexFunc(s.Agents, func(d agentrun.Definition) bool { return d.ID == id })
		if i < 0 {
			return conversations.ErrNotFound
		}
		s.Agents[i].Name = cmp.Or(name, agentrun.DefaultName(s.Agents[i].Executable))
		return nil
	})
	if err == nil {
		var store *conversations.Store
		if store, err = c.Open(); err == nil {
			err = c.syncNames(store)
		}
	}
	if err != nil {
		writeAgentError(w, err)
		return
	}
	writeJSON(w, 200, struct{}{})
}

// syncNames gives this repository's native participants the names of their
// saved agents.
func (c *Conversations) syncNames(store *conversations.Store) error {
	if c.Settings == nil {
		return nil
	}
	natives, err := store.Natives()
	if err != nil {
		return err
	}
	for _, d := range c.Settings.Get().Agents {
		if n, ok := natives[d.ID]; ok && n.Name != d.Name {
			if _, err := store.Rename(n.ID, d.Name); err != nil {
				return err
			}
		}
	}
	return nil
}

// agentModel lists the models a saved agent offers, which starts it once, or
// saves the model its runs use.
func (c *Conversations) agentModel(w http.ResponseWriter, r *http.Request, id string, list bool) {
	i := slices.IndexFunc(c.Settings.Get().Agents, func(d agentrun.Definition) bool { return d.ID == id })
	if i < 0 {
		writeConversationError(w, conversations.ErrNotFound)
		return
	}
	def := c.Settings.Get().Agents[i]
	if list {
		models, err := agentrun.ListModels(r.Context(), def, c.Root)
		if auth, ok := errors.AsType[*agentrun.AuthError](err); ok {
			writeJSON(w, 409, struct {
				Code    string                `json:"code"`
				Methods []agentrun.AuthMethod `json:"methods"`
			}{"auth-required", auth.Methods})
			return
		}
		if err != nil {
			writeJSON(w, 422, map[string]string{"error": err.Error()})
			return
		}
		err = c.Settings.Update(func(s *agentrun.Settings) error {
			if i := slices.IndexFunc(s.Agents, func(d agentrun.Definition) bool { return d.ID == id }); i >= 0 {
				s.Agents[i].Models = &models
			}
			return nil
		})
		if err != nil {
			writeAgentError(w, err)
			return
		}
		writeJSON(w, 200, struct {
			agentrun.Models
			Model string `json:"model"`
		}{models, def.Model})
		return
	}
	var body struct {
		Model string `json:"model"`
	}
	if !decodeConversationRequest(w, r, &body) {
		return
	}
	if len(body.Model) > 256 {
		writeJSON(w, 400, map[string]string{"error": "model is too long"})
		return
	}
	err := c.Settings.Update(func(s *agentrun.Settings) error {
		i := slices.IndexFunc(s.Agents, func(d agentrun.Definition) bool { return d.ID == id })
		if i < 0 {
			return conversations.ErrNotFound
		}
		s.Agents[i].Model = body.Model
		return nil
	})
	if err != nil {
		writeAgentError(w, err)
		return
	}
	writeJSON(w, 200, struct{}{})
}
