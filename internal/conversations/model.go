// Package conversations stores code-anchored conversations between people and
// coding agents for one repository. History is an append-only local log kept
// outside the repository; read cursors make unread tracking durable.
package conversations

import (
	"errors"
	"time"
)

const (
	KindHuman = "human"
	KindAgent = "agent"

	StatusOpen     = "open"
	StatusResolved = "resolved"

	SideAdditions = "additions"
	SideDeletions = "deletions"

	SourceWorktree = "worktree"
	SourceIndex    = "index"
	SourceCommit   = "commit"

	ViewFile       = "file"
	ViewWorktree   = "worktree"
	ViewIndex      = "index"
	ViewCommit     = "commit"
	ViewComparison = "comparison"

	EventConversationCreated  = "conversation.created"
	EventMessageCreated       = "message.created"
	EventConversationResolved = "conversation.resolved"
	EventConversationReopened = "conversation.reopened"
	EventConversationMoved    = "conversation.relocated"
	EventConversationDeleted  = "conversation.deleted"
	EventConversationRestored = "conversation.restored"
	// EventParticipantJoined records an agent participant Gitna issued.
	EventParticipantJoined = "participant.joined"

	MaxBodyBytes = 32 << 10
	MaxCodeBytes = 64 << 10
)

var (
	ErrNotFound = errors.New("conversation not found")
	ErrConflict = errors.New("id already used with different content")
	ErrInvalid  = errors.New("invalid conversation request")
)

type Participant struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Name string `json:"name"`
}

// Anchor is the code a conversation was started on. It is never rewritten;
// Location reports where that code is now.
//
// Source names the content the lines belong to: the worktree file, the index
// entry, or the blob at Path in the commit Revision. For the worktree and the
// index, Revision is HEAD when the conversation started. A diff shows two
// contents, so Side says which one was selected and Against is the commit on
// the opposite side, when that side is a commit. View is the surface the
// conversation was started from.
type Anchor struct {
	Path      string `json:"path"`
	View      string `json:"view,omitempty"`
	Source    string `json:"source,omitempty"`
	Revision  string `json:"revision,omitempty"`
	Against   string `json:"against,omitempty"`
	Side      string `json:"side,omitempty"`
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
	Code      string `json:"code"`
	// Before and After are the lines around Code, used to tell identical
	// blocks apart when the code moves.
	Before string `json:"before,omitempty"`
	After  string `json:"after,omitempty"`
}

type Location struct {
	Path      string `json:"path"`
	StartLine int    `json:"startLine"`
	EndLine   int    `json:"endLine"`
	// Status is current, moved, outdated, or missing. Missing code cannot be
	// shown anywhere; the conversation is kept but not presented.
	Status string `json:"status"`
	// Source and Revision are set when the anchored content is gone but Git
	// still has the code: the index, or the commit Revision.
	Source   string `json:"source,omitempty"`
	Revision string `json:"revision,omitempty"`
}

type Message struct {
	ID             string      `json:"id"`
	ConversationID string      `json:"conversationId"`
	Seq            uint64      `json:"seq"`
	Author         Participant `json:"author"`
	Body           string      `json:"body"`
	CreatedAt      time.Time   `json:"createdAt"`
}

type Conversation struct {
	ID        string      `json:"id"`
	Anchor    Anchor      `json:"anchor"`
	Path      string      `json:"path"`
	Location  *Location   `json:"location,omitempty"`
	Status    string      `json:"status"`
	Deleted   bool        `json:"deleted,omitempty"`
	CreatedBy Participant `json:"createdBy"`
	CreatedAt time.Time   `json:"createdAt"`
	UpdatedAt time.Time   `json:"updatedAt"`
	Seq       uint64      `json:"seq"`
	Messages  []Message   `json:"messages"`
}

// Event is one durable log entry. Seq is assigned by log position.
type Event struct {
	Seq            uint64      `json:"seq"`
	Type           string      `json:"type"`
	At             time.Time   `json:"at"`
	ConversationID string      `json:"conversationId"`
	Actor          Participant `json:"actor"`
	Anchor         *Anchor     `json:"anchor,omitempty"`
	Message        *Message    `json:"message,omitempty"`
	Path           string      `json:"path,omitempty"`
}

// Pending is an unacknowledged message from another participant, with the
// conversation it belongs to.
type Pending struct {
	Conversation Conversation `json:"conversation"`
	Message      Message      `json:"message"`
}
