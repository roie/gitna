package watch

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

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
	runGit(t, root, "add", "tracked.txt")
	if got := nextEvent(t, events); got != InvalidateSnapshot {
		t.Fatalf("stage: got %q, want %q", got, InvalidateSnapshot)
	}
	drain(t, events, 100*time.Millisecond)

	runGit(t, root, "commit", "-q", "-m", "change")
	// A commit updates both HEAD and refs/heads/main, so the debounced flush
	// emits snapshot and graph invalidations together; Go map iteration order
	// is random, so accept either arrival order as long as the snapshot
	// invalidation is among them.
	seen := map[InvalidationKind]bool{}
	seen[nextEvent(t, events)] = true
	seen[nextEvent(t, events)] = true
	if !seen[InvalidateSnapshot] {
		t.Fatalf("commit: got %v, want a snapshot invalidation", seen)
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
	if !seen[InvalidateSnapshot] || !seen[InvalidateGraph] {
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

func TestWatcherIgnoresLockFiles(t *testing.T) {
	root := trackedRepo(t)
	w := startWatcher(t, root, Options{Debounce: 30 * time.Millisecond, FallbackInterval: -1})
	events := w.Events()
	drain(t, events, 100*time.Millisecond)

	writeFile(t, root, ".git/index.lock", "x")
	expectNoEvent(t, events, 200*time.Millisecond)
}

func TestWatcherDebouncesBursts(t *testing.T) {
	root := trackedRepo(t)
	// Keep the debounce window comfortably above the per-write race-detector
	// overhead so this remains one logical burst under -race and CPU contention.
	w := startWatcher(t, root, Options{Debounce: 250 * time.Millisecond, FallbackInterval: -1})
	events := w.Events()
	drain(t, events, 350*time.Millisecond)

	for i := 0; i < 10; i++ {
		writeFile(t, root, "tracked.txt", "line\n")
	}
	if got := nextEvent(t, events); got != InvalidateSnapshot {
		t.Fatalf("burst: got %q, want %q", got, InvalidateSnapshot)
	}
	// A burst must not fan out into one event per write; at most a second
	// debounce flush may follow.
	select {
	case <-events:
	case <-time.After(200 * time.Millisecond):
	}
	expectNoEvent(t, events, 200*time.Millisecond)
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
