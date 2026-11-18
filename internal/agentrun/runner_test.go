package agentrun

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/roie/gitna/internal/conversations"
)

type runnerFixture struct {
	t        *testing.T
	root     string
	store    *conversations.Store
	settings *SettingsFile
	repo     Repo
	manager  *Manager
	agents   []conversations.Participant
	enabled  atomic.Bool
	holds    atomic.Int32
}

func newRunnerFixture(t *testing.T, modes ...string) *runnerFixture {
	t.Helper()
	f := &runnerFixture{t: t, root: t.TempDir()}
	f.enabled.Store(true)
	var err error
	f.store, err = conversations.Open(filepath.Join(t.TempDir(), "store"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.store.Close() })
	f.settings, err = Open(filepath.Join(t.TempDir(), "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range modes {
		def := fakeDefinition(t, mode)
		if err := f.settings.Update(func(s *Settings) error { s.Agents = append(s.Agents, def); return nil }); err != nil {
			t.Fatal(err)
		}
		agent, err := f.store.JoinNative(mode, def.ID)
		if err != nil {
			t.Fatal(err)
		}
		f.agents = append(f.agents, agent)
	}
	f.repo = Repo{Root: f.root, Open: func() (*conversations.Store, error) { return f.store, nil }, Locate: func(_ context.Context, c []conversations.Conversation) []conversations.Conversation { return c }, Hold: func(context.Context) (func(), error) { f.holds.Add(1); return func() { f.holds.Add(-1) }, nil }}
	f.manager = f.newManager()
	t.Cleanup(func() {
		if t.Failed() {
			all, seq, err := f.store.List("")
			t.Logf("threads: %+v seq=%d err=%v", all, seq, err)
			f.manager.mu.Lock()
			w := f.manager.repos[f.root]
			if w != nil {
				t.Logf("worker: running=%v owned=%v active=%+v retries=%+v", w.running, w.owned, w.active, w.retries)
			}
			f.manager.mu.Unlock()
		}
	})
	return f
}
func (f *runnerFixture) newManager() *Manager {
	m := NewManager(f.settings, f.enabled.Load)
	f.t.Cleanup(m.Close)
	return m
}
func eventually(t *testing.T, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(25 * time.Second)
	for !fn() {
		if time.Now().After(deadline) {
			t.Fatal("condition never became true")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
func (f *runnerFixture) ready() {
	f.t.Helper()
	f.manager.Ensure(f.repo)
	f.awaitOwned(f.manager)
}
func (f *runnerFixture) awaitOwned(manager *Manager) {
	f.t.Helper()
	eventually(f.t, func() bool {
		manager.mu.Lock()
		defer manager.mu.Unlock()
		w := manager.repos[f.root]
		return w != nil && w.owned
	})
}
func (f *runnerFixture) message(to ...conversations.Participant) conversations.Conversation {
	f.t.Helper()
	ids := []string{}
	for _, a := range to {
		ids = append(ids, a.ID)
	}
	c, err := f.store.Create(conversations.Participant{ID: "human:local", Kind: conversations.KindHuman, Name: "You"}, "", conversations.Anchor{Path: "a.txt", StartLine: 1, EndLine: 1, Code: "x"}, "Question", ids)
	if err != nil {
		f.t.Fatal(err)
	}
	return c
}
func (f *runnerFixture) thread(id string) conversations.Conversation {
	f.t.Helper()
	c, err := f.store.Get(id)
	if err != nil {
		f.t.Fatal(err)
	}
	return c
}
func (f *runnerFixture) terminal(id string, count int) conversations.Conversation {
	f.t.Helper()
	eventually(f.t, func() bool {
		c := f.thread(id)
		if len(c.Runs) != count {
			return false
		}
		for _, r := range c.Runs {
			if r.State == "running" {
				return false
			}
		}
		return true
	})
	return f.thread(id)
}
func (f *runnerFixture) active(id string) Live {
	f.t.Helper()
	var live Live
	eventually(f.t, func() bool {
		all, _ := f.manager.Live(f.root)
		for _, r := range all {
			if r.ConversationID == id {
				live = r
				return true
			}
		}
		return false
	})
	return live
}

func TestAddressedMessageRunsAndIsAcknowledged(t *testing.T) {
	f := newRunnerFixture(t, "reply")
	f.ready()
	c := f.message(f.agents[0])
	got := f.terminal(c.ID, 1)
	if got.Runs[0].State != "completed" || len(got.Messages) != 2 || got.Messages[1].Body != "Hello." {
		t.Fatalf("thread: %+v", got)
	}
	eventually(t, func() bool { p, _ := f.store.Pending(f.agents[0].ID); return len(p) == 0 })
}
func TestTwoRecipientsRunOneAfterTheOther(t *testing.T) {
	f := newRunnerFixture(t, "edit", "edit")
	f.ready()
	c := f.message(f.agents...)
	got := f.terminal(c.ID, 2)
	if len(got.Messages) != 3 || got.Runs[0].ParticipantID != f.agents[0].ID || got.Runs[1].ParticipantID != f.agents[1].ID || got.Runs[0].State != "completed" || got.Runs[1].State != "completed" {
		t.Fatalf("runs: %+v", got)
	}
	data, _ := os.ReadFile(filepath.Join(f.root, "agent.txt"))
	if string(data) != "edit\nedit\n" {
		t.Fatalf("edits: %q", data)
	}
}
func TestUnaddressedMessageStartsNoProcess(t *testing.T) {
	f := newRunnerFixture(t, "edit")
	f.ready()
	c := f.message()
	addressed := f.message(f.agents[0])
	f.terminal(addressed.ID, 1)
	if len(f.thread(c.ID).Runs) != 0 {
		t.Fatal("unaddressed run")
	}
	data, _ := os.ReadFile(filepath.Join(f.root, "agent.txt"))
	if string(data) != "edit\n" {
		t.Fatalf("edits: %q", data)
	}
}
func TestRecoveryInterruptsUnfinishedRunWithoutReplay(t *testing.T) {
	f := newRunnerFixture(t, "exit-after-edit")
	c := f.message(f.agents[0])
	f.store.StartRun(f.agents[0], c.ID, c.Messages[0].ID)
	_, err := Run(t.Context(), f.settings.Get().Agents[0], f.root, "Question", Hooks{})
	if err == nil {
		t.Fatal("expected exit")
	}
	f.ready()
	got := f.terminal(c.ID, 1)
	if got.Runs[0].State != "interrupted" || len(got.Messages) != 1 {
		t.Fatalf("thread: %+v", got)
	}
	data, _ := os.ReadFile(filepath.Join(f.root, "agent.txt"))
	if string(data) != "edit\n" {
		t.Fatalf("replayed: %q", data)
	}
}
func TestRecoveryInterruptsMessagesQueuedBeforeStart(t *testing.T) {
	f := newRunnerFixture(t, "edit")
	c := f.message(f.agents[0])
	f.ready()
	got := f.terminal(c.ID, 1)
	if got.Runs[0].State != "interrupted" || got.Runs[0].Detail != "Gitna closed before this ran" {
		t.Fatalf("run: %+v", got.Runs)
	}
	if _, err := os.Stat(filepath.Join(f.root, "agent.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("agent executed: %v", err)
	}
}
func TestRetryRunsAgainWithANewReply(t *testing.T) {
	f := newRunnerFixture(t, "reply")
	f.ready()
	c := f.message(f.agents[0])
	first := f.terminal(c.ID, 1)
	if err := f.manager.Retry(f.root, c.ID, c.Messages[0].ID, f.agents[0].ID); err != nil {
		t.Fatal(err)
	}
	got := f.terminal(c.ID, 2)
	if len(got.Messages) != 3 || got.Messages[2].ID == first.Messages[1].ID || got.Messages[2].Run == first.Messages[1].Run {
		t.Fatalf("reply: %+v", got)
	}
}
func TestCancelEndsRunAsCancelled(t *testing.T) {
	f := newRunnerFixture(t, "hang")
	f.ready()
	c := f.message(f.agents[0])
	live := f.active(c.ID)
	if err := f.manager.Cancel(f.root, live.RunID); err != nil {
		t.Fatal(err)
	}
	if got := f.terminal(c.ID, 1); got.Runs[0].State != "cancelled" {
		t.Fatalf("runs: %+v", got.Runs)
	}
}

type manualTimer struct {
	mu      sync.Mutex
	stopped bool
	fn      func()
}

func (t *manualTimer) Stop() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	was := !t.stopped
	t.stopped = true
	return was
}
func (t *manualTimer) fire() {
	t.mu.Lock()
	if t.stopped {
		t.mu.Unlock()
		return
	}
	t.stopped = true
	fn := t.fn
	t.mu.Unlock()
	fn()
}

type timedCall struct {
	delay time.Duration
	timer *manualTimer
}
type runClock struct{ calls chan timedCall }

func (c *runClock) after(d time.Duration, fn func()) runTimer {
	timer := &manualTimer{fn: fn}
	c.calls <- timedCall{d, timer}
	return timer
}
func (c *runClock) next(t *testing.T, d time.Duration) *manualTimer {
	t.Helper()
	for {
		select {
		case v := <-c.calls:
			if v.delay == d {
				return v.timer
			}
		case <-time.After(5 * time.Second):
			t.Fatal("missing timer")
		}
	}
}
func TestPermissionTimeoutCancels(t *testing.T) {
	f := newRunnerFixture(t, "permission")
	clock := &runClock{calls: make(chan timedCall, 100)}
	f.manager.after = clock.after
	f.ready()
	c := f.message(f.agents[0])
	clock.next(t, 10*time.Minute).fire()
	got := f.terminal(c.ID, 1)
	if got.Runs[0].State != "cancelled" || !strings.Contains(got.Runs[0].Detail, "10 minutes") {
		t.Fatalf("run: %+v", got.Runs)
	}
}
func TestInactivityCancels(t *testing.T) {
	t.Run("idle", func(t *testing.T) {
		f := newRunnerFixture(t, "hang")
		clock := &runClock{calls: make(chan timedCall, 100)}
		f.manager.after = clock.after
		f.ready()
		c := f.message(f.agents[0])
		clock.next(t, 30*time.Minute).fire()
		got := f.terminal(c.ID, 1)
		if got.Runs[0].State != "cancelled" || got.Runs[0].Detail != "No activity for 30 minutes" {
			t.Fatalf("run: %+v", got.Runs)
		}
	})
	t.Run("permission pauses inactivity", func(t *testing.T) {
		f := newRunnerFixture(t, "permission")
		clock := &runClock{calls: make(chan timedCall, 100)}
		f.manager.after = clock.after
		f.ready()
		c := f.message(f.agents[0])
		idle := clock.next(t, 30*time.Minute)
		clock.next(t, 10*time.Minute)
		idle.fire()
		all, _ := f.manager.Live(f.root)
		if len(all) != 1 || all[0].Permission == nil {
			t.Fatalf("live: %+v", all)
		}
		if err := f.manager.Answer(f.root, all[0].RunID, all[0].Permission.ID, "allow"); err != nil {
			t.Fatal(err)
		}
		if got := f.terminal(c.ID, 1); got.Runs[0].State != "completed" {
			t.Fatalf("run: %+v", got.Runs)
		}
	})
}
func TestEnablingInterruptsOldPendingAndRunsNewMessages(t *testing.T) {
	f := newRunnerFixture(t, "edit")
	f.enabled.Store(false)
	c := f.message(f.agents[0])
	f.manager.Ensure(f.repo)
	f.enabled.Store(true)
	f.manager.Refresh()
	f.ready()
	if got := f.terminal(c.ID, 1); got.Runs[0].State != "interrupted" {
		t.Fatalf("runs: %+v", got.Runs)
	}
	next := f.message(f.agents[0])
	if got := f.terminal(next.ID, 1); got.Runs[0].State != "completed" {
		t.Fatalf("runs: %+v", got.Runs)
	}
	data, _ := os.ReadFile(filepath.Join(f.root, "agent.txt"))
	if string(data) != "edit\n" {
		t.Fatalf("edits: %q", data)
	}
}
func TestDisablingInterruptsQueuedAndLetsTheActiveRunFinish(t *testing.T) {
	f := newRunnerFixture(t, "hang", "reply")
	f.ready()
	c := f.message(f.agents[0])
	live := f.active(c.ID)
	queued := f.message(f.agents[1])
	f.enabled.Store(false)
	f.manager.Refresh()
	if got := f.thread(c.ID); got.Runs[0].State != "running" {
		t.Fatalf("active: %+v", got.Runs)
	}
	got := f.terminal(queued.ID, 1)
	if got.Runs[0].State != "interrupted" || got.Runs[0].Detail != "Conversations was turned off" {
		t.Fatalf("queue: %+v", got.Runs)
	}
	f.manager.Cancel(f.root, live.RunID)
	f.terminal(c.ID, 1)
	f.enabled.Store(true)
	f.manager.Refresh()
	next := f.message(f.agents[1])
	if got := f.terminal(next.ID, 1); got.Runs[0].State != "completed" {
		t.Fatalf("next: %+v", got.Runs)
	}
}
func TestRefreshWithoutChangeDoesNothing(t *testing.T) {
	f := newRunnerFixture(t, "edit")
	f.ready()
	c := f.message(f.agents[0])
	f.terminal(c.ID, 1)
	for range 5 {
		f.manager.Refresh()
		f.manager.Ensure(f.repo)
	}
	next := f.message(f.agents[0])
	f.terminal(next.ID, 1)
	data, _ := os.ReadFile(filepath.Join(f.root, "agent.txt"))
	if string(data) != "edit\nedit\n" {
		t.Fatalf("replayed: %q", data)
	}
}
func TestSecondManagerOnSameStoreRunsNothing(t *testing.T) {
	f := newRunnerFixture(t, "edit")
	f.ready()
	other := f.newManager()
	other.Ensure(f.repo)
	c := f.message(f.agents[0])
	f.terminal(c.ID, 1)
	f.manager.Close()
	other.Refresh()
	f.awaitOwned(other)
	data, _ := os.ReadFile(filepath.Join(f.root, "agent.txt"))
	if string(data) != "edit\n" {
		t.Fatalf("executed twice: %q", data)
	}
	if err := other.Cancel(f.root, 999); !errors.Is(err, conversations.ErrNotFound) {
		t.Fatalf("cancel: %v", err)
	}
}
func TestTakeoverRunsAMessageWrittenAfterTheOwnerClosed(t *testing.T) {
	f := newRunnerFixture(t, "reply")
	f.ready()
	other := f.newManager()
	other.Ensure(f.repo)
	time.Sleep(300 * time.Millisecond)
	f.manager.Close()
	c := f.message(f.agents[0])
	if run := f.terminal(c.ID, 1).Runs[0]; run.State != "completed" {
		t.Fatalf("run %s (%s), want completed", run.State, run.Detail)
	}
}
func TestWorkerReportsWhyItStopped(t *testing.T) {
	f := newRunnerFixture(t, "reply")
	reported := make(chan error, 1)
	f.manager.report = func(root string, err error) {
		if root == f.root {
			reported <- err
		}
	}
	f.ready()
	f.store.Close()
	f.manager.Refresh()
	select {
	case err := <-reported:
		if !errors.Is(err, os.ErrClosed) {
			t.Fatalf("reported %v, want a closed-store error", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("worker stopped without reporting why")
	}
}
func TestRunHoldsTheFolderUntilItEnds(t *testing.T) {
	f := newRunnerFixture(t, "hang")
	f.ready()
	c := f.message(f.agents[0])
	live := f.active(c.ID)
	if f.holds.Load() != 1 {
		t.Fatal("run did not hold folder")
	}
	f.manager.Cancel(f.root, live.RunID)
	f.terminal(c.ID, 1)
	eventually(t, func() bool { return f.holds.Load() == 0 })
}
func TestLiveBeforeEnsureDoesNotCreateAWorker(t *testing.T) {
	f := newRunnerFixture(t, "reply")
	f.manager.Live(f.root)
	f.manager.Refresh()
	f.ready()
	c := f.message(f.agents[0])
	f.terminal(c.ID, 1)
}

func TestCloseInterruptsTheRunAndReleasesTheFolder(t *testing.T) {
	f := newRunnerFixture(t, "hang")
	f.ready()
	c := f.message(f.agents[0])
	f.active(c.ID)
	f.manager.Close()
	got := f.thread(c.ID)
	if got.Runs[0].State != "interrupted" || got.Runs[0].Detail != "Gitna closed" || f.holds.Load() != 0 {
		t.Fatalf("run: %+v holds: %d", got.Runs, f.holds.Load())
	}
	unlock, held, err := f.store.LockRuns()
	if err != nil || !held {
		t.Fatalf("lock: %v %v", held, err)
	}
	unlock()
}

func TestMissingDefinitionEndsAsFailed(t *testing.T) {
	f := newRunnerFixture(t, "reply")
	f.ready()
	f.settings.Update(func(s *Settings) error { s.Agents = nil; return nil })
	c := f.message(f.agents[0])
	got := f.terminal(c.ID, 1)
	if got.Runs[0].State != "failed" || got.Runs[0].Detail != "This agent is no longer configured" {
		t.Fatalf("runs: %+v", got.Runs)
	}
}

func TestDisabledSettingsStartNoWorker(t *testing.T) {
	f := newRunnerFixture(t, "edit")
	f.enabled.Store(false)
	f.manager.Ensure(f.repo)
	unlock, held, err := f.store.LockRuns()
	if err != nil || !held {
		t.Fatalf("lock: %v %v", held, err)
	}
	unlock()
	c := f.message(f.agents[0])
	f.manager.Refresh()
	if len(f.thread(c.ID).Runs) != 0 {
		t.Fatal("disabled run")
	}
	if err := f.manager.Cancel(f.root, 1); !errors.Is(err, ErrNotRunner) {
		t.Fatal(err)
	}
}

func TestTruncateBodyKeepsValidUTF8WithinTheLimit(t *testing.T) {
	short := "short"
	if got := truncateBody(short); got != short {
		t.Fatalf("short = %q", got)
	}
	long := strings.Repeat("a", conversations.MaxBodyBytes-1) + "é"
	got := truncateBody(long)
	if len(got) != conversations.MaxBodyBytes-1 || !utf8.ValidString(got) {
		t.Fatalf("len %d, valid %v", len(got), utf8.ValidString(got))
	}
}
