package conversations

import (
	"bytes"
	"cmp"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	logName     = "events.jsonl"
	cursorsName = "cursors.jsonl"
	// readSeparator cannot appear in a participant or conversation id.
	readSeparator = " "
)

var (
	idPattern          = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	participantPattern = regexp.MustCompile(`^(human|agent):[A-Za-z0-9._-]{1,64}$`)
	commitPattern      = regexp.MustCompile(`^([0-9a-f]{40}|[0-9a-f]{64})$`)
)

// record is the on-disk form of an Event. Seq is derived from log position so
// independent writers appending to the same file agree on ordering.
type record struct {
	ID string `json:"id"`
	Event
}

// Store is one repository's conversation log. All methods are safe for
// concurrent use. Writes are fsynced before they are acknowledged.
type Store struct {
	mu        sync.Mutex
	dir       string
	log       *os.File
	offset    int64
	events    []Event
	eventIDs  map[string]struct{}
	byID      map[string]*Conversation
	messageAt map[string]string
	// deletedMessages are hidden from conversations and inboxes but kept, so they can be restored.
	deletedMessages map[string]bool
	// participants are the agents Gitna issued an id to, in join order;
	// left holds the ones that stopped taking part.
	participants map[string]Participant
	joined       []string
	left         map[string]bool
	// cursors merges every line of the cursor log by maximum, so processes
	// sharing a repository never undo each other's acknowledgements.
	cursors      map[string]uint64
	cursorLog    *os.File
	cursorOffset int64
	changed      chan struct{}
	now          func() time.Time
}

func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(dir, logName), os.O_RDWR|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	s := &Store{
		dir:             dir,
		log:             file,
		eventIDs:        make(map[string]struct{}),
		byID:            make(map[string]*Conversation),
		messageAt:       make(map[string]string),
		deletedMessages: make(map[string]bool),
		participants:    make(map[string]Participant),
		left:            make(map[string]bool),
		cursors:         make(map[string]uint64),
		changed:         make(chan struct{}),
		now:             time.Now,
	}
	if _, err := s.catchUp(); err != nil {
		file.Close()
		return nil, err
	}
	s.cursorLog, err = os.OpenFile(filepath.Join(dir, cursorsName), os.O_RDWR|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		file.Close()
		return nil, err
	}
	if err := s.catchUpCursors(); err != nil {
		s.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return errors.Join(s.log.Close(), s.cursorLog.Close())
}

type cursorRecord struct {
	Key string `json:"k"`
	Seq uint64 `json:"s"`
}

// catchUpCursors merges cursor lines written since the last read, including
// lines appended by another process.
func (s *Store) catchUpCursors() error {
	data, end, err := readComplete(s.cursorLog, s.cursorOffset)
	if err != nil || end == 0 {
		return err
	}
	for _, line := range bytes.Split(data[:end-1], []byte{'\n'}) {
		var rec cursorRecord
		if json.Unmarshal(line, &rec) == nil && rec.Seq > s.cursors[rec.Key] {
			s.cursors[rec.Key] = rec.Seq
		}
	}
	s.cursorOffset += int64(end)
	return nil
}

// readComplete reads file from offset and returns the data with the length
// of its complete lines; a torn trailing line is left for a later read.
func readComplete(file *os.File, offset int64) ([]byte, int, error) {
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return nil, 0, err
	}
	data, err := io.ReadAll(file)
	if err != nil {
		return nil, 0, err
	}
	return data, bytes.LastIndexByte(data, '\n') + 1, nil
}

// appendLine durably appends line to file. A torn trailing line from a
// crashed writer must not absorb it.
func appendLine(file *os.File, offset int64, line []byte) error {
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if info.Size() > offset {
		line = append([]byte{'\n'}, line...)
	}
	if _, err := file.Write(append(line, '\n')); err != nil {
		return err
	}
	return file.Sync()
}

// catchUp applies complete log lines written since the last read, including
// lines appended by another process. It returns the newly applied events.
func (s *Store) catchUp() (map[string]Event, error) {
	data, end, err := readComplete(s.log, s.offset)
	if err != nil || end == 0 {
		return nil, err
	}
	applied := make(map[string]Event)
	for _, line := range bytes.Split(data[:end-1], []byte{'\n'}) {
		var rec record
		if len(bytes.TrimSpace(line)) == 0 || json.Unmarshal(line, &rec) != nil {
			continue
		}
		if event, ok := s.apply(rec); ok {
			applied[rec.ID] = event
		}
	}
	s.offset += int64(end)
	if len(applied) > 0 {
		close(s.changed)
		s.changed = make(chan struct{})
	}
	return applied, nil
}

func (s *Store) apply(rec record) (Event, bool) {
	if _, seen := s.eventIDs[rec.ID]; seen || rec.ID == "" {
		return Event{}, false
	}
	event := rec.Event
	switch event.Type {
	case EventParticipantJoined, EventParticipantLeft:
		_, exists := s.participants[event.Actor.ID]
		switch {
		case event.Type == EventParticipantJoined && exists:
			// A participant that left rejoins under its id and name.
			if !s.left[event.Actor.ID] {
				return Event{}, false
			}
			delete(s.left, event.Actor.ID)
		case event.Type == EventParticipantJoined:
			if event.Actor.Kind != KindAgent || validateParticipant(event.Actor) != nil {
				return Event{}, false
			}
			s.participants[event.Actor.ID] = event.Actor
			s.joined = append(s.joined, event.Actor.ID)
		default:
			if !exists || s.left[event.Actor.ID] {
				return Event{}, false
			}
			s.left[event.Actor.ID] = true
		}
		event.Seq = uint64(len(s.events) + 1)
		s.eventIDs[rec.ID] = struct{}{}
		s.events = append(s.events, event)
		return event, true
	}
	conversation := s.byID[event.ConversationID]
	switch event.Type {
	case EventConversationCreated:
		if conversation != nil || event.Anchor == nil || event.Message == nil {
			return Event{}, false
		}
		anchor := normalizeAnchor(*event.Anchor)
		event.Anchor = &anchor
		conversation = &Conversation{
			ID:        event.ConversationID,
			Anchor:    anchor,
			Path:      anchor.Path,
			Status:    StatusOpen,
			CreatedBy: event.Actor,
			CreatedAt: event.At,
		}
		s.byID[conversation.ID] = conversation
	case EventMessageCreated:
		if conversation == nil || event.Message == nil {
			return Event{}, false
		}
		if _, exists := s.messageAt[event.Message.ID]; exists {
			return Event{}, false
		}
	case EventConversationResolved, EventConversationReopened:
		if conversation == nil {
			return Event{}, false
		}
		conversation.Status = StatusOpen
		if event.Type == EventConversationResolved {
			conversation.Status = StatusResolved
		}
	case EventConversationDeleted, EventConversationRestored:
		if conversation == nil {
			return Event{}, false
		}
		conversation.Deleted = event.Type == EventConversationDeleted
	case EventMessageDeleted, EventMessageRestored:
		if conversation == nil || s.messageAt[event.MessageID] != conversation.ID {
			return Event{}, false
		}
		s.deletedMessages[event.MessageID] = event.Type == EventMessageDeleted
	case EventConversationMoved:
		if conversation == nil || event.Path == "" {
			return Event{}, false
		}
		conversation.Path = event.Path
	default:
		return Event{}, false
	}
	event.Seq = uint64(len(s.events) + 1)
	event.Path = conversation.Path
	if event.Message != nil {
		message := *event.Message
		message.Seq = event.Seq
		message.ConversationID = conversation.ID
		event.Message = &message
		conversation.Messages = append(conversation.Messages, message)
		s.messageAt[message.ID] = conversation.ID
	}
	conversation.Seq = event.Seq
	conversation.UpdatedAt = event.At
	s.eventIDs[rec.ID] = struct{}{}
	s.events = append(s.events, event)
	return event, true
}

func (s *Store) append(event Event) (Event, error) {
	if _, err := s.catchUp(); err != nil {
		return Event{}, err
	}
	rec := record{ID: newID("e"), Event: event}
	rec.At = s.now().UTC()
	line, err := json.Marshal(rec)
	if err != nil {
		return Event{}, err
	}
	if err := appendLine(s.log, s.offset, line); err != nil {
		return Event{}, err
	}
	applied, err := s.catchUp()
	if err != nil {
		return Event{}, err
	}
	if event, ok := applied[rec.ID]; ok {
		return event, nil
	}
	return Event{}, ErrConflict
}

// Create starts a conversation with its first message. Repeating a create
// with the same id and content returns the existing conversation.
// Create starts a conversation addressed to the participants in to, or for
// a person without recipients, to the only joined agent.
func (s *Store) Create(actor Participant, id string, anchor Anchor, body string, to []string) (Conversation, error) {
	if id == "" {
		id = newID("c")
	}
	anchor = normalizeAnchor(anchor)
	if err := validateParticipant(actor); err != nil {
		return Conversation{}, err
	}
	if err := validateAnchor(anchor); err != nil {
		return Conversation{}, err
	}
	if !idPattern.MatchString(id) {
		return Conversation{}, fmt.Errorf("%w: invalid id", ErrInvalid)
	}
	body, err := validateBody(body)
	if err != nil {
		return Conversation{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.catchUp(); err != nil {
		return Conversation{}, err
	}
	if to, err = s.recipients(actor, to); err != nil {
		return Conversation{}, err
	}
	// A retry, or a writer in another process that won the race, returns
	// the stored conversation when its content matches.
	existing := func() (Conversation, error) {
		existing := s.byID[id]
		was := existing.Anchor
		if was.Path != anchor.Path || was.Source != anchor.Source || was.Revision != anchor.Revision || was.Side != anchor.Side ||
			was.StartLine != anchor.StartLine || was.EndLine != anchor.EndLine ||
			existing.CreatedBy.ID != actor.ID || existing.Messages[0].Body != body ||
			(len(to) > 0 && !slices.Equal(existing.Messages[0].To, to)) {
			return Conversation{}, ErrConflict
		}
		return s.clone(existing), nil
	}
	if s.byID[id] != nil {
		return existing()
	}
	if len(to) == 0 && actor.Kind == KindHuman {
		to = s.defaultTo(nil)
	}
	message := Message{ID: id + "-1", Author: actor, Body: body, To: to, CreatedAt: s.now().UTC()}
	if _, err := s.append(Event{
		Type: EventConversationCreated, ConversationID: id, Actor: actor, Anchor: &anchor, Message: &message,
	}); errors.Is(err, ErrConflict) && s.byID[id] != nil {
		return existing()
	} else if err != nil {
		return Conversation{}, err
	}
	return s.clone(s.byID[id]), nil
}

// Reply adds a message addressed to the participants in to, or for a person
// without recipients, to the conversation's default recipients. A person's
// reply reopens a resolved conversation. Repeating a reply with the same
// message id returns the stored message.
func (s *Store) Reply(actor Participant, conversationID, messageID, body string, to []string) (Message, error) {
	if messageID == "" {
		messageID = newID("m")
	}
	if err := validateParticipant(actor); err != nil {
		return Message{}, err
	}
	if !idPattern.MatchString(messageID) {
		return Message{}, fmt.Errorf("%w: invalid message id", ErrInvalid)
	}
	body, err := validateBody(body)
	if err != nil {
		return Message{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.catchUp(); err != nil {
		return Message{}, err
	}
	conversation := s.byID[conversationID]
	if conversation == nil || conversation.Deleted {
		return Message{}, ErrNotFound
	}
	if to, err = s.recipients(actor, to); err != nil {
		return Message{}, err
	}
	existing := func(owner string) (Message, error) {
		for _, message := range s.byID[owner].Messages {
			if message.ID == messageID && owner == conversationID && message.Author.ID == actor.ID && message.Body == body &&
				(len(to) == 0 || slices.Equal(message.To, to)) {
				return message, nil
			}
		}
		return Message{}, ErrConflict
	}
	if owner, exists := s.messageAt[messageID]; exists {
		return existing(owner)
	}
	if len(to) == 0 && actor.Kind == KindHuman {
		to = s.defaultTo(conversation)
	}
	message := Message{ID: messageID, Author: actor, Body: body, To: to, CreatedAt: s.now().UTC()}
	event, err := s.append(Event{Type: EventMessageCreated, ConversationID: conversationID, Actor: actor, Message: &message})
	if owner, exists := s.messageAt[messageID]; errors.Is(err, ErrConflict) && exists {
		return existing(owner)
	} else if err != nil {
		return Message{}, err
	}
	if actor.Kind == KindHuman && conversation.Status == StatusResolved {
		if _, err := s.append(Event{Type: EventConversationReopened, ConversationID: conversationID, Actor: actor}); err != nil {
			return Message{}, err
		}
	}
	return *event.Message, nil
}

// SetStatus resolves or reopens a conversation. It is idempotent.
func (s *Store) SetStatus(actor Participant, conversationID, status string) (Conversation, error) {
	if err := validateParticipant(actor); err != nil {
		return Conversation{}, err
	}
	eventType := EventConversationReopened
	switch status {
	case StatusResolved:
		eventType = EventConversationResolved
	case StatusOpen:
	default:
		return Conversation{}, fmt.Errorf("%w: invalid status", ErrInvalid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.catchUp(); err != nil {
		return Conversation{}, err
	}
	conversation := s.byID[conversationID]
	if conversation == nil || conversation.Deleted {
		return Conversation{}, ErrNotFound
	}
	if conversation.Status != status {
		if _, err := s.append(Event{Type: eventType, ConversationID: conversationID, Actor: actor}); err != nil {
			return Conversation{}, err
		}
	}
	return s.clone(conversation), nil
}

// SetDeleted deletes or restores a conversation. A deleted conversation keeps
// its history so it can be restored, but is hidden from lists and inboxes.
func (s *Store) SetDeleted(actor Participant, conversationID string, deleted bool) (Conversation, error) {
	if err := validateParticipant(actor); err != nil {
		return Conversation{}, err
	}
	eventType := EventConversationRestored
	if deleted {
		eventType = EventConversationDeleted
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.catchUp(); err != nil {
		return Conversation{}, err
	}
	conversation := s.byID[conversationID]
	if conversation == nil {
		return Conversation{}, ErrNotFound
	}
	if conversation.Deleted != deleted {
		if _, err := s.append(Event{Type: eventType, ConversationID: conversationID, Actor: actor}); err != nil {
			return Conversation{}, err
		}
	}
	return s.clone(conversation), nil
}

// SetMessageDeleted deletes or restores one message of a conversation. The
// rest of the conversation stays; a conversation's last message is deleted by
// deleting the conversation.
func (s *Store) SetMessageDeleted(actor Participant, conversationID, messageID string, deleted bool) (Conversation, error) {
	if err := validateParticipant(actor); err != nil {
		return Conversation{}, err
	}
	eventType := EventMessageRestored
	if deleted {
		eventType = EventMessageDeleted
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.catchUp(); err != nil {
		return Conversation{}, err
	}
	conversation := s.byID[conversationID]
	if conversation == nil || conversation.Deleted || s.messageAt[messageID] != conversationID {
		return Conversation{}, ErrNotFound
	}
	if s.deletedMessages[messageID] != deleted {
		if deleted && len(s.visible(conversation.Messages)) == 1 {
			return Conversation{}, fmt.Errorf("%w: delete the conversation to delete its last message", ErrInvalid)
		}
		if _, err := s.append(Event{Type: eventType, ConversationID: conversationID, MessageID: messageID, Actor: actor}); err != nil {
			return Conversation{}, err
		}
	}
	return s.clone(conversation), nil
}

// visible returns the messages that are not deleted.
func (s *Store) visible(messages []Message) []Message {
	return slices.DeleteFunc(slices.Clone(messages), func(message Message) bool { return s.deletedMessages[message.ID] })
}

// DefaultAgentName is shown for an agent that joined without a name.
const DefaultAgentName = "Agent"

// Join issues a new agent participant shown as name, or DefaultAgentName.
// Its id owns an inbox and acknowledgment cursor; the agent passes it again
// to reconnect. Names may repeat, so several agents can show the same name.
func (s *Store) Join(name string) (Participant, error) {
	participant := Participant{ID: "agent:" + newID("p"), Kind: KindAgent, Name: cmp.Or(strings.TrimSpace(name), DefaultAgentName)}
	if validateParticipant(participant) != nil {
		return Participant{}, fmt.Errorf("%w: a name must be at most 128 bytes", ErrInvalid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.append(Event{Type: EventParticipantJoined, Actor: participant}); err != nil {
		return Participant{}, err
	}
	return participant, nil
}

// Rejoin makes the agent participant id, which left earlier, a joined agent
// again. Its name, history and acknowledgments stay as they were. Rejoining
// while joined changes nothing.
func (s *Store) Rejoin(id string) (Participant, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.catchUp(); err != nil {
		return Participant{}, err
	}
	participant, ok := s.participants[id]
	if !ok {
		return Participant{}, fmt.Errorf("%w: unknown participant %q", ErrNotFound, id)
	}
	if s.left[id] {
		if _, err := s.append(Event{Type: EventParticipantJoined, Actor: participant}); err != nil {
			return Participant{}, err
		}
	}
	return participant, nil
}

// Touch wakes waiters without writing an event, for changes outside the
// log, such as a file returning, that can make held messages pending again.
func (s *Store) Touch() {
	s.mu.Lock()
	defer s.mu.Unlock()
	close(s.changed)
	s.changed = make(chan struct{})
}

// Leave records that the agent participant id stopped taking part. It keeps
// its history and can still use its id, but is no longer a default
// recipient. Leaving twice is harmless.
func (s *Store) Leave(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.catchUp(); err != nil {
		return err
	}
	if _, ok := s.participants[id]; !ok {
		return fmt.Errorf("%w: unknown participant %q", ErrNotFound, id)
	}
	if s.left[id] {
		return nil
	}
	_, err := s.append(Event{Type: EventParticipantLeft, Actor: s.participants[id]})
	return err
}

// Agents returns the joined agents that have not left, in join order.
func (s *Store) Agents() ([]Participant, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.catchUp(); err != nil {
		return nil, err
	}
	return s.agents(), nil
}

// Participant returns the agent participant Join issued as id. It routes
// messages and acknowledgments; it does not prove who is calling.
func (s *Store) Participant(id string) (Participant, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.catchUp(); err != nil {
		return Participant{}, err
	}
	participant, ok := s.participants[id]
	if !ok {
		return Participant{}, fmt.Errorf("%w: unknown participant %q", ErrNotFound, id)
	}
	return participant, nil
}

// Relocate records that a conversation's file now lives at path.
func (s *Store) Relocate(conversationID, path string) error {
	path = cleanPath(path)
	if !validPath(path) {
		return fmt.Errorf("%w: invalid path", ErrInvalid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	conversation := s.byID[conversationID]
	if conversation == nil {
		return ErrNotFound
	}
	if conversation.Path == path {
		return nil
	}
	_, err := s.append(Event{
		Type: EventConversationMoved, ConversationID: conversationID, Path: path,
		Actor: Participant{ID: "agent:gitna", Kind: KindAgent, Name: "Gitna"},
	})
	return err
}

func (s *Store) Get(id string) (Conversation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.catchUp(); err != nil {
		return Conversation{}, err
	}
	conversation := s.byID[id]
	if conversation == nil || conversation.Deleted {
		return Conversation{}, ErrNotFound
	}
	return s.clone(conversation), nil
}

// List returns conversations in creation order, optionally limited to one
// current path.
func (s *Store) List(path string) ([]Conversation, uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.catchUp(); err != nil {
		return nil, 0, err
	}
	path = cleanPath(path)
	out := make([]Conversation, 0, len(s.byID))
	for _, conversation := range s.byID {
		if !conversation.Deleted && (path == "" || conversation.Path == path) {
			out = append(out, s.clone(conversation))
		}
	}
	sort.Slice(out, func(i, k int) bool { return s.byID[out[i].ID].Messages[0].Seq < s.byID[out[k].ID].Messages[0].Seq })
	return out, uint64(len(s.events)), nil
}

// Events returns events after seq and a channel closed by the next write.
func (s *Store) Events(after uint64) ([]Event, <-chan struct{}, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.catchUp(); err != nil {
		return nil, nil, err
	}
	if after > uint64(len(s.events)) {
		after = uint64(len(s.events))
	}
	return append([]Event(nil), s.events[after:]...), s.changed, nil
}

// Wait blocks until events after seq exist or ctx ends.
func (s *Store) Wait(ctx context.Context, after uint64) ([]Event, error) {
	for {
		events, changed, err := s.Events(after)
		if err != nil || len(events) > 0 {
			return events, err
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return nil, nil
		}
	}
}

func (s *Store) Cursor(participantID string) (uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	err := s.catchUpCursors()
	return s.cursors[participantID], err
}

// Delivery states of a message an acknowledgment passed over while it was
// hidden, kept under deferKey so later acknowledgments cannot discard it.
const (
	deferred     = 1
	acknowledged = 2
)

func deferKey(participantID string, seq uint64) string {
	return participantID + "\x00" + strconv.FormatUint(seq, 10)
}

// Pending returns the messages addressed to participantID that it has not
// acknowledged, including ones deferred while hidden, except in deleted
// conversations. Callers drop the ones whose code is missing.
func (s *Store) Pending(participantID string) ([]Pending, uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.catchUp(); err != nil {
		return nil, 0, err
	}
	if err := s.catchUpCursors(); err != nil {
		return nil, 0, err
	}
	cursor := s.cursors[participantID]
	pending := make([]Pending, 0)
	s.inbox(participantID, uint64(len(s.events)), func(event Event, conversation *Conversation, state uint64) {
		if !conversation.Deleted && !s.deletedMessages[event.Message.ID] && (state == deferred || (event.Seq > cursor && state == 0)) {
			pending = append(pending, Pending{Conversation: s.clone(conversation), Message: *event.Message})
		}
	})
	return pending, cursor, nil
}

// inbox calls visit for each message up to seq addressed to participantID
// by someone else, with its delivery state. The caller holds s.mu.
func (s *Store) inbox(participantID string, seq uint64, visit func(Event, *Conversation, uint64)) {
	for _, event := range s.events[:min(seq, uint64(len(s.events)))] {
		if event.Message == nil || event.Message.Author.ID == participantID || !slices.Contains(event.Message.To, participantID) {
			continue
		}
		visit(event, s.byID[event.ConversationID], s.cursors[deferKey(participantID, event.Seq)])
	}
}

// WaitPending blocks until keep, applied outside the store lock, leaves
// pending messages for participantID, or ctx ends.
func (s *Store) WaitPending(ctx context.Context, participantID string, keep func([]Pending) []Pending) ([]Pending, uint64, error) {
	for {
		s.mu.Lock()
		changed := s.changed
		s.mu.Unlock()
		pending, cursor, err := s.Pending(participantID)
		if err == nil {
			pending = keep(pending)
		}
		if err != nil || len(pending) > 0 {
			return pending, cursor, err
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return pending, cursor, nil
		}
	}
}

// Ack acknowledges participantID's messages up to seq and advances its
// cursor, which never moves backwards. Messages in deleted conversations or
// in the hidden ones, whose code is missing, are deferred instead: they
// become pending again once they can be shown, and a later Ack covering them
// acknowledges them.
func (s *Store) Ack(participantID string, seq uint64, hidden map[string]bool) (uint64, error) {
	if !participantPattern.MatchString(participantID) {
		return 0, fmt.Errorf("%w: invalid participant", ErrInvalid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.catchUp(); err != nil {
		return 0, err
	}
	if err := s.catchUpCursors(); err != nil {
		return 0, err
	}
	cursor := s.cursors[participantID]
	var err error
	s.inbox(participantID, seq, func(event Event, conversation *Conversation, state uint64) {
		key := deferKey(participantID, event.Seq)
		switch held := conversation.Deleted || s.deletedMessages[event.Message.ID] || hidden[conversation.ID]; {
		case err != nil:
		case held && state == 0 && event.Seq > cursor:
			err = s.write(key, deferred)
		case !held && state == deferred:
			err = s.write(key, acknowledged)
		}
	})
	if err != nil {
		return 0, err
	}
	return s.advance(participantID, seq)
}

// MarkRead records that participantID has seen one conversation up to seq.
// It is separate from the inbox cursor, so reading one conversation leaves
// the others unread.
func (s *Store) MarkRead(participantID, conversationID string, seq uint64) (uint64, error) {
	if !participantPattern.MatchString(participantID) {
		return 0, fmt.Errorf("%w: invalid participant", ErrInvalid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.catchUp(); err != nil {
		return 0, err
	}
	if s.byID[conversationID] == nil {
		return 0, ErrNotFound
	}
	return s.advance(participantID+readSeparator+conversationID, seq)
}

// Read returns how far participantID has read each conversation.
func (s *Store) Read(participantID string) (map[string]uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.catchUpCursors(); err != nil {
		return nil, err
	}
	read := make(map[string]uint64)
	for key, seq := range s.cursors {
		if id, ok := strings.CutPrefix(key, participantID+readSeparator); ok {
			read[id] = seq
		}
	}
	return read, nil
}

func (s *Store) advance(key string, seq uint64) (uint64, error) {
	if _, err := s.catchUp(); err != nil {
		return 0, err
	}
	if err := s.catchUpCursors(); err != nil {
		return 0, err
	}
	seq = min(seq, uint64(len(s.events)))
	if seq <= s.cursors[key] {
		return s.cursors[key], nil
	}
	if err := s.write(key, seq); err != nil {
		return 0, err
	}
	return s.cursors[key], nil
}

// write durably raises the cursor log value of key to value.
func (s *Store) write(key string, value uint64) error {
	line, err := json.Marshal(cursorRecord{Key: key, Seq: value})
	if err != nil {
		return err
	}
	if err := appendLine(s.cursorLog, s.cursorOffset, line); err != nil {
		return err
	}
	return s.catchUpCursors()
}

// clone copies conversation for callers, with its current default
// recipients. The caller holds s.mu.
func (s *Store) clone(conversation *Conversation) Conversation {
	clone := *conversation
	clone.Messages = s.visible(conversation.Messages)
	clone.DefaultTo = s.defaultTo(conversation)
	return clone
}

// recipients validates the participants a message is addressed to: agents
// Gitna issued, other than the author, each once.
func (s *Store) recipients(actor Participant, to []string) ([]string, error) {
	var out []string
	for _, id := range to {
		if _, ok := s.participants[id]; !ok {
			return nil, fmt.Errorf("%w: unknown recipient %q", ErrInvalid, id)
		}
		if id != actor.ID && !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out, nil
}

// defaultTo is who a person's message without recipients goes to in
// conversation, or in a new one when it is nil: the joined agents last
// addressed there, otherwise the joined agent that wrote there last,
// otherwise the only joined agent. With several joined agents and nothing to
// go by, the message stays unassigned.
func (s *Store) defaultTo(conversation *Conversation) []string {
	if conversation != nil {
		messages := s.visible(conversation.Messages)
		for index := len(messages) - 1; index >= 0; index-- {
			var to []string
			for _, id := range messages[index].To {
				if !s.left[id] {
					to = append(to, id)
				}
			}
			if len(to) > 0 {
				return to
			}
		}
		for index := len(messages) - 1; index >= 0; index-- {
			if author := messages[index].Author; author.Kind == KindAgent && s.isAgent(author.ID) {
				return []string{author.ID}
			}
		}
	}
	if agents := s.agents(); len(agents) == 1 {
		return []string{agents[0].ID}
	}
	return nil
}

func (s *Store) isAgent(id string) bool {
	_, ok := s.participants[id]
	return ok && !s.left[id]
}

// agents returns the joined agents that have not left, in join order.
func (s *Store) agents() []Participant {
	var out []Participant
	for _, id := range s.joined {
		if !s.left[id] {
			out = append(out, s.participants[id])
		}
	}
	return out
}

func (p Participant) Validate() error { return validateParticipant(p) }

func validateParticipant(participant Participant) error {
	if !participantPattern.MatchString(participant.ID) || !strings.HasPrefix(participant.ID, participant.Kind+":") ||
		len(participant.Name) > 128 {
		return fmt.Errorf("%w: invalid participant", ErrInvalid)
	}
	return nil
}

// normalizeAnchor fills the defaults older records and terse clients omit.
func normalizeAnchor(anchor Anchor) Anchor {
	anchor.Path = cleanPath(anchor.Path)
	if anchor.Source == "" {
		anchor.Source = SourceWorktree
		if anchor.Side == SideDeletions {
			anchor.Source = SourceIndex
		}
	}
	if anchor.Side == "" {
		anchor.Side = SideAdditions
	}
	if anchor.View == "" {
		anchor.View = map[string]string{SourceWorktree: ViewFile, SourceIndex: ViewIndex, SourceCommit: ViewCommit}[anchor.Source]
	}
	return anchor
}

func validateAnchor(anchor Anchor) error {
	commit := func(value string) bool { return commitPattern.MatchString(value) }
	switch {
	case !validPath(anchor.Path), anchor.StartLine < 1, anchor.EndLine < anchor.StartLine,
		len(anchor.Code) > MaxCodeBytes, len(anchor.Before)+len(anchor.After) > MaxCodeBytes,
		anchor.Side != SideAdditions && anchor.Side != SideDeletions,
		anchor.Source != SourceWorktree && anchor.Source != SourceIndex && anchor.Source != SourceCommit,
		anchor.View != ViewFile && anchor.View != ViewWorktree && anchor.View != ViewIndex &&
			anchor.View != ViewCommit && anchor.View != ViewComparison,
		anchor.Revision != "" && !commit(anchor.Revision),
		anchor.Source == SourceCommit && anchor.Revision == "",
		anchor.Against != "" && !commit(anchor.Against):
		return fmt.Errorf("%w: invalid anchor", ErrInvalid)
	}
	return nil
}

func validateBody(body string) (string, error) {
	body = strings.TrimSpace(body)
	if body == "" || len(body) > MaxBodyBytes || !utf8.ValidString(body) {
		return "", fmt.Errorf("%w: message must be 1-%d bytes of UTF-8 text", ErrInvalid, MaxBodyBytes)
	}
	return body, nil
}

func cleanPath(value string) string {
	if value == "" {
		return ""
	}
	return path.Clean(strings.ReplaceAll(value, "\\", "/"))
}

func validPath(value string) bool {
	return value != "" && value != "." && !path.IsAbs(value) && value != ".." && !strings.HasPrefix(value, "../") &&
		!(len(value) > 1 && value[1] == ':') && len(value) <= 4096
}

func newID(prefix string) string {
	var buf [10]byte
	if _, err := rand.Read(buf[:]); err != nil {
		panic(err)
	}
	return prefix + "_" + hex.EncodeToString(buf[:])
}

// NewID returns a random conversation or message id for clients that need
// idempotent retries.
func NewID(prefix string) string { return newID(prefix) }
