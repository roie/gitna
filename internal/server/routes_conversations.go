package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/roie/gitna/internal/conversations"
)

const maxConversationWait = 10 * time.Minute

// Conversations connects one repository's conversation store to the API.
type Conversations struct {
	Root  string
	Human func() conversations.Participant
	Open  func() (*conversations.Store, error)
	// Content reads anchored files; Head names the current commit, or "".
	Content conversations.Content
	Head    func(ctx context.Context) string
	Renames conversations.Renames
	Changed conversations.Changed
}

// complete fills what a client may leave to Gitna: the commit a worktree or
// index anchor was made at, and the anchored code with its context.
func (c *Conversations) complete(ctx context.Context, anchor *conversations.Anchor) error {
	if anchor.Source == "" {
		anchor.Source = conversations.SourceWorktree
	}
	if anchor.Source != conversations.SourceCommit && anchor.Revision == "" && c.Head != nil {
		anchor.Revision = c.Head(ctx)
	}
	if anchor.Code != "" || anchor.Before != "" || anchor.After != "" || c.Content == nil {
		return nil
	}
	data, err := c.Content(ctx, anchor.Source, anchor.Revision, anchor.Path)
	if err != nil {
		return fmt.Errorf("%w: cannot read %s: %v", conversations.ErrInvalid, anchor.Path, err)
	}
	return conversations.Capture(anchor, data)
}

type createConversationRequest struct {
	ID     string               `json:"id"`
	Anchor conversations.Anchor `json:"anchor"`
	Body   string               `json:"body"`
}

type replyRequest struct {
	ID   string `json:"id"`
	Body string `json:"body"`
}

type ackRequest struct {
	Seq uint64 `json:"seq"`
}

type conversationList struct {
	Participant   conversations.Participant    `json:"participant"`
	Conversations []conversations.Conversation `json:"conversations"`
	Seq           uint64                       `json:"seq"`
	Cursor        uint64                       `json:"cursor"`
	// Read is how far the participant has read each conversation.
	Read map[string]uint64 `json:"read"`
}

type pendingResponse struct {
	Participant conversations.Participant `json:"participant"`
	Cursor      uint64                    `json:"cursor"`
	Pending     []conversations.Pending   `json:"pending"`
}

func (s *Server) handleConversations(w http.ResponseWriter, r *http.Request, rest string) {
	if s.conversations == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "conversations unavailable"})
		return
	}
	if s.hub.src != nil {
		// Streams and long polls must end with the folder session, or closing
		// the folder would wait for them forever.
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		go func() {
			select {
			case <-s.hub.done:
				cancel()
			case <-ctx.Done():
			}
		}()
		r = r.WithContext(ctx)
	}
	s.conversations.serve(w, r, rest, s.conversations.Human())
}

// serve handles rest, the path below /conversations, for actor.
func (c *Conversations) serve(w http.ResponseWriter, r *http.Request, rest string, actor conversations.Participant) {
	store, err := c.Open()
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "conversations unavailable: " + err.Error()})
		return
	}
	id, action, _ := strings.Cut(strings.TrimPrefix(rest, "/"), "/")
	switch {
	case r.Method == http.MethodGet && id == "":
		list, seq, err := store.List("")
		if err != nil {
			writeConversationError(w, err)
			return
		}
		list = store.Locate(r.Context(), list, c.Content, c.Renames, c.Changed, r.URL.Query().Get("path"))
		cursor, err := store.Cursor(actor.ID)
		if err != nil {
			writeConversationError(w, err)
			return
		}
		read, err := store.Read(actor.ID)
		if err != nil {
			writeConversationError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, conversationList{Participant: actor, Conversations: list, Seq: seq, Cursor: cursor, Read: read})
	case r.Method == http.MethodPost && id == "":
		var request createConversationRequest
		if !decodeConversationRequest(w, r, &request) {
			return
		}
		if err := c.complete(r.Context(), &request.Anchor); err != nil {
			writeConversationError(w, err)
			return
		}
		conversation, err := store.Create(actor, request.ID, request.Anchor, request.Body)
		if err != nil {
			writeConversationError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, c.locate(r, store, conversation))
	case r.Method == http.MethodGet && id == "events" && action == "":
		c.streamEvents(w, r, store)
	case r.Method == http.MethodGet && id == "wait" && action == "":
		after, _ := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
		ctx, cancel := context.WithTimeout(r.Context(), waitDuration(r))
		defer cancel()
		events, err := store.Wait(ctx, after)
		if err != nil {
			writeConversationError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"events": nonNil(events)})
	case r.Method == http.MethodGet && id == "pending" && action == "":
		ctx, cancel := context.WithTimeout(r.Context(), waitDuration(r))
		defer cancel()
		pending, cursor, err := store.WaitPending(ctx, actor.ID)
		if err != nil {
			writeConversationError(w, err)
			return
		}
		for index := range pending {
			pending[index].Conversation = c.locate(r, store, pending[index].Conversation)
		}
		writeJSON(w, http.StatusOK, pendingResponse{Participant: actor, Cursor: cursor, Pending: pending})
	case r.Method == http.MethodPost && id == "ack" && action == "":
		var request ackRequest
		if !decodeConversationRequest(w, r, &request) {
			return
		}
		cursor, err := store.Ack(actor.ID, request.Seq)
		if err != nil {
			writeConversationError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]uint64{"cursor": cursor})
	case r.Method == http.MethodGet && id != "" && action == "":
		conversation, err := store.Get(id)
		if err != nil {
			writeConversationError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, c.locate(r, store, conversation))
	case r.Method == http.MethodPost && id != "" && action == "messages":
		var request replyRequest
		if !decodeConversationRequest(w, r, &request) {
			return
		}
		message, err := store.Reply(actor, id, request.ID, request.Body)
		if err != nil {
			writeConversationError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, message)
	case r.Method == http.MethodPost && id != "" && action == "read":
		var request ackRequest
		if !decodeConversationRequest(w, r, &request) {
			return
		}
		seq, err := store.MarkRead(actor.ID, id, request.Seq)
		if err != nil {
			writeConversationError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]uint64{"seq": seq})
	case r.Method == http.MethodPost && id != "" && (action == "resolve" || action == "reopen"):
		status := conversations.StatusOpen
		if action == "resolve" {
			status = conversations.StatusResolved
		}
		conversation, err := store.SetStatus(actor, id, status)
		if err != nil {
			writeConversationError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, c.locate(r, store, conversation))
	case r.Method == http.MethodPost && id != "" && (action == "delete" || action == "restore"):
		if actor.Kind != conversations.KindHuman {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "only people can delete or restore conversations"})
			return
		}
		conversation, err := store.SetDeleted(actor, id, action == "delete")
		if err != nil {
			writeConversationError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, c.locate(r, store, conversation))
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	}
}

func (c *Conversations) locate(r *http.Request, store *conversations.Store, conversation conversations.Conversation) conversations.Conversation {
	return store.Locate(r.Context(), []conversations.Conversation{conversation}, c.Content, c.Renames, c.Changed, "")[0]
}

// streamEvents sends durable events as SSE. Event ids are log sequence
// numbers, so EventSource reconnection resumes from Last-Event-ID.
func (c *Conversations) streamEvents(w http.ResponseWriter, r *http.Request, store *conversations.Store) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
		return
	}
	after, _ := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
	if last, err := strconv.ParseUint(r.Header.Get("Last-Event-ID"), 10, 64); err == nil {
		after = last
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()
	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()
	for {
		events, changed, err := store.Events(after)
		if err != nil {
			return
		}
		for _, event := range events {
			data, _ := json.Marshal(event)
			fmt.Fprintf(w, "id: %d\nevent: conversation\ndata: %s\n\n", event.Seq, data)
			after = event.Seq
		}
		if len(events) > 0 {
			flusher.Flush()
		}
		select {
		case <-r.Context().Done():
			return
		case <-changed:
		case <-ticker.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

func waitDuration(r *http.Request) time.Duration {
	seconds, err := strconv.ParseFloat(r.URL.Query().Get("timeout"), 64)
	if err != nil || seconds <= 0 {
		return 0
	}
	return min(time.Duration(seconds*float64(time.Second)), maxConversationWait)
}

func decodeConversationRequest(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, MaxRequestBody)
	if err := json.NewDecoder(r.Body).Decode(target); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return false
	}
	return true
}

func writeConversationError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, conversations.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	case errors.Is(err, conversations.ErrConflict):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, conversations.ErrInvalid):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
}

func nonNil[T any](values []T) []T {
	if values == nil {
		return []T{}
	}
	return values
}
