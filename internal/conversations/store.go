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

	"github.com/fsnotify/fsnotify"
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
	worktree  string
	closed    bool
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
	// cursors merges read markers and per-message acknowledgements.
	cursors      map[string]uint64
	cursorLog    *os.File
	cursorOffset int64
	changed      chan struct{}
	watcher      *fsnotify.Watcher
	watchDone    chan struct{}
	now          func() time.Time
}

func Open(dir string) (*Store, error) {
	s := &Store{
		dir:             dir,
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
		s.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) attach(create bool) error {
	if s.closed {
		return os.ErrClosed
	}
	if s.log != nil {
		return nil
	}
	flags := os.O_RDWR | os.O_APPEND
	if create {
		if err := os.MkdirAll(s.dir, 0o700); err != nil {
			return err
		}
		if s.worktree != "" {
			if err := os.WriteFile(filepath.Join(s.dir, "worktree"), []byte(s.worktree+"\n"), 0o600); err != nil {
				return err
			}
		}
		flags |= os.O_CREATE
	}
	file, err := os.OpenFile(filepath.Join(s.dir, logName), flags, 0o600)
	if !create && errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		file.Close()
		return err
	}
	if err := watcher.Add(s.dir); err != nil {
		watcher.Close()
		file.Close()
		return err
	}
	s.log = file
	s.watcher = watcher
	s.watchDone = make(chan struct{})
	go s.watch()
	return nil
}

func (s *Store) openCursors(create bool) error {
	if err := s.attach(false); err != nil {
		return err
	}
	if s.cursorLog != nil || s.log == nil {
		return nil
	}
	flags := os.O_RDWR | os.O_APPEND
	if create {
		flags |= os.O_CREATE
	}
	file, err := os.OpenFile(filepath.Join(s.dir, cursorsName), flags, 0o600)
	if !create && errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	s.cursorLog = file
	return nil
}

func (s *Store) ensureCreated() error {
	if err := s.attach(true); err != nil {
		return err
	}
	return s.openCursors(true)
}

func (s *Store) watch() {
	defer close(s.watchDone)
	for {
		select {
		case event, ok := <-s.watcher.Events:
			if !ok {
				return
			}
			if filepath.Base(event.Name) == logName && event.Has(fsnotify.Write) {
				s.Touch()
			}
		case _, ok := <-s.watcher.Errors:
			if !ok {
				return
			}
			s.Touch()
		}
	}
}

func (s *Store) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	watcher, done := s.watcher, s.watchDone
	var err error
	if s.log != nil {
		err = s.log.Close()
	}
	if s.cursorLog != nil {
		err = errors.Join(err, s.cursorLog.Close())
	}
	s.mu.Unlock()
	if watcher != nil {
		err = errors.Join(err, watcher.Close())
		<-done
	}
	return err
}

type cursorRecord struct {
	Key string `json:"k"`
	Seq uint64 `json:"s"`
}

// catchUpCursors merges cursor lines written since the last read, including
// lines appended by another process.
func (s *Store) catchUpCursors() error {
	if err := s.openCursors(false); err != nil {
		return err
	}
	if s.cursorLog == nil {
		return nil
	}
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
		var last [1]byte
		if _, err := file.ReadAt(last[:], info.Size()-1); err != nil {
			return err
		}
		if last[0] != '\n' {
			line = append([]byte{'\n'}, line...)
		}
	}
	if _, err := file.Write(append(line, '\n')); err != nil {
		return err
	}
	return file.Sync()
}

// catchUp applies complete log lines written since the last read, including
// lines appended by another process. It returns the newly applied events.
func (s *Store) catchUp() (map[string]Event, error) {
	if err := s.attach(false); err != nil {
		return nil, err
	}
	if s.log == nil {
		return nil, nil
	}
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
	case EventParticipantJoined, EventParticipantLeft, EventParticipantRenamed:
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
		case event.Type == EventParticipantRenamed:
			if !exists || validateParticipant(event.Actor) != nil {
				return Event{}, false
			}
			s.rename(event.Actor)
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
		if event.Message.Run != 0 {
			run := findRun(conversation, event.Actor.ID, event.Message.Run)
			if run == nil || run.State != "running" {
				return Event{}, false
			}
			run.State = "completed"
		}
	case EventRunStarted:
		if conversation == nil || s.messageAt[event.MessageID] != conversation.ID {
			return Event{}, false
		}
		event.Run = uint64(len(s.events) + 1)
		conversation.Runs = append(conversation.Runs, Run{ID: event.Run, ParticipantID: event.Actor.ID, MessageID: event.MessageID, State: "running", StartedAt: event.At})
	case EventRunEnded:
		if conversation == nil {
			return Event{}, false
		}
		run := findRun(conversation, event.Actor.ID, event.Run)
		if run == nil || run.State != "running" {
			return Event{}, false
		}
		run.State, run.Detail = event.Outcome, event.Detail
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
	if err := s.ensureCreated(); err != nil {
		return Event{}, err
	}
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

// Reply adds a message addressed to the participants in to. A person's
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

func findRun(conversation *Conversation, participantID string, id uint64) *Run {
	for i := range conversation.Runs {
		run := &conversation.Runs[i]
		if run.ID == id && run.ParticipantID == participantID {
			return run
		}
	}
	return nil
}

func (s *Store) StartRun(agent Participant, conversationID, messageID string) (Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.catchUp(); err != nil {
		return Run{}, err
	}
	participant, ok := s.participants[agent.ID]
	if !ok || participant.Agent == "" {
		return Run{}, fmt.Errorf("%w: not a native agent", ErrInvalid)
	}
	conversation := s.byID[conversationID]
	if conversation == nil || s.messageAt[messageID] != conversationID {
		return Run{}, ErrNotFound
	}
	message := conversation.Messages[slices.IndexFunc(conversation.Messages, func(m Message) bool { return m.ID == messageID })]
	if message.Author.Kind != KindHuman || !slices.Contains(message.To, agent.ID) {
		return Run{}, fmt.Errorf("%w: run needs an addressed human message", ErrInvalid)
	}
	event, err := s.append(Event{Type: EventRunStarted, ConversationID: conversationID, MessageID: messageID, Actor: participant})
	if err != nil {
		return Run{}, err
	}
	return *findRun(conversation, agent.ID, event.Seq), nil
}

func (s *Store) EndRun(agent Participant, conversationID string, runID uint64, outcome, detail string) error {
	switch outcome {
	case "failed", "cancelled", "interrupted":
	default:
		return fmt.Errorf("%w: invalid run outcome", ErrInvalid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.catchUp(); err != nil {
		return err
	}
	conversation := s.byID[conversationID]
	if conversation == nil {
		return ErrNotFound
	}
	run := findRun(conversation, agent.ID, runID)
	if run == nil {
		return ErrNotFound
	}
	if run.State != "running" {
		return nil
	}
	_, err := s.append(Event{Type: EventRunEnded, ConversationID: conversationID, Actor: agent, Run: runID, Outcome: outcome, Detail: detail})
	return err
}

func (s *Store) ReplyRun(agent Participant, conversationID string, runID uint64, body string) (Message, error) {
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
	if conversation == nil {
		return Message{}, ErrNotFound
	}
	run := findRun(conversation, agent.ID, runID)
	if run == nil {
		return Message{}, ErrNotFound
	}
	if run.State != "running" {
		return Message{}, ErrConflict
	}
	message := Message{ID: newID("m"), Author: s.participants[agent.ID], Body: body, Run: runID, CreatedAt: s.now().UTC()}
	event, err := s.append(Event{Type: EventMessageCreated, ConversationID: conversationID, Actor: message.Author, Message: &message})
	if err != nil {
		return Message{}, err
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
// Its id owns an inbox; the agent passes it again to reconnect.
func (s *Store) Join(name string) (Participant, error) {
	return s.join(name, "")
}

func (s *Store) JoinNative(name, definitionID string) (Participant, error) {
	if definitionID == "" {
		return Participant{}, fmt.Errorf("%w: missing definition", ErrInvalid)
	}
	return s.join(name, definitionID)
}

func (s *Store) join(name, definitionID string) (Participant, error) {
	participant := Participant{ID: "agent:" + newID("p"), Kind: KindAgent, Name: cmp.Or(strings.TrimSpace(name), DefaultAgentName), Agent: definitionID}
	if validateParticipant(participant) != nil {
		return Participant{}, fmt.Errorf("%w: a name must be at most 128 bytes", ErrInvalid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.catchUp(); err != nil {
		return Participant{}, err
	}
	name = participant.Name
	for suffix := 2; slices.ContainsFunc(s.agents(), func(p Participant) bool { return strings.EqualFold(p.Name, participant.Name) }); suffix++ {
		participant.Name = fmt.Sprintf("%s %d", name, suffix)
	}
	if err := validateParticipant(participant); err != nil {
		return Participant{}, err
	}
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

// Rename shows the agent participant id as name from now on, in its past
// messages too. A name another agent uses gets a numeric suffix, and a rename
// that changes nothing writes nothing.
func (s *Store) Rename(id, name string) (Participant, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.catchUp(); err != nil {
		return Participant{}, err
	}
	participant, ok := s.participants[id]
	if !ok {
		return Participant{}, fmt.Errorf("%w: unknown participant %q", ErrNotFound, id)
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return Participant{}, fmt.Errorf("%w: a name must not be empty", ErrInvalid)
	}
	taken := func(candidate string) bool {
		return slices.ContainsFunc(s.agents(), func(p Participant) bool { return p.ID != id && strings.EqualFold(p.Name, candidate) })
	}
	renamed := participant
	renamed.Name = name
	for suffix := 2; taken(renamed.Name); suffix++ {
		renamed.Name = fmt.Sprintf("%s %d", name, suffix)
	}
	if err := validateParticipant(renamed); err != nil {
		return Participant{}, fmt.Errorf("%w: a name must be at most 128 bytes", ErrInvalid)
	}
	if renamed.Name == participant.Name {
		return participant, nil
	}
	if _, err := s.append(Event{Type: EventParticipantRenamed, Actor: renamed}); err != nil {
		return Participant{}, err
	}
	return renamed, nil
}

func (s *Store) rename(p Participant) {
	current := s.participants[p.ID]
	current.Name = p.Name
	s.participants[p.ID] = current
	for _, conversation := range s.byID {
		for i := range conversation.Messages {
			if conversation.Messages[i].Author.ID == p.ID {
				conversation.Messages[i].Author.Name = p.Name
			}
		}
	}
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
// its history and can still use its id. Leaving twice is harmless.
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

// Native is the participant that represents an agent definition in this
// store, and whether it has left.
type Native struct {
	Participant
	Left bool
}

// Natives returns, per agent definition, the native participant that
// represents it here. A joined participant wins over one that left.
func (s *Store) Natives() (map[string]Native, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.catchUp(); err != nil {
		return nil, err
	}
	natives := make(map[string]Native)
	for _, id := range s.joined {
		p := s.participants[id]
		if p.Agent == "" {
			continue
		}
		if current, ok := natives[p.Agent]; !ok || current.Left {
			natives[p.Agent] = Native{Participant: p, Left: s.left[id]}
		}
	}
	return natives, nil
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

func ackKey(participantID string, seq uint64) string {
	return participantID + "\x00" + strconv.FormatUint(seq, 10)
}

// Pending returns unacknowledged messages addressed to participantID.
func (s *Store) Pending(participantID string) ([]Pending, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.catchUp(); err != nil {
		return nil, err
	}
	if err := s.catchUpCursors(); err != nil {
		return nil, err
	}
	pending := make([]Pending, 0)
	for _, event := range s.events {
		if event.Message == nil || event.Message.Author.ID == participantID || !slices.Contains(event.Message.To, participantID) {
			continue
		}
		conversation := s.byID[event.ConversationID]
		if !conversation.Deleted && !s.deletedMessages[event.Message.ID] && s.cursors[ackKey(participantID, event.Seq)] == 0 {
			pending = append(pending, Pending{Conversation: s.clone(conversation), Message: *event.Message})
		}
	}
	return pending, nil
}

// WaitPending waits for visible pending messages or cancellation.
func (s *Store) WaitPending(ctx context.Context, participantID string, keep func([]Pending) []Pending) ([]Pending, error) {
	for {
		s.mu.Lock()
		changed := s.changed
		s.mu.Unlock()
		pending, err := s.Pending(participantID)
		if err == nil {
			pending = keep(pending)
		}
		if err != nil || len(pending) > 0 {
			return pending, err
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return pending, nil
		}
	}
}

// Ack acknowledges only the listed messages addressed to participantID.
func (s *Store) Ack(participantID string, seqs []uint64) error {
	if !participantPattern.MatchString(participantID) {
		return fmt.Errorf("%w: invalid participant", ErrInvalid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.catchUp(); err != nil {
		return err
	}
	if err := s.catchUpCursors(); err != nil {
		return err
	}
	for _, seq := range seqs {
		if seq == 0 || seq > uint64(len(s.events)) {
			continue
		}
		message := s.events[seq-1].Message
		if message == nil || message.Author.ID == participantID || !slices.Contains(message.To, participantID) {
			continue
		}
		key := ackKey(participantID, seq)
		if s.cursors[key] == 0 {
			if err := s.write(key, 1); err != nil {
				return err
			}
		}
	}
	return nil
}

// MarkRead records that participantID has seen one conversation up to seq.
// Reading one conversation leaves the others unread.
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
	if err := s.ensureCreated(); err != nil {
		return err
	}
	line, err := json.Marshal(cursorRecord{Key: key, Seq: value})
	if err != nil {
		return err
	}
	if err := appendLine(s.cursorLog, s.cursorOffset, line); err != nil {
		return err
	}
	return s.catchUpCursors()
}

// clone copies conversation for callers. The caller holds s.mu.
func (s *Store) clone(conversation *Conversation) Conversation {
	clone := *conversation
	clone.Messages = s.visible(conversation.Messages)
	clone.Runs = slices.Clone(conversation.Runs)
	return clone
}

// recipients validates the participants a message is addressed to: agents
// Gitna issued, other than the author, each once.
func (s *Store) recipients(actor Participant, to []string) ([]string, error) {
	var out []string
	for _, id := range to {
		if id == RecipientAll {
			if actor.Kind != KindHuman {
				return nil, fmt.Errorf("%w: only people may address all agents", ErrInvalid)
			}
			for _, agent := range s.agents() {
				if !slices.Contains(out, agent.ID) {
					out = append(out, agent.ID)
				}
			}
			continue
		}
		if actor.Kind == KindAgent && s.participants[id].Agent != "" {
			return nil, fmt.Errorf("%w: native agents answer only people", ErrInvalid)
		}
		if _, ok := s.participants[id]; !ok {
			return nil, fmt.Errorf("%w: unknown recipient %q", ErrInvalid, id)
		}
		if id != actor.ID && !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out, nil
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
