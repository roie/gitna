package agentrun

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/roie/gitna/internal/conversations"
)

type Repo struct {
	Root   string
	Open   func() (*conversations.Store, error)
	Locate func(context.Context, []conversations.Conversation) []conversations.Conversation
	Hold   func(context.Context) (func(), error)
}
type Live struct {
	RunID          uint64             `json:"runId"`
	ConversationID string             `json:"conversationId"`
	ParticipantID  string             `json:"participantId"`
	Activity       string             `json:"activity"`
	Permission     *PermissionRequest `json:"permission,omitempty"`
}

var ErrNotRunner = errors.New("running in another Gitna window")
var errClosed = errors.New("Gitna closed")

type runTimer interface{ Stop() bool }
type Manager struct {
	mu       sync.Mutex
	settings *SettingsFile
	enabled  func() bool
	repos    map[string]*repoWorker
	ctx      context.Context
	cancel   context.CancelCauseFunc
	wg       sync.WaitGroup
	after    func(time.Duration, func()) runTimer
	report   func(root string, err error)
}
type repoWorker struct {
	repo           Repo
	wake           chan struct{}
	changed        chan struct{}
	running, owned bool
	active         *activeRun
	retries        []job
}
type activeRun struct {
	live    Live
	job     job
	cancel  context.CancelCauseFunc
	answer  chan string
	timer   runTimer
	tick    uint64
	release func()
}
type job struct {
	agent   conversations.Participant
	pending conversations.Pending
}
type runResult struct {
	reply string
	err   error
	cause error
}

func NewManager(settings *SettingsFile, enabled func() bool) *Manager {
	ctx, cancel := context.WithCancelCause(context.Background())
	return &Manager{settings: settings, enabled: enabled, repos: make(map[string]*repoWorker), ctx: ctx, cancel: cancel, after: func(d time.Duration, fn func()) runTimer { return time.AfterFunc(d, fn) }, report: func(root string, err error) {
		fmt.Fprintf(os.Stderr, "gitna: agent runs stopped in %s: %v\n", root, err)
	}}
}
func (m *Manager) Ensure(repo Repo) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ctx.Err() != nil {
		return
	}
	w := m.repos[repo.Root]
	if w == nil {
		w = &repoWorker{repo: repo, wake: make(chan struct{}, 1), changed: make(chan struct{})}
		m.repos[repo.Root] = w
	}
	if w.running || !m.enabled() {
		return
	}
	s, err := repo.Open()
	if err != nil {
		return
	}
	agents, err := s.Agents()
	if err != nil || !slices.ContainsFunc(agents, func(a conversations.Participant) bool { return a.Agent != "" }) {
		return
	}
	_, baseline, err := s.List("")
	if err != nil {
		return
	}
	w.running = true
	m.wg.Go(func() {
		if err := m.work(w, s, baseline); err != nil {
			m.report(repo.Root, err)
		}
	})
}
func (m *Manager) Refresh() {
	m.mu.Lock()
	repos := make([]Repo, 0, len(m.repos))
	for _, w := range m.repos {
		repos = append(repos, w.repo)
		wake(w)
	}
	m.mu.Unlock()
	for _, repo := range repos {
		m.Ensure(repo)
	}
}
func wake(w *repoWorker) {
	select {
	case w.wake <- struct{}{}:
	default:
	}
}
func notify(w *repoWorker) { close(w.changed); w.changed = make(chan struct{}) }
func (m *Manager) Live(root string) ([]Live, <-chan struct{}) {
	m.mu.Lock()
	defer m.mu.Unlock()
	w := m.repos[root]
	if w == nil {
		return []Live{}, m.ctx.Done()
	}
	live := []Live{}
	if w.active != nil {
		r := w.active.live
		if r.Permission != nil {
			p := *r.Permission
			p.Options = slices.Clone(p.Options)
			r.Permission = &p
		}
		live = append(live, r)
	}
	return live, w.changed
}
func (m *Manager) Cancel(root string, runID uint64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	w := m.repos[root]
	if w == nil || !w.owned {
		return ErrNotRunner
	}
	if w.active == nil || w.active.live.RunID != runID {
		return conversations.ErrNotFound
	}
	w.active.cancel(context.Canceled)
	return nil
}
func (m *Manager) Answer(root string, runID uint64, requestID, optionID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	w := m.repos[root]
	if w == nil || !w.owned {
		return ErrNotRunner
	}
	if w.active == nil || w.active.live.RunID != runID || w.active.live.Permission == nil || w.active.live.Permission.ID != requestID {
		return conversations.ErrNotFound
	}
	if !slices.ContainsFunc(w.active.live.Permission.Options, func(o PermissionOption) bool { return o.ID == optionID }) {
		return conversations.ErrInvalid
	}
	select {
	case w.active.answer <- optionID:
		w.active.live.Permission = nil
		notify(w)
		return nil
	default:
		return conversations.ErrNotFound
	}
}
func (m *Manager) Retry(root, conversationID, messageID, participantID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	w := m.repos[root]
	if w == nil || !w.owned {
		return ErrNotRunner
	}
	if !m.enabled() {
		return conversations.ErrInvalid
	}
	s, err := w.repo.Open()
	if err != nil {
		return err
	}
	c, err := s.Get(conversationID)
	if err != nil {
		return err
	}
	agents, err := s.Agents()
	if err != nil {
		return err
	}
	var agent conversations.Participant
	for _, a := range agents {
		if a.ID == participantID && a.Agent != "" {
			agent = a
		}
	}
	if agent.ID == "" {
		return conversations.ErrNotFound
	}
	var message conversations.Message
	for _, v := range c.Messages {
		if v.ID == messageID {
			message = v
		}
	}
	if message.ID == "" || message.Author.Kind != conversations.KindHuman || !slices.Contains(message.To, participantID) {
		return conversations.ErrInvalid
	}
	found := false
	for _, r := range c.Runs {
		if r.ParticipantID == participantID && r.MessageID == messageID {
			if r.State == "running" {
				return conversations.ErrConflict
			}
			found = true
		}
	}
	if !found {
		return conversations.ErrNotFound
	}
	for _, j := range w.retries {
		if j.agent.ID == participantID && j.pending.Message.ID == messageID {
			return conversations.ErrConflict
		}
	}
	w.retries = append(w.retries, job{agent, conversations.Pending{Conversation: c, Message: message}})
	wake(w)
	return nil
}
func (m *Manager) Close() { m.cancel(errClosed); m.wg.Wait() }

func (m *Manager) jobs(w *repoWorker, s *conversations.Store) ([]job, error) {
	agents, err := s.Agents()
	if err != nil {
		return nil, err
	}
	jobs := []job{}
	for _, a := range agents {
		if a.Agent == "" {
			continue
		}
		pending, err := s.Pending(a.ID)
		if err != nil {
			return nil, err
		}
		for _, p := range pending {
			located := []conversations.Conversation{p.Conversation}
			if w.repo.Locate != nil {
				located = w.repo.Locate(m.ctx, located)
			}
			if len(located) == 0 || located[0].Location != nil && located[0].Location.Status == "missing" {
				continue
			}
			p.Conversation = located[0]
			jobs = append(jobs, job{a, p})
		}
	}
	sort.SliceStable(jobs, func(i, j int) bool { return jobs[i].pending.Message.Seq < jobs[j].pending.Message.Seq })
	return jobs, nil
}
func terminalFor(j job) bool {
	for _, r := range j.pending.Conversation.Runs {
		if r.ParticipantID == j.agent.ID && r.MessageID == j.pending.Message.ID {
			return true
		}
	}
	return false
}
func (m *Manager) interrupt(s *conversations.Store, j job, detail string) error {
	run, err := s.StartRun(j.agent, j.pending.Conversation.ID, j.pending.Message.ID)
	if err != nil {
		return err
	}
	if err := s.EndRun(j.agent, j.pending.Conversation.ID, run.ID, "interrupted", detail); err != nil {
		return err
	}
	return s.Ack(j.agent.ID, []uint64{j.pending.Message.Seq})
}
func (m *Manager) recover(s *conversations.Store) error {
	events, _, err := s.Events(0)
	if err != nil {
		return err
	}
	for _, e := range events {
		if e.Type != conversations.EventRunStarted {
			continue
		}
		c, err := s.Get(e.ConversationID)
		if err != nil {
			return err
		}
		for _, r := range c.Runs {
			if r.ID == e.Run && r.State == "running" {
				if err := s.EndRun(e.Actor, c.ID, r.ID, "interrupted", "Gitna closed"); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
func (m *Manager) work(w *repoWorker, s *conversations.Store, baseline uint64) error {
	var unlock func()
	var result <-chan runResult
	defer func() {
		if result != nil {
			m.mu.Lock()
			w.active.cancel(context.Canceled)
			m.mu.Unlock()
			m.finish(w, s, <-result)
		}
		if unlock != nil {
			unlock()
		}
		m.mu.Lock()
		w.running = false
		w.owned = false
		notify(w)
		m.mu.Unlock()
	}()
	for unlock == nil {
		if m.ctx.Err() != nil {
			return nil
		}
		release, held, err := s.LockRuns()
		if err != nil {
			return err
		}
		if held {
			unlock = release
			break
		}
		_, changed, err := s.Events(baseline)
		if err != nil {
			return err
		}
		select {
		case <-m.ctx.Done():
			return nil
		case <-changed:
		case <-w.wake:
		}
	}
	if err := m.recover(s); err != nil {
		return err
	}
	m.mu.Lock()
	w.owned = true
	notify(w)
	m.mu.Unlock()
	for {
		if m.ctx.Err() != nil {
			return nil
		}
		_, seq, err := s.List("")
		if err != nil {
			return err
		}
		_, changed, err := s.Events(seq)
		if err != nil {
			return err
		}
		jobs, err := m.jobs(w, s)
		if err != nil {
			return err
		}
		m.mu.Lock()
		active := w.active
		allowed := m.enabled()
		m.mu.Unlock()
		for _, j := range jobs {
			if active != nil && j.agent.ID == active.job.agent.ID && j.pending.Message.ID == active.job.pending.Message.ID {
				continue
			}
			if terminalFor(j) {
				if err := s.Ack(j.agent.ID, []uint64{j.pending.Message.Seq}); err != nil {
					return err
				}
				continue
			}
			if !allowed || j.pending.Message.Seq <= baseline {
				detail := "Gitna closed before this ran"
				if !allowed {
					detail = "Conversations was turned off"
				}
				if err := m.interrupt(s, j, detail); err != nil {
					return err
				}
				continue
			}
			if active == nil {
				result, err = m.begin(w, s, j)
				if err != nil {
					return err
				}
				m.mu.Lock()
				active = w.active
				m.mu.Unlock()
			}
		}
		m.mu.Lock()
		if w.active == nil && len(w.retries) > 0 {
			j := w.retries[0]
			w.retries = w.retries[1:]
			m.mu.Unlock()
			if allowed {
				result, err = m.begin(w, s, j)
			} else {
				err = m.interrupt(s, j, "Conversations was turned off")
			}
			if err != nil {
				return err
			}
		} else {
			m.mu.Unlock()
		}
		select {
		case <-m.ctx.Done():
		case <-changed:
		case <-w.wake:
		case r := <-result:
			result = nil
			if err := m.finish(w, s, r); err != nil {
				return err
			}
		}
	}
}
func (m *Manager) begin(w *repoWorker, s *conversations.Store, j job) (<-chan runResult, error) {
	release := func() {}
	var err error
	if w.repo.Hold != nil {
		release, err = w.repo.Hold(m.ctx)
		if err != nil {
			return nil, err
		}
	}
	run, err := s.StartRun(j.agent, j.pending.Conversation.ID, j.pending.Message.ID)
	if err != nil {
		release()
		return nil, err
	}
	ctx, cancel := context.WithCancelCause(m.ctx)
	a := &activeRun{job: j, live: Live{RunID: run.ID, ConversationID: j.pending.Conversation.ID, ParticipantID: j.agent.ID, Activity: "Writing a reply"}, cancel: cancel, answer: make(chan string, 1), release: release}
	m.mu.Lock()
	w.active = a
	m.arm(w, a, 30*time.Minute, "No activity for 30 minutes")
	notify(w)
	m.mu.Unlock()
	done := make(chan runResult, 1)
	go func() {
		var def Definition
		for _, d := range m.settings.Get().Agents {
			if d.ID == j.agent.Agent {
				def = d
				break
			}
		}
		if def.ID == "" {
			done <- runResult{err: errors.New("This agent is no longer configured")}
			return
		}
		reply, err := Run(ctx, def, w.repo.Root, BuildPrompt(j.pending.Conversation, j.pending.Message, j.agent, w.repo.Root), Hooks{
			Activity: func(title string) {
				m.mu.Lock()
				defer m.mu.Unlock()
				if w.active != a {
					return
				}
				if title == "" {
					title = "Writing a reply"
				}
				a.live.Activity = title
				if a.live.Permission == nil {
					m.arm(w, a, 30*time.Minute, "No activity for 30 minutes")
				}
				notify(w)
			},
			Permission: func(requestCtx context.Context, p PermissionRequest) (string, bool) {
				m.mu.Lock()
				if w.active != a {
					m.mu.Unlock()
					return "", false
				}
				a.live.Permission = &p
				m.arm(w, a, 10*time.Minute, "No permission answer for 10 minutes")
				notify(w)
				m.mu.Unlock()
				var id string
				var ok bool
				select {
				case id = <-a.answer:
					ok = true
				case <-ctx.Done():
				case <-requestCtx.Done():
				}
				m.mu.Lock()
				if w.active == a {
					a.live.Permission = nil
					m.arm(w, a, 30*time.Minute, "No activity for 30 minutes")
					notify(w)
				}
				m.mu.Unlock()
				return id, ok
			},
		})
		done <- runResult{reply, err, context.Cause(ctx)}
	}()
	return done, nil
}
func (m *Manager) arm(w *repoWorker, a *activeRun, delay time.Duration, detail string) {
	if a.timer != nil {
		a.timer.Stop()
	}
	a.tick++
	tick := a.tick
	a.timer = m.after(delay, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if w.active == a && a.tick == tick {
			a.cancel(errors.New(detail))
		}
	})
}
func (m *Manager) finish(w *repoWorker, s *conversations.Store, r runResult) error {
	m.mu.Lock()
	a := w.active
	if a.timer != nil {
		a.timer.Stop()
	}
	a.tick++
	m.mu.Unlock()
	defer a.release()
	defer a.cancel(context.Canceled)
	c := a.job.pending.Conversation.ID
	var err error
	if m.ctx.Err() != nil {
		err = s.EndRun(a.job.agent, c, a.live.RunID, "interrupted", "Gitna closed")
	} else if r.cause != nil {
		err = s.EndRun(a.job.agent, c, a.live.RunID, "cancelled", r.cause.Error())
	} else if r.err != nil {
		state := "failed"
		if errors.Is(r.err, context.Canceled) {
			state = "cancelled"
		}
		err = s.EndRun(a.job.agent, c, a.live.RunID, state, r.err.Error())
	} else {
		reply := strings.TrimSpace(r.reply)
		if len(reply) > conversations.MaxBodyBytes {
			reply = reply[:conversations.MaxBodyBytes]
			for !utf8.ValidString(reply) {
				reply = reply[:len(reply)-1]
			}
		}
		_, err = s.ReplyRun(a.job.agent, c, a.live.RunID, reply)
	}
	if err == nil {
		err = s.Ack(a.job.agent.ID, []uint64{a.job.pending.Message.Seq})
	}
	m.mu.Lock()
	w.active = nil
	notify(w)
	m.mu.Unlock()
	return err
}
