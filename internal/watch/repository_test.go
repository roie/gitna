package watch

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/roie/gitna/internal/gitx"
)

func initRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	runGit(t, root, "init", "-q", root)
	runGit(t, root, "config", "user.email", "test@example.com")
	runGit(t, root, "config", "user.name", "Test")
	runGit(t, root, "branch", "-M", "main")
	runGit(t, root, "commit", "-q", "--allow-empty", "-m", "initial")
	return root
}

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return string(out)
}

func writeFile(t *testing.T, root, rel, content string) {
	t.Helper()
	path := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func startWatcher(t *testing.T, root string, opts Options) *Repository {
	t.Helper()
	repo, err := gitx.Discover(context.Background(), &gitx.ExecRunner{}, root)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	w, err := New(context.Background(), repo, &gitx.ExecRunner{}, opts)
	if err != nil {
		t.Fatalf("watch.New: %v", err)
	}
	t.Cleanup(func() { _ = w.Close() })
	return w
}

func nextEvent(t *testing.T, events <-chan InvalidationKind) InvalidationKind {
	t.Helper()
	select {
	case k := <-events:
		return k
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for invalidation event")
		return ""
	}
}

func expectNoEvent(t *testing.T, events <-chan InvalidationKind, wait time.Duration) {
	t.Helper()
	select {
	case k := <-events:
		t.Fatalf("unexpected invalidation %q", k)
	case <-time.After(wait):
	}
}

func drain(t *testing.T, events <-chan InvalidationKind, wait time.Duration) {
	t.Helper()
	deadline := time.After(wait)
	for {
		select {
		case <-events:
		case <-deadline:
			return
		}
	}
}

func waitForWatch(t *testing.T, w *Repository, dir string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		for _, path := range w.fsw.WatchList() {
			watched, watchedErr := os.Stat(path)
			expected, expectedErr := os.Stat(dir)
			if watchedErr == nil && expectedErr == nil && os.SameFile(watched, expected) {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("watch for %q was not registered", dir)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func trackedRepo(t *testing.T) string {
	t.Helper()
	root := initRepo(t)
	writeFile(t, root, "tracked.txt", "base\n")
	runGit(t, root, "add", "tracked.txt")
	runGit(t, root, "commit", "-q", "-m", "add tracked")
	return root
}

func TestWatcherSetupReportsBoundedCountsAndHonorsCancellation(t *testing.T) {
	root := t.TempDir()
	for _, path := range []string{"one", "one/two", "three"} {
		if err := os.MkdirAll(filepath.Join(root, path), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	var stats SetupStats
	watcher, err := New(t.Context(), gitx.Repository{Root: root}, nil, Options{
		FallbackInterval: -1,
		OnReady:          func(got SetupStats) { stats = got },
	})
	if err != nil {
		t.Fatal(err)
	}
	if stats.Directories != 4 || stats.Watches != 4 || stats.AddErrors != 0 {
		t.Fatalf("stats = %#v", stats)
	}
	_ = watcher.Close()

	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := New(ctx, gitx.Repository{Root: root}, nil, Options{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled setup error = %v", err)
	}
}

func TestWatcherReportsOrdinaryFolderChangesWithoutGit(t *testing.T) {
	root := t.TempDir()
	w, err := New(t.Context(), gitx.Repository{Root: root}, nil, Options{
		Debounce:         30 * time.Millisecond,
		FallbackInterval: 10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.Close() })
	events := w.Events()
	drain(t, events, 100*time.Millisecond)

	writeFile(t, root, "nested/file.txt", "content\n")
	if event := nextEvent(t, events); event != InvalidateFiles {
		t.Fatalf("event = %q, want %q", event, InvalidateFiles)
	}
	expectNoEvent(t, events, 200*time.Millisecond)
}

func TestRootOnlyWatcherObservesLoadedDirectoriesWithinBudget(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "deep", "child"), 0o755); err != nil {
		t.Fatal(err)
	}
	w, err := New(t.Context(), gitx.Repository{Root: root}, nil, Options{
		Debounce:               20 * time.Millisecond,
		FallbackInterval:       -1,
		RootOnly:               true,
		MaxObservedDirectories: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.Close() })
	if w.Coverage() != CoveragePartial {
		t.Fatalf("coverage = %q", w.Coverage())
	}
	writeFile(t, root, "deep/child/before.txt", "before\n")
	expectNoEvent(t, w.Events(), 100*time.Millisecond)
	if err := w.ObserveDirectory("deep/child"); err != nil {
		t.Fatal(err)
	}
	writeFile(t, root, "deep/child/after.txt", "after\n")
	if got := nextEvent(t, w.Events()); got != InvalidateFiles {
		t.Fatalf("event = %q", got)
	}
	if got := len(w.fsw.WatchList()); got > 2 {
		t.Fatalf("watch count = %d, want <= 2", got)
	}
}

func TestWatcherReportsWorktreeChanges(t *testing.T) {
	root := trackedRepo(t)
	w := startWatcher(t, root, Options{Debounce: 30 * time.Millisecond, FallbackInterval: -1})
	events := w.Events()
	drain(t, events, 100*time.Millisecond)

	writeFile(t, root, "tracked.txt", "changed\n")
	if got := nextEvent(t, events); got != InvalidateSnapshot {
		t.Fatalf("modified tracked file: got %q, want %q", got, InvalidateSnapshot)
	}
	drain(t, events, 100*time.Millisecond)

	writeFile(t, root, "new file.txt", "untracked\n")
	if got := nextEvent(t, events); got != InvalidateFiles {
		t.Fatalf("untracked file: got %q, want %q", got, InvalidateFiles)
	}
	drain(t, events, 100*time.Millisecond)

	if err := os.Rename(filepath.Join(root, "new file.txt"), filepath.Join(root, "renamed.txt")); err != nil {
		t.Fatal(err)
	}
	if got := nextEvent(t, events); got != InvalidateFiles {
		t.Fatalf("renamed file: got %q, want %q", got, InvalidateFiles)
	}
	drain(t, events, 100*time.Millisecond)

	if err := os.Remove(filepath.Join(root, "renamed.txt")); err != nil {
		t.Fatal(err)
	}
	if got := nextEvent(t, events); got != InvalidateFiles {
		t.Fatalf("removed file: got %q, want %q", got, InvalidateFiles)
	}
}

func TestWatcherTreatsAtomicReplacementAsContentChange(t *testing.T) {
	root := trackedRepo(t)
	w := startWatcher(t, root, Options{Debounce: 50 * time.Millisecond, FallbackInterval: -1})
	events := w.Events()
	drain(t, events, 100*time.Millisecond)

	temporary := filepath.Join(root, ".tracked.txt.save")
	if err := os.WriteFile(temporary, []byte("replacement\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "tracked.txt")
	if err := os.Rename(temporary, target); err != nil {
		// Windows does not replace an existing destination with os.Rename.
		if removeErr := os.Remove(target); removeErr != nil {
			t.Fatal(removeErr)
		}
		if renameErr := os.Rename(temporary, target); renameErr != nil {
			t.Fatal(renameErr)
		}
	}
	if got := nextEvent(t, events); got != InvalidateSnapshot {
		t.Fatalf("atomic replacement: got %q, want %q", got, InvalidateSnapshot)
	}
	expectNoEvent(t, events, 150*time.Millisecond)
}

func TestWatcherReportsIndexAndCommitChanges(t *testing.T) {
	root := trackedRepo(t)
	w := startWatcher(t, root, Options{Debounce: 30 * time.Millisecond, FallbackInterval: -1})
	events := w.Events()
	drain(t, events, 100*time.Millisecond)

	writeFile(t, root, "tracked.txt", "changed\n")
	if got := nextEvent(t, events); got != InvalidateSnapshot {
		t.Fatalf("content edit: got %q, want %q", got, InvalidateSnapshot)
	}
	drain(t, events, 100*time.Millisecond)
	// A slow git add need not share a debounce window with the content edit.
	// Check the index invalidation independently of that earlier notification.
	runGit(t, root, "add", "tracked.txt")
	if got := nextEvent(t, events); got != InvalidateFiles {
		t.Fatalf("stage: got %q, want %q", got, InvalidateFiles)
	}
	drain(t, events, 100*time.Millisecond)

	runGit(t, root, "commit", "-q", "-m", "change")
	// Index, HEAD, and refs writes can span multiple debounce windows. Require
	// both impacts, irrespective of notification order or duplicate snapshots.
	seen := map[InvalidationKind]bool{}
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	for (!seen[InvalidateSnapshot] && !seen[InvalidateFiles]) || !seen[InvalidateGraph] {
		select {
		case kind := <-events:
			seen[kind] = true
		case <-deadline.C:
			t.Fatalf("commit: got %v, want snapshot/files and graph invalidations", seen)
		}
	}
	drain(t, events, 200*time.Millisecond)
}

func TestWatcherReportsRefChanges(t *testing.T) {
	root := initRepo(t)
	w := startWatcher(t, root, Options{Debounce: 30 * time.Millisecond, FallbackInterval: -1})
	events := w.Events()
	drain(t, events, 100*time.Millisecond)

	runGit(t, root, "branch", "feature")

	seen := map[InvalidationKind]bool{}
	seen[nextEvent(t, events)] = true
	seen[nextEvent(t, events)] = true
	if !seen[InvalidateSnapshot] || !seen[InvalidateGraph] {
		t.Fatalf("ref change: got %v, want both %q and %q", seen, InvalidateSnapshot, InvalidateGraph)
	}
}

func TestWatcherReportsHeadAndPackedRefChanges(t *testing.T) {
	root := initRepo(t)
	runGit(t, root, "branch", "feature")
	w := startWatcher(t, root, Options{Debounce: 30 * time.Millisecond, FallbackInterval: -1})
	events := w.Events()
	drain(t, events, 100*time.Millisecond)

	runGit(t, root, "switch", "feature")
	seen := map[InvalidationKind]bool{}
	seen[nextEvent(t, events)] = true
	seen[nextEvent(t, events)] = true
	if (!seen[InvalidateSnapshot] && !seen[InvalidateFiles]) || !seen[InvalidateGraph] {
		t.Fatalf("clean switch invalidations = %v", seen)
	}
	drain(t, events, 150*time.Millisecond)

	runGit(t, root, "pack-refs", "--all", "--prune")
	seen = map[InvalidationKind]bool{}
	seen[nextEvent(t, events)] = true
	seen[nextEvent(t, events)] = true
	if !seen[InvalidateSnapshot] || !seen[InvalidateGraph] {
		t.Fatalf("packed refs invalidations = %v", seen)
	}
}

func TestWatcherReportsSharedRefChangesFromLinkedWorktree(t *testing.T) {
	root := initRepo(t)
	linked := filepath.Join(t.TempDir(), "linked")
	runGit(t, root, "branch", "linked")
	runGit(t, root, "worktree", "add", "-q", linked, "linked")
	w := startWatcher(t, linked, Options{Debounce: 30 * time.Millisecond, FallbackInterval: -1})
	events := w.Events()
	drain(t, events, 100*time.Millisecond)

	runGit(t, root, "branch", "shared-update")
	seen := map[InvalidationKind]bool{}
	seen[nextEvent(t, events)] = true
	seen[nextEvent(t, events)] = true
	if !seen[InvalidateSnapshot] || !seen[InvalidateGraph] {
		t.Fatalf("linked shared ref invalidations = %v", seen)
	}
}

func TestRepositoryFingerprintSeparatesWorktreeAndGraphState(t *testing.T) {
	root := trackedRepo(t)
	runner := &gitx.ExecRunner{}
	before, err := repositoryFingerprint(context.Background(), runner, root)
	if err != nil {
		t.Fatal(err)
	}

	runGit(t, root, "branch", "same-tip")
	afterRef, err := repositoryFingerprint(context.Background(), runner, root)
	if err != nil {
		t.Fatal(err)
	}
	if afterRef.worktree != before.worktree || afterRef.graph == before.graph {
		t.Fatalf("ref-only fingerprints before=%+v after=%+v", before, afterRef)
	}

	runGit(t, root, "switch", "same-tip")
	afterSwitch, err := repositoryFingerprint(context.Background(), runner, root)
	if err != nil {
		t.Fatal(err)
	}
	if afterSwitch.worktree != before.worktree || afterSwitch.graph == afterRef.graph {
		t.Fatalf("clean-switch fingerprints ref=%+v switch=%+v", afterRef, afterSwitch)
	}

	runGit(t, root, "switch", "--detach", "HEAD")
	afterDetach, err := repositoryFingerprint(context.Background(), runner, root)
	if err != nil {
		t.Fatal(err)
	}
	if afterDetach.graph == afterSwitch.graph {
		t.Fatal("graph fingerprint unchanged after detached HEAD transition")
	}
}

func TestWatcherReportsChangesInNewDirectories(t *testing.T) {
	root := initRepo(t)
	w := startWatcher(t, root, Options{Debounce: 30 * time.Millisecond, FallbackInterval: -1})
	events := w.Events()
	drain(t, events, 100*time.Millisecond)

	nested := filepath.Join(root, "nested")
	if err := os.Mkdir(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	waitForWatch(t, w, nested)
	deep := filepath.Join(nested, "deep")
	if err := os.Mkdir(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	waitForWatch(t, w, deep)
	writeFile(t, root, filepath.Join("nested", "deep", "file.txt"), "x\n")

	if got := nextEvent(t, events); got != InvalidateFiles {
		t.Fatalf("file in new directory: got %q, want %q", got, InvalidateFiles)
	}
}

func TestWatcherIgnoresGitLockFilesButReportsWorktreeLockFiles(t *testing.T) {
	root := trackedRepo(t)
	w := startWatcher(t, root, Options{Debounce: 30 * time.Millisecond, FallbackInterval: -1})
	events := w.Events()
	drain(t, events, 100*time.Millisecond)

	writeFile(t, root, ".git/index.lock", "x")
	expectNoEvent(t, events, 200*time.Millisecond)

	writeFile(t, root, "Cargo.lock", "[package]\n")
	if got := nextEvent(t, events); got != InvalidateFiles {
		t.Fatalf("worktree lock file event = %q, want %q", got, InvalidateFiles)
	}
}

func TestWatcherDebouncesBursts(t *testing.T) {
	root := trackedRepo(t)
	// Supply one event burst directly to the real classification/debounce loop.
	// Repeated disk writes can span multiple legitimate windows under -race;
	// native event delivery is covered by the surrounding integration tests.
	repo, err := gitx.Discover(context.Background(), &gitx.ExecRunner{}, root)
	if err != nil {
		t.Fatal(err)
	}
	w := &Repository{
		git: repo,
		fsw: &fsnotify.Watcher{
			Events: make(chan fsnotify.Event, 10),
			Errors: make(chan error),
		},
		opts:     Options{Debounce: 250 * time.Millisecond, FallbackInterval: -1},
		events:   make(chan InvalidationKind, 32),
		closedCh: make(chan struct{}),
	}
	for i := 0; i < 10; i++ {
		w.fsw.Events <- fsnotify.Event{Name: filepath.Join(repo.Root, "tracked.txt"), Op: fsnotify.Write}
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		w.loop(ctx)
	}()
	t.Cleanup(func() { cancel(); <-done })
	if got := nextEvent(t, w.Events()); got != InvalidateSnapshot {
		t.Fatalf("burst: got %q, want %q", got, InvalidateSnapshot)
	}
	expectNoEvent(t, w.Events(), 350*time.Millisecond)
}

func TestInvalidationQueuePreservesStructuralImpactWhenSaturated(t *testing.T) {
	w := &Repository{events: make(chan InvalidationKind, 32)}
	for range cap(w.events) {
		w.events <- InvalidateSnapshot
	}

	w.emit(InvalidateFiles)
	w.emit(InvalidateGraph)

	seen := map[InvalidationKind]bool{}
	for len(w.events) > 0 {
		seen[<-w.events] = true
	}
	if !seen[InvalidateFiles] || !seen[InvalidateGraph] || seen[InvalidateSnapshot] {
		t.Fatalf("compacted invalidations = %v", seen)
	}
}

func TestWatcherSilentWhenNothingChanges(t *testing.T) {
	root := initRepo(t)
	w := startWatcher(t, root, Options{Debounce: 30 * time.Millisecond, FallbackInterval: -1})
	events := w.Events()
	drain(t, events, 100*time.Millisecond)
	expectNoEvent(t, events, 400*time.Millisecond)
}

func TestFingerprintReflectsWorktreeChange(t *testing.T) {
	root := trackedRepo(t)
	runner := &gitx.ExecRunner{}
	before, err := fingerprint(context.Background(), runner, root)
	if err != nil {
		t.Fatalf("fingerprint: %v", err)
	}
	writeFile(t, root, "tracked.txt", "changed\n")
	after, err := fingerprint(context.Background(), runner, root)
	if err != nil {
		t.Fatalf("fingerprint: %v", err)
	}
	if before == after {
		t.Fatal("fingerprint unchanged after worktree edit")
	}
}

func TestFallbackEmitsWhenFingerprintChanges(t *testing.T) {
	root := initRepo(t)
	count := 0
	w := startWatcher(t, root, Options{
		FallbackInterval: 30 * time.Millisecond,
		Fingerprint: func(context.Context) (string, error) {
			count++
			if count >= 2 {
				return "changed", nil
			}
			return "same", nil
		},
	})
	events := w.Events()
	if got := nextEvent(t, events); got != InvalidateFiles {
		t.Fatalf("fallback: got %q, want %q", got, InvalidateFiles)
	}
}

func TestFallbackSilentWhenFingerprintUnchanged(t *testing.T) {
	root := initRepo(t)
	w := startWatcher(t, root, Options{
		FallbackInterval: 30 * time.Millisecond,
		Fingerprint: func(context.Context) (string, error) {
			return "same", nil
		},
	})
	time.Sleep(200 * time.Millisecond)
	expectNoEvent(t, w.Events(), 50*time.Millisecond)
}

func TestCloseClosesEvents(t *testing.T) {
	root := initRepo(t)
	w := startWatcher(t, root, Options{Debounce: 30 * time.Millisecond, FallbackInterval: -1})
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	select {
	case _, ok := <-w.Events():
		if ok {
			t.Fatal("Events channel still open after Close")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Events channel not closed after Close")
	}
}

func TestWatcherClassifiesSearchMetadataConservatively(t *testing.T) {
	root := trackedRepo(t)
	w := startWatcher(t, root, Options{FallbackInterval: -1})
	for _, path := range []string{".git/index", ".gitignore", "nested/.gitignore"} {
		for _, op := range []fsnotify.Op{fsnotify.Write, fsnotify.Create, fsnotify.Remove, fsnotify.Rename} {
			// Native events use the installed watch's canonical path, not an
			// alias such as macOS /var or Windows' short temporary directory.
			kinds := w.classify(fsnotify.Event{Name: filepath.Join(w.git.Root, path), Op: op})
			if len(kinds) != 1 || kinds[0] != InvalidateFiles {
				t.Errorf("%s %s: %v, want files invalidation", path, op, kinds)
			}
		}
	}
}

func TestWatcherOverflowConservativelyInvalidatesFilesAndGraph(t *testing.T) {
	root := trackedRepo(t)
	w := startWatcher(t, root, Options{Debounce: 30 * time.Millisecond, FallbackInterval: -1})
	w.fsw.Errors <- fsnotify.ErrEventOverflow
	seen := map[InvalidationKind]bool{}
	seen[nextEvent(t, w.Events())] = true
	seen[nextEvent(t, w.Events())] = true
	if !seen[InvalidateFiles] || !seen[InvalidateGraph] {
		t.Fatalf("overflow events = %v", seen)
	}
}

func TestWatcherTemporaryMembershipAcrossScansIsStructural(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "file.txt", "before")
	w := &Repository{directorySignatures: make(map[string][sha256.Size]byte)}
	w.rememberDirectoryLocked(root)
	directories := map[string]struct{}{root: {}}
	writeFile(t, root, ".file.txt.save", "after")
	if !w.worktreeStructureChanged(directories) {
		t.Fatal("temporary entry present at scan must invalidate membership")
	}
	if err := os.Remove(filepath.Join(root, ".file.txt.save")); err != nil {
		t.Fatal(err)
	}
	if !w.worktreeStructureChanged(directories) {
		t.Fatal("temporary entry removal must invalidate membership")
	}
	if w.worktreeStructureChanged(directories) {
		t.Fatal("unchanged membership must retain indexes")
	}
}
