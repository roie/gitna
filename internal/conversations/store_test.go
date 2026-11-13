package conversations

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

var (
	human = Participant{ID: "human:local", Kind: KindHuman, Name: "Ada"}
	agent = Participant{ID: "agent:helper", Kind: KindAgent, Name: "helper"}
)

func anchorAt(path string, start, end int, code string) Anchor {
	return Anchor{Path: path, Side: SideAdditions, StartLine: start, EndLine: end, Code: code}
}

func TestExchangePersistsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	agent := joinAgent(t, store)
	conversation, err := store.Create(human, "c1", anchorAt("main.go", 3, 4, "a\nb"), "Why this?\nSecond line", nil)
	if err != nil {
		t.Fatal(err)
	}
	pending, cursor, err := store.Pending(agent.ID)
	if err != nil || len(pending) != 1 || cursor != 0 || pending[0].Message.Body != "Why this?\nSecond line" {
		t.Fatalf("pending = %+v, %d, %v", pending, cursor, err)
	}
	if _, err := store.Ack(agent.ID, pending[0].Message.Seq, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Reply(agent, conversation.ID, "m1", "Because.", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Reply(human, conversation.ID, "m2", "Change it.", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetStatus(human, conversation.ID, StatusResolved); err != nil {
		t.Fatal(err)
	}
	store.Close()

	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	got, err := reopened.Get("c1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Messages) != 3 || got.Status != StatusResolved || got.Messages[1].Author != agent {
		t.Fatalf("reopened conversation = %+v", got)
	}
	pending, cursor, _ = reopened.Pending(agent.ID)
	if cursor != 2 || len(pending) != 1 || pending[0].Message.ID != "m2" {
		t.Fatalf("pending after reopen = %+v cursor %d", pending, cursor)
	}
}

func TestWritesAreIdempotent(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	anchor := anchorAt("a.txt", 1, 1, "x")
	for range 2 {
		if _, err := store.Create(human, "c1", anchor, "hello", nil); err != nil {
			t.Fatal(err)
		}
		if _, err := store.Reply(agent, "c1", "m1", "hi", nil); err != nil {
			t.Fatal(err)
		}
		if _, err := store.SetStatus(agent, "c1", StatusResolved); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.Create(human, "c1", anchor, "different", nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("conflicting create error = %v", err)
	}
	if _, err := store.Reply(agent, "c1", "m1", "different", nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("conflicting reply error = %v", err)
	}
	events, _, _ := store.Events(0)
	if len(events) != 3 {
		t.Fatalf("events = %d, want 3", len(events))
	}
}

func TestReadingOneConversationLeavesOthersUnread(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	agent := joinAgent(t, store)
	first, _ := store.Create(human, "c1", anchorAt("a", 1, 1, "x"), "one", nil)
	second, _ := store.Create(human, "c2", anchorAt("a", 1, 1, "x"), "two", nil)
	if _, err := store.MarkRead(agent.ID, second.ID, second.Seq); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MarkRead(agent.ID, "missing", 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown conversation error = %v", err)
	}
	store.Close()
	if store, err = Open(dir); err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if read, _ := store.Read(agent.ID); len(read) != 1 || read[second.ID] != second.Seq || read[first.ID] != 0 {
		t.Fatalf("read = %+v", read)
	}
	if pending, _, _ := store.Pending(agent.ID); len(pending) != 2 {
		t.Fatalf("reading must not acknowledge the inbox: %+v", pending)
	}
}

func TestValidationRejectsUnsafeInput(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	for _, anchor := range []Anchor{
		anchorAt("../x", 1, 1, ""),
		anchorAt("/etc/passwd", 1, 1, ""),
		anchorAt("C:/x", 1, 1, ""),
		anchorAt("a", 2, 1, ""),
	} {
		if _, err := store.Create(human, "", anchor, "x", nil); !errors.Is(err, ErrInvalid) {
			t.Fatalf("anchor %+v error = %v", anchor, err)
		}
	}
	if _, err := store.Create(Participant{ID: "agent:x", Kind: KindHuman}, "", anchorAt("a", 1, 1, ""), "x", nil); !errors.Is(err, ErrInvalid) {
		t.Fatalf("mismatched participant error = %v", err)
	}
	if _, err := store.Create(human, "", anchorAt("a", 1, 1, ""), "   ", nil); !errors.Is(err, ErrInvalid) {
		t.Fatalf("empty body error = %v", err)
	}
}

func TestWaitPendingWakesOnReply(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	agent := joinAgent(t, store)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan []Pending)
	go func() {
		pending, _, _ := store.WaitPending(ctx, agent.ID, all)
		done <- pending
	}()
	time.Sleep(20 * time.Millisecond)
	if _, err := store.Create(human, "c1", anchorAt("a", 1, 1, "x"), "ping", nil); err != nil {
		t.Fatal(err)
	}
	if pending := <-done; len(pending) != 1 || pending[0].Message.Body != "ping" {
		t.Fatalf("pending = %+v", pending)
	}
	// Own messages never count as pending.
	short, stop := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer stop()
	if pending, _, _ := store.WaitPending(short, human.ID, all); len(pending) != 0 {
		t.Fatalf("own pending = %+v", pending)
	}
}

func TestIndependentWritersShareOneOrderedLog(t *testing.T) {
	dir := t.TempDir()
	first, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if _, err := first.Create(human, "c1", anchorAt("a", 1, 1, "x"), "start", nil); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for index := range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			store := first
			if index%2 == 1 {
				store = second
			}
			if _, err := store.Reply(agent, "c1", NewID("m"), "reply", nil); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	a, _ := first.Get("c1")
	b, _ := second.Get("c1")
	if len(a.Messages) != 21 || len(b.Messages) != 21 {
		t.Fatalf("messages = %d / %d", len(a.Messages), len(b.Messages))
	}
	for index := range a.Messages {
		if !reflect.DeepEqual(a.Messages[index], b.Messages[index]) {
			t.Fatalf("writers disagree at %d: %+v vs %+v", index, a.Messages[index], b.Messages[index])
		}
	}
}

func TestTornTrailingLineIsIgnored(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Create(human, "c1", anchorAt("a", 1, 1, "x"), "start", nil); err != nil {
		t.Fatal(err)
	}
	store.Close()
	file, _ := os.OpenFile(filepath.Join(dir, logName), os.O_APPEND|os.O_WRONLY, 0)
	file.WriteString(`{"id":"e_torn","type":"message.cre`)
	file.Close()

	store, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Reply(agent, "c1", "m1", "after crash", nil); err != nil {
		t.Fatal(err)
	}
	store.Close()
	store, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	got, _ := store.Get("c1")
	if len(got.Messages) != 2 || got.Messages[1].Body != "after crash" {
		t.Fatalf("messages = %+v", got.Messages)
	}
}

func TestLocateFollowsOnlyConfirmedCode(t *testing.T) {
	anchor := anchorAt("f.go", 3, 4, "b\nc")
	anchor.Before, anchor.After = "h\na", "d\ne"
	cases := []struct {
		name, content string
		want          Location
	}{
		{"unchanged", "h\na\nb\nc\nd\ne\n", Location{"f.go", 3, 4, LocationCurrent, "", ""}},
		{"crlf", "h\r\na\r\nb\r\nc\r\nd\r\ne\r\n", Location{"f.go", 3, 4, LocationCurrent, "", ""}},
		{"lines inserted above", "new\nh\nnew\na\nb\nc\nd\ne\n", Location{"f.go", 5, 6, LocationMoved, "", ""}},
		{"neighbours edited in place", "h\nA\nb\nc\nD\ne\n", Location{"f.go", 3, 4, LocationCurrent, "", ""}},
		{"code edited", "h\na\nB\nc\nd\ne\n", Location{"f.go", 3, 4, LocationOutdated, "", ""}},
		{"code deleted, file shorter", "h\n", Location{"f.go", 1, 1, LocationMissing, "", ""}},
		{"unrelated file at the same path", "x\ny\nz\nw\n", Location{"f.go", 3, 4, LocationMissing, "", ""}},
		{"only context left", "h\na\nB\nC\n", Location{"f.go", 3, 4, LocationOutdated, "", ""}},
		{"moved among strangers", "x\nb\nc\ny\nh\na\nd\ne\n", Location{"f.go", 3, 4, LocationOutdated, "", ""}},
		{"deleted, look-alike lands on the same lines", "x\ny\nb\nc\nz\nb\nc\n", Location{"f.go", 3, 4, LocationOutdated, "", ""}},
		{"duplicate with the real context wins", "b\nc\nx\nh\na\nb\nc\nd\ne\n", Location{"f.go", 6, 7, LocationMoved, "", ""}},
		{"two confirmed copies", "h\na\nb\nc\nq\nq\nh\na\nb\nc\n", Location{"f.go", 3, 4, LocationCurrent, "", ""}},
		{"two confirmed copies elsewhere", "q\nq\nq\nq\nh\na\nb\nc\nq\nh\na\nb\nc\n", Location{"f.go", 3, 4, LocationOutdated, "", ""}},
	}
	for _, tc := range cases {
		if got := Locate(anchor, "f.go", []byte(tc.content)); got != tc.want {
			t.Errorf("%s: Locate(%q) = %+v, want %+v", tc.name, tc.content, got, tc.want)
		}
	}
	whole := anchorAt("f", 1, 2, "a\n")
	if got := Locate(whole, "f", []byte("x\na\n\ny\n")); got != (Location{"f", 2, 3, LocationMoved, "", ""}) {
		t.Errorf("anchor without context = %+v", got)
	}
}

func TestCaptureRecordsCodeAndContext(t *testing.T) {
	anchor := Anchor{Path: "f", StartLine: 2, EndLine: 3}
	if err := Capture(&anchor, []byte("1\n2\n3\n4\n5\n6\n7\n8\n")); err != nil {
		t.Fatal(err)
	}
	if anchor.Code != "2\n3" || anchor.Before != "1" || anchor.After != "4\n5\n6" {
		t.Fatalf("anchor = %+v", anchor)
	}
	if err := Capture(&Anchor{Path: "f", StartLine: 9, EndLine: 9}, []byte("1\n")); !errors.Is(err, ErrInvalid) {
		t.Fatalf("out of range error = %v", err)
	}
}

func TestLocateByContentSource(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	commit := "0123456789012345678901234567890123456789"
	for id, anchor := range map[string]Anchor{
		"commit":  {Path: "f", Source: SourceCommit, Revision: commit, View: ViewComparison, Against: commit, Side: SideDeletions, StartLine: 9, EndLine: 9, Code: "gone"},
		"index":   {Path: "f", Source: SourceIndex, StartLine: 1, EndLine: 1, Code: "staged"},
		"work":    {Path: "f", StartLine: 1, EndLine: 1, Code: "staged"},
		"missing": {Path: "nope", Source: SourceIndex, StartLine: 1, EndLine: 1, Code: "x"},
	} {
		if _, err := store.Create(human, id, anchor, "note", nil); err != nil {
			t.Fatalf("%s: %v", id, err)
		}
	}
	content := func(_ context.Context, source, _, path string) ([]byte, error) {
		if path != "f" {
			return nil, os.ErrNotExist
		}
		return []byte(map[string]string{SourceIndex: "first\nstaged\n", SourceWorktree: "edited\n"}[source]), nil
	}
	list, _, _ := store.List("")
	got := map[string]Location{}
	for _, conversation := range store.Locate(context.Background(), list, Sources{Content: content}, "") {
		got[conversation.ID] = *conversation.Location
	}
	want := map[string]Location{
		"commit":  {"f", 9, 9, LocationCurrent, "", ""},
		"index":   {"f", 2, 2, LocationMoved, "", ""},
		"work":    {"f", 2, 2, LocationMoved, SourceIndex, ""},
		"missing": {"nope", 1, 1, LocationMissing, "", ""},
	}
	for id, location := range want {
		if got[id] != location {
			t.Errorf("%s = %+v, want %+v", id, got[id], location)
		}
	}
	bad := Anchor{Path: "f", Source: SourceCommit, Revision: "HEAD", StartLine: 1, EndLine: 1}
	if _, err := store.Create(human, "", bad, "x", nil); !errors.Is(err, ErrInvalid) {
		t.Fatalf("symbolic commit revision error = %v", err)
	}
}

func TestStoreLocateFollowsGitRename(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git unavailable")
	}
	root := t.TempDir()
	git := func(args ...string) []byte {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", root, "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return out
	}
	git("init", "-q")
	os.WriteFile(filepath.Join(root, "old.go"), []byte("package x\n\nfunc A() {}\n"), 0o644)
	git("add", ".")
	git("commit", "-qm", "init")
	git("mv", "old.go", "new.go")
	os.WriteFile(filepath.Join(root, "new.go"), []byte("package x\n\n// moved\nfunc A() {}\n"), 0o644)

	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.Create(human, "c1", anchorAt("old.go", 3, 3, "func A() {}"), "rename me", nil); err != nil {
		t.Fatal(err)
	}
	renames := func(ctx context.Context, _, revision string) (map[string]string, error) {
		return ParseRenames(git("diff", "-M", "--name-status", "-z", revision, "--")), nil
	}
	list, _, _ := store.List("")
	list = store.Locate(context.Background(), list, Sources{Content: WorktreeContent(root), Renames: renames}, "new.go")
	if got := *list[0].Location; got != (Location{"new.go", 4, 4, LocationMoved, "", ""}) {
		t.Fatalf("location = %+v", got)
	}
	if moved, _, _ := store.List("new.go"); len(moved) != 1 || moved[0].Anchor.Path != "old.go" {
		t.Fatalf("relocation not persisted: %+v", moved)
	}
}

func TestDeleteHidesAndRestoreReturnsHistory(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	agent := joinAgent(t, store)
	if _, err := store.Create(human, "c0", anchorAt("main.go", 1, 1, "a"), "Handled", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Ack(agent.ID, 2, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Reply(human, "c0", "m0", "Also handled", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Create(human, "c1", anchorAt("main.go", 1, 1, "a"), "Remove me", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Ack(agent.ID, 3, nil); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"c0", "c1"} {
		if _, err := store.SetDeleted(human, id, true); err != nil {
			t.Fatal(err)
		}
	}
	if list, _, _ := store.List(""); len(list) != 0 {
		t.Fatalf("list after delete = %+v", list)
	}
	// Deleted conversations are not pending, and an acknowledgment passing
	// over them defers their messages instead of discarding them.
	if pending, _, _ := store.Pending(agent.ID); len(pending) != 0 {
		t.Fatalf("pending after delete = %+v", pending)
	}
	if _, err := store.Ack(agent.ID, 100, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Reply(agent, "c1", "m1", "late", nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("reply to deleted = %v", err)
	}
	store.Close()

	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if _, err := reopened.Get("c1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get deleted after reopen = %v", err)
	}
	restored, err := reopened.SetDeleted(human, "c1", false)
	if err != nil || restored.Deleted || restored.Messages[0].Body != "Remove me" {
		t.Fatalf("restored = %+v, %v", restored, err)
	}
	if _, err := reopened.SetDeleted(human, "c0", false); err != nil {
		t.Fatal(err)
	}
	// Restoring brings back what was never handled, not what was acknowledged.
	if pending, _, _ := reopened.Pending(agent.ID); len(pending) != 1 || pending[0].Message.Body != "Remove me" {
		t.Fatalf("pending after restore = %+v", pending)
	}
	if _, err := reopened.Ack(agent.ID, 4, nil); err != nil {
		t.Fatal(err)
	}
	if pending, _, _ := reopened.Pending(agent.ID); len(pending) != 0 {
		t.Fatalf("pending after acknowledging the restored message = %+v", pending)
	}
}

func TestProcessesSharingARepositoryKeepEachOthersCursors(t *testing.T) {
	dir := t.TempDir()
	first, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	agent := joinAgent(t, first)
	for _, id := range []string{"c1", "c2", "c3"} {
		if _, err := first.Create(human, id, anchorAt("a", 1, 1, "x"), id, nil); err != nil {
			t.Fatal(err)
		}
	}
	// Each process advances different cursors after opening; neither may
	// overwrite the other, and an older acknowledgement never moves one back.
	if _, err := first.Ack(agent.ID, 3, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := second.MarkRead(agent.ID, "c3", 4); err != nil {
		t.Fatal(err)
	}
	if seq, err := second.Ack(agent.ID, 1, nil); err != nil || seq != 3 {
		t.Fatalf("stale ack = %d, %v", seq, err)
	}
	if pending, cursor, _ := second.Pending(agent.ID); cursor != 3 || len(pending) != 1 || pending[0].Message.Body != "c3" {
		t.Fatalf("second sees pending %+v at %d", pending, cursor)
	}
	first.Close()
	second.Close()

	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	cursor, _ := reopened.Cursor(agent.ID)
	read, _ := reopened.Read(agent.ID)
	if cursor != 3 || read["c3"] != 4 {
		t.Fatalf("after reopen cursor = %d, read = %+v", cursor, read)
	}
}

func TestRetriedWritesFromAnotherProcessAreNotDuplicated(t *testing.T) {
	dir := t.TempDir()
	first, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	// A response lost after the write: the client retries the same ids,
	// possibly against another Gitna process.
	if _, err := first.Create(human, "c1", anchorAt("a", 1, 1, "x"), "start", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := second.Create(human, "c1", anchorAt("a", 1, 1, "x"), "start", nil); err != nil {
		t.Fatalf("retried create = %v", err)
	}
	for _, store := range []*Store{first, second, first} {
		if _, err := store.Reply(agent, "c1", "m1", "once", nil); err != nil {
			t.Fatalf("retried reply = %v", err)
		}
	}
	if _, err := second.Reply(agent, "c1", "m1", "different", nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("reused id with other content = %v", err)
	}
	got, _ := first.Get("c1")
	if len(got.Messages) != 2 {
		t.Fatalf("messages = %+v", got.Messages)
	}
}

func TestConcurrentRetriesAcrossProcessesSucceedOnce(t *testing.T) {
	dir := t.TempDir()
	stores := make([]*Store, 2)
	for index := range stores {
		store, err := Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		defer store.Close()
		stores[index] = store
	}
	var wg sync.WaitGroup
	for index := range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			store := stores[index%2]
			if _, err := store.Create(human, "c1", anchorAt("a", 1, 1, "x"), "start", nil); err != nil {
				t.Errorf("create: %v", err)
				return
			}
			if _, err := store.Reply(agent, "c1", "m1", "once", nil); err != nil {
				t.Errorf("reply: %v", err)
			}
		}()
	}
	wg.Wait()
	for _, store := range stores {
		if got, _ := store.Get("c1"); len(got.Messages) != 2 {
			t.Fatalf("messages = %+v", got.Messages)
		}
	}
}

func TestStoreLocateFollowsMovesWithoutGitMv(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git unavailable")
	}
	const body = "package x\n\nfunc A() {\n\treturn\n}\n\nfunc B() {}\n"
	setup := func(t *testing.T) (string, func(...string) []byte, *Store) {
		root := t.TempDir()
		git := func(args ...string) []byte {
			t.Helper()
			out, err := exec.Command("git", append([]string{"-C", root, "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...).Output()
			if err != nil {
				t.Fatalf("git %v: %v", args, err)
			}
			return out
		}
		git("init", "-q")
		os.WriteFile(filepath.Join(root, "old.go"), []byte(body), 0o644)
		os.WriteFile(filepath.Join(root, "other.go"), []byte("package x\n"), 0o644)
		git("add", ".")
		git("commit", "-qm", "init")
		store, err := Open(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { store.Close() })
		return root, git, store
	}
	create := func(t *testing.T, store *Store, source string) {
		anchor := Anchor{Path: "old.go", Source: source, Side: SideAdditions, StartLine: 4, EndLine: 4}
		if err := Capture(&anchor, []byte(body)); err != nil {
			t.Fatal(err)
		}
		if _, err := store.Create(human, "c1", anchor, "here", nil); err != nil {
			t.Fatal(err)
		}
	}
	locate := func(t *testing.T, root string, git func(...string) []byte, store *Store) Location {
		content := func(ctx context.Context, source, revision, path string) ([]byte, error) {
			if source == SourceIndex {
				out, err := exec.Command("git", "-C", root, "show", ":"+path).Output()
				if err != nil {
					return nil, os.ErrNotExist
				}
				return out, nil
			}
			return WorktreeContent(root)(ctx, source, revision, path)
		}
		renames := func(_ context.Context, source, revision string) (map[string]string, error) {
			if source == SourceIndex {
				return ParseRenames(git("diff", "--cached", "-M", "--name-status", "-z", revision, "--")), nil
			}
			return ParseRenames(git("diff", "-M", "--name-status", "-z", revision, "--")), nil
		}
		changed := func(context.Context) ([]string, error) {
			return ParseChanged(git("status", "--porcelain=v1", "-z", "--untracked-files=all")), nil
		}
		list, _, _ := store.List("")
		return *store.Locate(context.Background(), list, Sources{Content: content, Renames: renames, Changed: changed}, "")[0].Location
	}

	t.Run("plain mv", func(t *testing.T) {
		root, git, store := setup(t)
		create(t, store, SourceWorktree)
		before := git("ls-files", "-s")
		os.Rename(filepath.Join(root, "old.go"), filepath.Join(root, "new.go"))
		if got := locate(t, root, git, store); got != (Location{"new.go", 4, 4, LocationCurrent, "", ""}) {
			t.Fatalf("location = %+v", got)
		}
		if after := git("ls-files", "-s"); string(after) != string(before) {
			t.Fatalf("index changed:\n%s\n%s", before, after)
		}
	})

	t.Run("staged rename", func(t *testing.T) {
		root, git, store := setup(t)
		create(t, store, SourceIndex)
		git("mv", "old.go", "new.go")
		if got := locate(t, root, git, store); got != (Location{"new.go", 4, 4, LocationCurrent, "", ""}) {
			t.Fatalf("location = %+v", got)
		}
	})

	t.Run("code moved into another changed file", func(t *testing.T) {
		root, git, store := setup(t)
		create(t, store, SourceWorktree)
		os.WriteFile(filepath.Join(root, "old.go"), []byte("package x\n"), 0o644)
		os.WriteFile(filepath.Join(root, "other.go"), []byte("// moved\n"+body), 0o644)
		if got := locate(t, root, git, store); got != (Location{"other.go", 5, 5, LocationMoved, "", ""}) {
			t.Fatalf("location = %+v", got)
		}
	})

	t.Run("ambiguous destination falls back to the index", func(t *testing.T) {
		root, git, store := setup(t)
		create(t, store, SourceWorktree)
		os.WriteFile(filepath.Join(root, "old.go"), []byte("package x\n"), 0o644)
		os.WriteFile(filepath.Join(root, "other.go"), []byte(body), 0o644)
		os.WriteFile(filepath.Join(root, "third.go"), []byte(body), 0o644)
		if got := locate(t, root, git, store); got != (Location{"old.go", 4, 4, LocationCurrent, SourceIndex, ""}) {
			t.Fatalf("location = %+v", got)
		}
	})

	t.Run("code only without its context is not followed; the index still has it", func(t *testing.T) {
		root, git, store := setup(t)
		create(t, store, SourceWorktree)
		os.WriteFile(filepath.Join(root, "old.go"), []byte("package x\n"), 0o644)
		os.WriteFile(filepath.Join(root, "other.go"), []byte("package x\n\nfunc C() {\n\treturn\n}\n"), 0o644)
		if got := locate(t, root, git, store); got != (Location{"old.go", 4, 4, LocationCurrent, SourceIndex, ""}) {
			t.Fatalf("location = %+v", got)
		}
	})
}

func TestParseChanged(t *testing.T) {
	out := []byte(" M a.go\x00R  new.go\x00old.go\x00D  gone.go\x00?? dir/u.go\x00 D lost.go\x00")
	got := ParseChanged(out)
	want := []string{"a.go", "new.go", "dir/u.go"}
	if len(got) != len(want) {
		t.Fatalf("got %q", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %q", got)
		}
	}
}

func TestJoinIssuesDistinctParticipantsSharedAcrossProcesses(t *testing.T) {
	dir := t.TempDir()
	first, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	a, err := first.Join("Helper")
	if err != nil {
		t.Fatal(err)
	}
	b, err := first.Join("Helper")
	if err != nil {
		t.Fatal(err)
	}
	if a.ID == b.ID || a.Name != b.Name || a.Kind != KindAgent {
		t.Fatalf("joined %+v and %+v", a, b)
	}
	if unnamed, err := first.Join("  "); err != nil || unnamed.Name != DefaultAgentName {
		t.Fatalf("unnamed join = %+v, %v", unnamed, err)
	}
	if _, err := first.Join(strings.Repeat("x", 129)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("long name: %v", err)
	}

	second, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if got, err := second.Participant(a.ID); err != nil || got != a {
		t.Fatalf("other process sees %+v, %v", got, err)
	}
	if _, err := second.Participant("agent:never-issued"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unissued id: %v", err)
	}
	// Joining is not a message, so it never lands in anyone's inbox.
	if pending, _, _ := second.Pending(b.ID); len(pending) != 0 {
		t.Fatalf("pending = %+v", pending)
	}
}

// TestLocateThroughFileLifecycle follows a conversation on an untracked file
// as the file disappears, returns, is replaced, moves, gets committed and is
// deleted again, and one on uncommitted lines that Git never had.
func TestLocateThroughFileLifecycle(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git unavailable")
	}
	root, dir := t.TempDir(), t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		out, err := exec.Command("git", append([]string{"-C", root, "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...).Output()
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return strings.TrimSpace(string(out))
	}
	write := func(path, content string) {
		os.MkdirAll(filepath.Dir(filepath.Join(root, path)), 0o755)
		if err := os.WriteFile(filepath.Join(root, path), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	git("init", "-q")
	write("base.go", "package x\n\nfunc Base() {}\n")
	git("add", ".")
	git("commit", "-qm", "base")
	sources := Sources{
		Content: func(ctx context.Context, source, revision, path string) ([]byte, error) {
			if source == SourceWorktree {
				return WorktreeContent(root)(ctx, source, revision, path)
			}
			out, err := exec.Command("git", "-C", root, "show", revision+":"+path).Output()
			if err != nil {
				return nil, os.ErrNotExist
			}
			return out, nil
		},
		Renames: func(_ context.Context, _, revision string) (map[string]string, error) {
			return ParseRenames([]byte(git("diff", "-M", "--name-status", "-z", revision, "--"))), nil
		},
		Changed: func(context.Context) ([]string, error) {
			return ParseChanged([]byte(git("status", "--porcelain=v1", "-z", "--untracked-files=all"))), nil
		},
		Head: func(context.Context) string { return git("rev-parse", "HEAD") },
		Deleted: func(_ context.Context, path string) string {
			parent, _, _ := strings.Cut(git("log", "-1", "--diff-filter=D", "--format=%P", "HEAD", "--", path), " ")
			return parent
		},
	}
	open := func() *Store {
		store, err := Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		return store
	}
	store := open()
	defer func() { store.Close() }()
	const notes = "package x\n\n// Notes keeps notes.\nfunc Notes() string {\n\treturn \"notes\"\n}\n"
	write("notes.go", notes)
	create := func(id, path string, line int) {
		t.Helper()
		data, _ := os.ReadFile(filepath.Join(root, path))
		anchor := Anchor{Path: path, Source: SourceWorktree, Revision: git("rev-parse", "HEAD"), StartLine: line, EndLine: line}
		if err := Capture(&anchor, data); err != nil {
			t.Fatal(err)
		}
		if _, err := store.Create(human, id, anchor, "look", nil); err != nil {
			t.Fatal(err)
		}
	}
	create("notes", "notes.go", 4)
	at := func(id string) Location {
		t.Helper()
		conversation, err := store.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		return *store.Locate(context.Background(), []Conversation{conversation}, sources, "")[0].Location
	}
	expect := func(step, id string, want Location) {
		t.Helper()
		if got := at(id); got != want {
			t.Fatalf("%s: location = %+v, want %+v", step, got, want)
		}
	}

	expect("untracked file", "notes", Location{"notes.go", 4, 4, LocationCurrent, "", ""})
	os.Remove(filepath.Join(root, "notes.go"))
	expect("untracked file deleted", "notes", Location{"notes.go", 4, 4, LocationMissing, "", ""})
	write("notes.go", notes)
	expect("same file back", "notes", Location{"notes.go", 4, 4, LocationCurrent, "", ""})
	write("notes.go", "package y\n\nvar Other = 1\n\nfunc Unrelated() {}\n")
	expect("unrelated file at the same path", "notes", Location{"notes.go", 4, 4, LocationMissing, "", ""})
	os.Remove(filepath.Join(root, "notes.go"))
	write("pkg/notes.go", "// moved\n"+notes)
	expect("untracked file moved", "notes", Location{"pkg/notes.go", 5, 5, LocationMoved, "", ""})

	store.Close()
	store = open()
	expect("after a restart", "notes", Location{"pkg/notes.go", 5, 5, LocationMoved, "", ""})

	git("add", ".")
	git("commit", "-qm", "track notes")
	added := git("rev-parse", "HEAD")
	expect("now tracked", "notes", Location{"pkg/notes.go", 5, 5, LocationMoved, "", ""})
	os.Remove(filepath.Join(root, "pkg/notes.go"))
	expect("deleted, deletion unstaged", "notes", Location{"pkg/notes.go", 5, 5, LocationMoved, SourceIndex, ""})
	git("rm", "-q", "--cached", "pkg/notes.go")
	expect("deletion staged", "notes", Location{"pkg/notes.go", 5, 5, LocationMoved, SourceCommit, added})
	git("commit", "-qm", "drop notes")
	expect("deletion committed", "notes", Location{"pkg/notes.go", 5, 5, LocationMoved, SourceCommit, added})

	write("base.go", "package x\n\nfunc Base() {}\n\nfunc Draft() {}\n")
	create("draft", "base.go", 5)
	expect("uncommitted lines", "draft", Location{"base.go", 5, 5, LocationCurrent, "", ""})
	write("base.go", "package x\n\nfunc Base() {}\n")
	expect("uncommitted lines removed", "draft", Location{"base.go", 3, 3, LocationMissing, "", ""})
	os.Remove(filepath.Join(root, "base.go"))
	expect("file of uncommitted lines deleted", "draft", Location{"base.go", 5, 5, LocationMissing, "", ""})

	if conversation, _ := store.Get("notes"); conversation.Status != StatusOpen {
		t.Fatalf("deleting the file changed the status to %s", conversation.Status)
	}
}

func all(pending []Pending) []Pending { return pending }

// joinAgent joins the agent that receives people's messages by default.
func joinAgent(t *testing.T, store *Store) Participant {
	t.Helper()
	agent, err := store.Join("helper")
	if err != nil {
		t.Fatal(err)
	}
	return agent
}

func slug(text string) string { return strings.ReplaceAll(text, " ", "-") }

// TestRoutingDeliversOnlyToAddressedAgents covers who receives a message as
// pending: one joined agent by default, nobody for an unaddressed new
// conversation among several, explicit recipients, the thread's last
// addressed agent or last agent writer, and agents only when named.
func TestRoutingDeliversOnlyToAddressedAgents(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	bodies := func(agent Participant) []string {
		t.Helper()
		pending, _, err := store.Pending(agent.ID)
		if err != nil {
			t.Fatal(err)
		}
		out := []string{}
		for _, item := range pending {
			out = append(out, item.Message.Body)
		}
		return out
	}
	expect := func(agent Participant, want ...string) {
		t.Helper()
		if got := bodies(agent); !slices.Equal(got, append([]string{}, want...)) {
			t.Fatalf("%s pending = %q, want %q", agent.ID, got, want)
		}
	}
	create := func(id string, to ...string) Conversation {
		t.Helper()
		conversation, err := store.Create(human, slug(id), anchorAt("a", 1, 1, "x"), id, to)
		if err != nil {
			t.Fatal(err)
		}
		return conversation
	}
	reply := func(author Participant, conversation, id string, to ...string) {
		t.Helper()
		if _, err := store.Reply(author, slug(conversation), slug(id), id, to); err != nil {
			t.Fatal(err)
		}
	}

	a := joinAgent(t, store)
	create("solo")
	expect(a, "solo")

	// A later agent gets no replay, and with two agents nothing is assigned.
	b := joinAgent(t, store)
	expect(b)
	if unassigned := create("open question"); len(unassigned.Messages[0].To) != 0 || len(unassigned.DefaultTo) != 0 {
		t.Fatalf("unassigned conversation = %+v", unassigned)
	}
	expect(a, "solo")
	expect(b)
	if list, _, _ := store.List(""); len(list) != 2 {
		t.Fatalf("history must stay readable: %+v", list)
	}

	create("for b", b.ID)
	expect(b, "for b")
	// The thread keeps going to the agent last addressed there.
	reply(human, "for b", "follow-up")
	expect(b, "for b", "follow-up")
	expect(a, "solo")
	// Otherwise to the agent that wrote there last.
	reply(a, "open question", "a answers")
	reply(human, "open question", "thanks a")
	expect(a, "solo", "thanks a")
	expect(b, "for b", "follow-up")

	// Agents notify each other only when named.
	reply(a, "for b", "a chimes in")
	expect(b, "for b", "follow-up")
	reply(a, "for b", "a asks b", b.ID)
	expect(b, "for b", "follow-up", "a asks b")
	expect(a, "solo", "thanks a")
	if _, err := store.Reply(a, "for-b", "to-nobody", "x", []string{"agent:p_never"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unknown recipient = %v", err)
	}

	// A person's reply reopens a resolved conversation; an agent's does not.
	if _, err := store.SetStatus(human, "solo", StatusResolved); err != nil {
		t.Fatal(err)
	}
	reply(a, "solo", "agent after resolve")
	if got, _ := store.Get("solo"); got.Status != StatusResolved {
		t.Fatalf("agent reply reopened %+v", got)
	}
	reply(human, "solo", "person after resolve")
	if got, _ := store.Get("solo"); got.Status != StatusOpen {
		t.Fatalf("person reply left %s", got.Status)
	}
	expect(a, "solo", "thanks a", "person after resolve")

	// After a leaves, the one remaining agent is the default again, and
	// a's threads fall back to it.
	if err := store.Leave(a.ID); err != nil {
		t.Fatal(err)
	}
	if agents, _ := store.Agents(); len(agents) != 1 || agents[0] != b {
		t.Fatalf("agents = %+v", agents)
	}
	create("after leave")
	reply(human, "open question", "anyone")
	expect(b, "for b", "follow-up", "a asks b", "after leave", "anyone")
	if _, _, err := store.Pending(a.ID); err != nil {
		t.Fatalf("a left agent keeps its inbox: %v", err)
	}
}

// TestAcknowledgmentDefersHiddenMessages keeps a message whose code is
// missing out of pending without letting a later acknowledgment discard it.
func TestAcknowledgmentDefersHiddenMessages(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	agent := joinAgent(t, store)
	for _, id := range []string{"gone", "here"} {
		if _, err := store.Create(human, id, anchorAt(id, 1, 1, "x"), id, nil); err != nil {
			t.Fatal(err)
		}
	}
	// The caller hides "gone" while its file is missing and acknowledges the rest.
	if _, err := store.Ack(agent.ID, 3, map[string]bool{"gone": true}); err != nil {
		t.Fatal(err)
	}
	pending, cursor, _ := store.Pending(agent.ID)
	if cursor != 3 || len(pending) != 1 || pending[0].Message.Body != "gone" {
		t.Fatalf("pending = %+v at %d", pending, cursor)
	}
	// Still hidden: acknowledging again keeps it deferred.
	store.Ack(agent.ID, 3, map[string]bool{"gone": true})
	if pending, _, _ := store.Pending(agent.ID); len(pending) != 1 {
		t.Fatalf("deferred message lost: %+v", pending)
	}
	// Once its file is back and it is handled, it is acknowledged.
	store.Ack(agent.ID, 2, nil)
	if pending, _, _ := store.Pending(agent.ID); len(pending) != 0 {
		t.Fatalf("pending after acknowledging = %+v", pending)
	}
}
