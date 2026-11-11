package conversations

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

var (
	human = Participant{ID: "human:local", Kind: KindHuman, Name: "Ada"}
	agent = Participant{ID: "agent:claude", Kind: KindAgent, Name: "claude"}
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
	conversation, err := store.Create(human, "c1", anchorAt("main.go", 3, 4, "a\nb"), "Why this?\nSecond line")
	if err != nil {
		t.Fatal(err)
	}
	pending, cursor, err := store.Pending(agent.ID)
	if err != nil || len(pending) != 1 || cursor != 0 || pending[0].Message.Body != "Why this?\nSecond line" {
		t.Fatalf("pending = %+v, %d, %v", pending, cursor, err)
	}
	if _, err := store.Ack(agent.ID, pending[0].Message.Seq); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Reply(agent, conversation.ID, "m1", "Because."); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Reply(human, conversation.ID, "m2", "Change it."); err != nil {
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
	if cursor != 1 || len(pending) != 1 || pending[0].Message.ID != "m2" {
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
		if _, err := store.Create(human, "c1", anchor, "hello"); err != nil {
			t.Fatal(err)
		}
		if _, err := store.Reply(agent, "c1", "m1", "hi"); err != nil {
			t.Fatal(err)
		}
		if _, err := store.SetStatus(agent, "c1", StatusResolved); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.Create(human, "c1", anchor, "different"); !errors.Is(err, ErrConflict) {
		t.Fatalf("conflicting create error = %v", err)
	}
	if _, err := store.Reply(agent, "c1", "m1", "different"); !errors.Is(err, ErrConflict) {
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
	first, _ := store.Create(agent, "c1", anchorAt("a", 1, 1, "x"), "one")
	second, _ := store.Create(agent, "c2", anchorAt("a", 1, 1, "x"), "two")
	if _, err := store.MarkRead(human.ID, second.ID, second.Seq); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MarkRead(human.ID, "missing", 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown conversation error = %v", err)
	}
	store.Close()
	if store, err = Open(dir); err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if read, _ := store.Read(human.ID); len(read) != 1 || read[second.ID] != second.Seq || read[first.ID] != 0 {
		t.Fatalf("read = %+v", read)
	}
	if pending, _, _ := store.Pending(human.ID); len(pending) != 2 {
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
		if _, err := store.Create(human, "", anchor, "x"); !errors.Is(err, ErrInvalid) {
			t.Fatalf("anchor %+v error = %v", anchor, err)
		}
	}
	if _, err := store.Create(Participant{ID: "agent:x", Kind: KindHuman}, "", anchorAt("a", 1, 1, ""), "x"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("mismatched participant error = %v", err)
	}
	if _, err := store.Create(human, "", anchorAt("a", 1, 1, ""), "   "); !errors.Is(err, ErrInvalid) {
		t.Fatalf("empty body error = %v", err)
	}
}

func TestWaitPendingWakesOnReply(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan []Pending)
	go func() {
		pending, _, _ := store.WaitPending(ctx, agent.ID)
		done <- pending
	}()
	time.Sleep(20 * time.Millisecond)
	if _, err := store.Create(human, "c1", anchorAt("a", 1, 1, "x"), "ping"); err != nil {
		t.Fatal(err)
	}
	if pending := <-done; len(pending) != 1 || pending[0].Message.Body != "ping" {
		t.Fatalf("pending = %+v", pending)
	}
	// Own messages never count as pending.
	short, stop := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer stop()
	if pending, _, _ := store.WaitPending(short, human.ID); len(pending) != 0 {
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
	if _, err := first.Create(human, "c1", anchorAt("a", 1, 1, "x"), "start"); err != nil {
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
			if _, err := store.Reply(agent, "c1", NewID("m"), "reply"); err != nil {
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
		if a.Messages[index] != b.Messages[index] {
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
	if _, err := store.Create(human, "c1", anchorAt("a", 1, 1, "x"), "start"); err != nil {
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
	if _, err := store.Reply(agent, "c1", "m1", "after crash"); err != nil {
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
		{"unchanged", "h\na\nb\nc\nd\ne\n", Location{"f.go", 3, 4, LocationCurrent}},
		{"crlf", "h\r\na\r\nb\r\nc\r\nd\r\ne\r\n", Location{"f.go", 3, 4, LocationCurrent}},
		{"lines inserted above", "new\nh\nnew\na\nb\nc\nd\ne\n", Location{"f.go", 5, 6, LocationMoved}},
		{"neighbours edited in place", "h\nA\nb\nc\nD\ne\n", Location{"f.go", 3, 4, LocationCurrent}},
		{"code edited", "h\na\nB\nc\nd\ne\n", Location{"f.go", 3, 4, LocationOutdated}},
		{"code deleted, file shorter", "h\n", Location{"f.go", 1, 1, LocationOutdated}},
		{"moved among strangers", "x\nb\nc\ny\nh\na\nd\ne\n", Location{"f.go", 3, 4, LocationOutdated}},
		{"deleted, look-alike lands on the same lines", "x\ny\nb\nc\nz\nb\nc\n", Location{"f.go", 3, 4, LocationOutdated}},
		{"duplicate with the real context wins", "b\nc\nx\nh\na\nb\nc\nd\ne\n", Location{"f.go", 6, 7, LocationMoved}},
		{"two confirmed copies", "h\na\nb\nc\nq\nq\nh\na\nb\nc\n", Location{"f.go", 3, 4, LocationCurrent}},
		{"two confirmed copies elsewhere", "q\nq\nq\nq\nh\na\nb\nc\nq\nh\na\nb\nc\n", Location{"f.go", 3, 4, LocationOutdated}},
	}
	for _, tc := range cases {
		if got := Locate(anchor, "f.go", []byte(tc.content)); got != tc.want {
			t.Errorf("%s: Locate(%q) = %+v, want %+v", tc.name, tc.content, got, tc.want)
		}
	}
	whole := anchorAt("f", 1, 2, "a\n")
	if got := Locate(whole, "f", []byte("x\na\n\ny\n")); got != (Location{"f", 2, 3, LocationMoved}) {
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
		if _, err := store.Create(human, id, anchor, "note"); err != nil {
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
	for _, conversation := range store.Locate(context.Background(), list, content, nil, nil, "") {
		got[conversation.ID] = *conversation.Location
	}
	want := map[string]Location{
		"commit":  {"f", 9, 9, LocationCurrent},
		"index":   {"f", 2, 2, LocationMoved},
		"work":    {"f", 1, 1, LocationOutdated},
		"missing": {"nope", 1, 1, LocationMissing},
	}
	for id, location := range want {
		if got[id] != location {
			t.Errorf("%s = %+v, want %+v", id, got[id], location)
		}
	}
	bad := Anchor{Path: "f", Source: SourceCommit, Revision: "HEAD", StartLine: 1, EndLine: 1}
	if _, err := store.Create(human, "", bad, "x"); !errors.Is(err, ErrInvalid) {
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
	if _, err := store.Create(human, "c1", anchorAt("old.go", 3, 3, "func A() {}"), "rename me"); err != nil {
		t.Fatal(err)
	}
	renames := func(ctx context.Context, _, revision string) (map[string]string, error) {
		return ParseRenames(git("diff", "-M", "--name-status", "-z", revision, "--")), nil
	}
	list, _, _ := store.List("")
	list = store.Locate(context.Background(), list, WorktreeContent(root), renames, nil, "new.go")
	if got := *list[0].Location; got != (Location{"new.go", 4, 4, LocationMoved}) {
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
	if _, err := store.Create(human, "c1", anchorAt("main.go", 1, 1, "a"), "Remove me"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetDeleted(human, "c1", true); err != nil {
		t.Fatal(err)
	}
	if list, _, _ := store.List(""); len(list) != 0 {
		t.Fatalf("list after delete = %+v", list)
	}
	// Delivery stays durable: the agent still receives the message, flagged.
	if pending, _, _ := store.Pending(agent.ID); len(pending) != 1 || !pending[0].Conversation.Deleted {
		t.Fatalf("pending after delete = %+v", pending)
	}
	if _, err := store.Reply(agent, "c1", "m1", "late"); !errors.Is(err, ErrNotFound) {
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
	if pending, _, _ := reopened.Pending(agent.ID); len(pending) != 1 || pending[0].Conversation.Deleted {
		t.Fatalf("pending after restore = %+v", pending)
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
	for _, id := range []string{"c1", "c2", "c3"} {
		if _, err := first.Create(human, id, anchorAt("a", 1, 1, "x"), id); err != nil {
			t.Fatal(err)
		}
	}
	// Each process advances different cursors after opening; neither may
	// overwrite the other, and an older acknowledgement never moves one back.
	if _, err := first.Ack(agent.ID, 2); err != nil {
		t.Fatal(err)
	}
	if _, err := second.MarkRead(agent.ID, "c3", 3); err != nil {
		t.Fatal(err)
	}
	if seq, err := second.Ack(agent.ID, 1); err != nil || seq != 2 {
		t.Fatalf("stale ack = %d, %v", seq, err)
	}
	if pending, cursor, _ := second.Pending(agent.ID); cursor != 2 || len(pending) != 1 || pending[0].Message.Body != "c3" {
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
	if cursor != 2 || read["c3"] != 3 {
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
	if _, err := first.Create(human, "c1", anchorAt("a", 1, 1, "x"), "start"); err != nil {
		t.Fatal(err)
	}
	if _, err := second.Create(human, "c1", anchorAt("a", 1, 1, "x"), "start"); err != nil {
		t.Fatalf("retried create = %v", err)
	}
	for _, store := range []*Store{first, second, first} {
		if _, err := store.Reply(agent, "c1", "m1", "once"); err != nil {
			t.Fatalf("retried reply = %v", err)
		}
	}
	if _, err := second.Reply(agent, "c1", "m1", "different"); !errors.Is(err, ErrConflict) {
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
			if _, err := store.Create(human, "c1", anchorAt("a", 1, 1, "x"), "start"); err != nil {
				t.Errorf("create: %v", err)
				return
			}
			if _, err := store.Reply(agent, "c1", "m1", "once"); err != nil {
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
		if _, err := store.Create(human, "c1", anchor, "here"); err != nil {
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
		return *store.Locate(context.Background(), list, content, renames, changed, "")[0].Location
	}

	t.Run("plain mv", func(t *testing.T) {
		root, git, store := setup(t)
		create(t, store, SourceWorktree)
		before := git("ls-files", "-s")
		os.Rename(filepath.Join(root, "old.go"), filepath.Join(root, "new.go"))
		if got := locate(t, root, git, store); got != (Location{"new.go", 4, 4, LocationCurrent}) {
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
		if got := locate(t, root, git, store); got != (Location{"new.go", 4, 4, LocationCurrent}) {
			t.Fatalf("location = %+v", got)
		}
	})

	t.Run("code moved into another changed file", func(t *testing.T) {
		root, git, store := setup(t)
		create(t, store, SourceWorktree)
		os.WriteFile(filepath.Join(root, "old.go"), []byte("package x\n"), 0o644)
		os.WriteFile(filepath.Join(root, "other.go"), []byte("// moved\n"+body), 0o644)
		if got := locate(t, root, git, store); got != (Location{"other.go", 5, 5, LocationMoved}) {
			t.Fatalf("location = %+v", got)
		}
	})

	t.Run("ambiguous destination stays outdated", func(t *testing.T) {
		root, git, store := setup(t)
		create(t, store, SourceWorktree)
		os.WriteFile(filepath.Join(root, "old.go"), []byte("package x\n"), 0o644)
		os.WriteFile(filepath.Join(root, "other.go"), []byte(body), 0o644)
		os.WriteFile(filepath.Join(root, "third.go"), []byte(body), 0o644)
		if got := locate(t, root, git, store); got.Path != "old.go" || got.Status != LocationOutdated {
			t.Fatalf("location = %+v", got)
		}
	})

	t.Run("code only without its context is not followed", func(t *testing.T) {
		root, git, store := setup(t)
		create(t, store, SourceWorktree)
		os.WriteFile(filepath.Join(root, "old.go"), []byte("package x\n"), 0o644)
		os.WriteFile(filepath.Join(root, "other.go"), []byte("package x\n\nfunc C() {\n\treturn\n}\n"), 0o644)
		if got := locate(t, root, git, store); got.Path != "old.go" || got.Status != LocationOutdated {
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
	a, err := first.Join("Claude")
	if err != nil {
		t.Fatal(err)
	}
	b, err := first.Join("Claude")
	if err != nil {
		t.Fatal(err)
	}
	if a.ID == b.ID || a.Name != b.Name || a.Kind != KindAgent {
		t.Fatalf("joined %+v and %+v", a, b)
	}
	if _, err := first.Join("  "); !errors.Is(err, ErrInvalid) {
		t.Fatalf("blank name: %v", err)
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
