package server

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"strings"

	"github.com/roie/gitna/internal/conversations"
)

// AgentPathPrefix namespaces the coding-agent API. It is separate from the
// browser capability URL and accepts only conversation operations.
const AgentPathPrefix = "/agent/v1"

// ErrFolderNotOpen reports that the agent's folder is not open in this process.
var ErrFolderNotOpen = errors.New("folder is not open in this Gitna session")

// AgentAPI serves conversations to local coding agents. Requests authenticate
// with a bearer token read from a user-private discovery file; browser
// requests are refused so page scripts cannot reach this surface.
type AgentAPI struct {
	Token   string
	Host    string
	Version string
	// Resolve returns the conversations of the open folder containing path.
	Resolve func(ctx context.Context, path string) (*Conversations, error)
}

type agentSession struct {
	Version     string                     `json:"version"`
	Root        string                     `json:"root"`
	Participant *conversations.Participant `json:"participant,omitempty"`
	Cursor      uint64                     `json:"cursor"`
	Seq         uint64                     `json:"seq"`
	// Agents are the joined agents that have not left.
	Agents []conversations.Participant `json:"agents"`
}

func (a *AgentAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setSecurityHeaders(w)
	if a.Token == "" || r.Host != a.Host || r.Header.Get("Origin") != "" || r.Header.Get("Sec-Fetch-Site") != "" ||
		r.Header.Get("Sec-Fetch-Mode") != "" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || subtle.ConstantTimeCompare([]byte(token), []byte(a.Token)) != 1 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if isMutation(r.Method) {
		if ct, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || ct != "application/json" {
			writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "unsupported media type"})
			return
		}
	}
	rest, ok := strings.CutPrefix(r.URL.Path, AgentPathPrefix)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	folder := r.URL.Query().Get("repo")
	if folder == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "repo is required"})
		return
	}
	backend, err := a.Resolve(r.Context(), folder)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, ErrFolderNotOpen) {
			status = http.StatusNotFound
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	store, err := backend.Open()
	if err != nil {
		writeConversationError(w, err)
		return
	}
	if rest == "/participants" && r.Method == http.MethodPost {
		var request struct {
			Name string `json:"name"`
		}
		if !decodeConversationRequest(w, r, &request) {
			return
		}
		participant, err := store.Join(request.Name)
		if err != nil {
			writeConversationError(w, err)
			return
		}
		a.writeSession(w, store, backend, &participant)
		return
	}
	// Gitna issued the participant id at join; it routes this agent's inbox
	// and acknowledgments, and is not proof of who is calling.
	var actor *conversations.Participant
	if id := r.Header.Get("Gitna-Participant"); id != "" {
		participant, err := store.Participant(id)
		if err != nil {
			writeJSON(w, http.StatusForbidden, map[string]string{
				"error": fmt.Sprintf("unknown participant %q in %s; join first and reuse the id it returns", id, backend.Root),
			})
			return
		}
		actor = &participant
	} else if rest != "/session" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Gitna-Participant is required"})
		return
	}
	switch {
	case rest == "/session" && r.Method == http.MethodGet:
		a.writeSession(w, store, backend, actor)
	case rest == "/participants/leave" && r.Method == http.MethodPost:
		if err := store.Leave(actor.ID); err != nil {
			writeConversationError(w, err)
			return
		}
		a.writeSession(w, store, backend, actor)
	case rest == "/conversations" || strings.HasPrefix(rest, "/conversations/"):
		backend.serve(w, r, strings.TrimPrefix(rest, "/conversations"), *actor)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	}
}

// writeSession describes the open repository and, when known, the calling
// participant with its acknowledgment cursor.
func (a *AgentAPI) writeSession(w http.ResponseWriter, store *conversations.Store, backend *Conversations, actor *conversations.Participant) {
	_, seq, err := store.List("")
	if err != nil {
		writeConversationError(w, err)
		return
	}
	agents, err := store.Agents()
	if err != nil {
		writeConversationError(w, err)
		return
	}
	session := agentSession{Version: a.Version, Root: backend.Root, Participant: actor, Seq: seq, Agents: nonNil(agents)}
	if actor != nil {
		if session.Cursor, err = store.Cursor(actor.ID); err != nil {
			writeConversationError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, session)
}
