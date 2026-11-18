package conversations

import (
	"errors"
	"testing"
)

func nativeThread(t *testing.T) (*Store, Participant, Conversation) {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	a, err := s.JoinNative("Native", "definition")
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.Create(human, "thread", anchorAt("a", 1, 1, "x"), "question", []string{a.ID})
	if err != nil {
		t.Fatal(err)
	}
	return s, a, c
}

func TestAgentsCannotAddressNativeAgents(t *testing.T) {
	s, n, c := nativeThread(t)
	cli := joinAgent(t, s)
	for _, actor := range []Participant{cli, n} {
		_, before, _ := s.List("")
		if _, err := s.Create(actor, "bad", anchorAt("a", 1, 1, "x"), "no", []string{n.ID}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("create: %v", err)
		}
		if _, err := s.Reply(actor, c.ID, "bad-reply", "no", []string{n.ID}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("reply: %v", err)
		}
		if _, after, _ := s.List(""); after != before {
			t.Fatal("invalid request appended")
		}
		if p, _ := s.Pending(cli.ID); len(p) != 0 {
			t.Fatalf("pending: %+v", p)
		}
	}
	if p, _ := s.Pending(n.ID); len(p) != 1 {
		t.Fatalf("human message: %+v", p)
	}
}

func TestRunCompletesWithItsReply(t *testing.T) {
	s, a, c := nativeThread(t)
	r, err := s.StartRun(a, c.ID, c.Messages[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if r.ID == 0 || r.State != "running" {
		t.Fatalf("run: %+v", r)
	}
	m, err := s.ReplyRun(a, c.ID, r.ID, "answer")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := s.Get(c.ID)
	if len(got.Messages) != 2 || m.Run != r.ID || len(m.To) != 0 || got.Runs[0].State != "completed" {
		t.Fatalf("reply: %+v thread: %+v", m, got)
	}
	events, _, _ := s.Events(r.ID)
	if len(events) != 1 || events[0].Type != EventMessageCreated {
		t.Fatalf("completion not atomic: %+v", events)
	}
}

func TestEndedRunKeepsOutcomeAndDetail(t *testing.T) {
	s, a, c := nativeThread(t)
	r, err := s.StartRun(a, c.ID, c.Messages[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.EndRun(a, c.ID, r.ID, "failed", "broken"); err != nil {
		t.Fatal(err)
	}
	if err := s.EndRun(a, c.ID, r.ID, "cancelled", "changed"); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Get(c.ID)
	if got.Runs[0].State != "failed" || got.Runs[0].Detail != "broken" {
		t.Fatalf("runs: %+v", got.Runs)
	}
}

func TestTerminalRunRejectsSecondReply(t *testing.T) {
	s, a, c := nativeThread(t)
	r, _ := s.StartRun(a, c.ID, c.Messages[0].ID)
	if _, err := s.ReplyRun(a, c.ID, r.ID, "answer"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReplyRun(a, c.ID, r.ID, "again"); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	got, _ := s.Get(c.ID)
	if len(got.Messages) != 2 {
		t.Fatalf("messages: %+v", got.Messages)
	}
}

func TestRunsSurviveReopen(t *testing.T) {
	s, a, c := nativeThread(t)
	r, _ := s.StartRun(a, c.ID, c.Messages[0].ID)
	s.EndRun(a, c.ID, r.ID, "interrupted", "Gitna closed")
	s.Close()
	reopened, err := Open(s.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	got, _ := reopened.Get(c.ID)
	if len(got.Runs) != 1 || got.Runs[0].State != "interrupted" || got.Runs[0].Detail != "Gitna closed" {
		t.Fatalf("runs: %+v", got.Runs)
	}
	agents, _ := reopened.Agents()
	if agents[0].Agent != "definition" {
		t.Fatalf("agents: %+v", agents)
	}
}

func TestRunEventsReachAnotherProcess(t *testing.T) {
	s, a, c := nativeThread(t)
	other, err := Open(s.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	r, err := s.StartRun(a, c.ID, c.Messages[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := other.Get(c.ID)
	if len(got.Runs) != 1 || got.Runs[0].State != "running" {
		t.Fatalf("runs: %+v", got.Runs)
	}
	s.ReplyRun(a, c.ID, r.ID, "done")
	got, _ = other.Get(c.ID)
	if got.Runs[0].State != "completed" || len(got.Messages) != 2 {
		t.Fatalf("thread: %+v", got)
	}
}

func TestRenameUpdatesTheAgentAndItsMessages(t *testing.T) {
	s, a, c := nativeThread(t)
	r, err := s.StartRun(a, c.ID, c.Messages[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReplyRun(a, c.ID, r.ID, "answer"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.JoinNative("Claude", "other"); err != nil {
		t.Fatal(err)
	}
	renamed, err := s.Rename(a.ID, "Claude")
	if err != nil || renamed.Name != "Claude 2" {
		t.Fatalf("rename = %+v, %v", renamed, err)
	}
	_, before, _ := s.List("")
	if again, err := s.Rename(a.ID, "Claude"); err != nil || again.Name != "Claude 2" {
		t.Fatalf("rename again = %+v, %v", again, err)
	}
	if _, after, _ := s.List(""); after != before {
		t.Fatal("renaming to the same name appended an event")
	}
	got, err := s.Get(c.ID)
	if err != nil || got.Messages[1].Author.Name != "Claude 2" {
		t.Fatalf("author = %+v, %v", got.Messages, err)
	}
	if natives, _ := s.Natives(); natives["definition"].Name != "Claude 2" {
		t.Fatalf("natives = %+v", natives)
	}
	if _, err := s.Rename(a.ID, " "); !errors.Is(err, ErrInvalid) {
		t.Fatalf("blank: %v", err)
	}
}
