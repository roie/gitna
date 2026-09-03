package app

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/roie/gitna/internal/folder"
	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/watch"
)

func initSessionRepository(t *testing.T, parent, name string) string {
	t.Helper()
	root := filepath.Join(parent, name)
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("git", "-C", root, "init", "-q", "-b", "main")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, output)
	}
	return root
}

func TestFolderSessionCancelsSupersededWatcherBeforeStartingReplacement(t *testing.T) {
	root := t.TempDir()
	runner := &gitx.ExecRunner{}
	repo, err := gitx.OpenFolder(t.Context(), runner, root)
	if err != nil {
		t.Fatal(err)
	}
	firstStarted := make(chan struct{})
	firstCanceled := make(chan struct{})
	secondStarted := make(chan struct{})
	orderViolation := make(chan struct{}, 1)
	var calls atomic.Int32
	factory := func(ctx context.Context, _ gitx.Repository, _ gitx.Runner, _ watch.Options) (watch.Watcher, error) {
		switch calls.Add(1) {
		case 1:
			close(firstStarted)
			<-ctx.Done()
			close(firstCanceled)
			return nil, ctx.Err()
		case 2:
			select {
			case <-firstCanceled:
			default:
				orderViolation <- struct{}{}
			}
			close(secondStarted)
			return &testWatcher{events: make(chan watch.InvalidationKind)}, nil
		default:
			return nil, errors.New("unexpected watcher setup")
		}
	}
	session, err := newFolderSession(
		t.Context(), runner, repo, folder.Open(filepath.Join(t.TempDir(), "folders.json"), 5), factory,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer session.close()
	select {
	case <-firstStarted:
	case <-time.After(time.Second):
		t.Fatal("initial watcher setup did not start")
	}

	if output, err := exec.Command("git", "-C", root, "init", "-q", "-b", "main").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, output)
	}
	gitRepo, err := gitx.OpenFolder(t.Context(), runner, root)
	if err != nil {
		t.Fatal(err)
	}
	if err := session.refresh(t.Context(), gitRepo); err != nil {
		t.Fatal(err)
	}
	select {
	case <-firstCanceled:
	case <-time.After(time.Second):
		t.Fatal("superseded watcher setup did not observe cancellation")
	}
	select {
	case <-secondStarted:
	case <-time.After(time.Second):
		t.Fatal("replacement watcher setup did not start")
	}
	select {
	case <-orderViolation:
		t.Fatal("replacement watcher started before superseded setup exited")
	default:
	}
}

func TestFolderSessionSetupReconcilesFileMembership(t *testing.T) {
	root := t.TempDir()
	runner := &gitx.ExecRunner{}
	repo, err := gitx.OpenFolder(t.Context(), runner, root)
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	factory := func(context.Context, gitx.Repository, gitx.Runner, watch.Options) (watch.Watcher, error) {
		close(started)
		<-release
		return &testWatcher{events: make(chan watch.InvalidationKind)}, nil
	}
	session, err := newFolderSession(
		t.Context(), runner, repo, folder.Open(filepath.Join(t.TempDir(), "folders.json"), 5), factory,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer session.close()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("watcher setup did not start")
	}
	if err := os.WriteFile(filepath.Join(root, "created-during-setup.txt"), []byte("created\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	close(release)

	select {
	case got := <-session.events:
		if got != watch.InvalidateFiles {
			t.Fatalf("setup reconciliation = %q, want %q", got, watch.InvalidateFiles)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for setup reconciliation")
	}
}

type observingTestWatcher struct {
	*testWatcher
	mu          sync.Mutex
	directories []string
}

func newObservingTestWatcher() *observingTestWatcher {
	return &observingTestWatcher{testWatcher: &testWatcher{events: make(chan watch.InvalidationKind)}}
}

func (w *observingTestWatcher) ObserveDirectory(path string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.directories = append(w.directories, path)
	return nil
}

func (w *observingTestWatcher) Coverage() watch.Coverage { return watch.CoveragePartial }

func (w *observingTestWatcher) observed() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]string(nil), w.directories...)
}

func TestFolderSessionBoundsObservedDirectoryReplayWithRootPreservingLRU(t *testing.T) {
	root := t.TempDir()
	runner := &gitx.ExecRunner{}
	repo, err := gitx.OpenFolder(t.Context(), runner, root)
	if err != nil {
		t.Fatal(err)
	}
	created := make(chan *observingTestWatcher, 2)
	factory := func(context.Context, gitx.Repository, gitx.Runner, watch.Options) (watch.Watcher, error) {
		watcher := newObservingTestWatcher()
		created <- watcher
		return watcher, nil
	}
	session, err := newFolderSession(t.Context(), runner, repo, nil, factory)
	if err != nil {
		t.Fatal(err)
	}
	defer session.close()
	select {
	case <-created:
	case <-time.After(time.Second):
		t.Fatal("initial watcher setup did not finish")
	}

	for index := 0; index < watch.DefaultMaxObservedDirectories+16; index++ {
		session.observeDirectory("dir-" + strconv.Itoa(index))
	}
	// Touch an older retained directory so replay proves true LRU behavior.
	touched := "dir-16"
	session.observeDirectory(touched)
	session.startWatcher(repo)

	var replacement *observingTestWatcher
	select {
	case replacement = <-created:
	case <-time.After(time.Second):
		t.Fatal("replacement watcher setup did not start")
	}
	deadline := time.Now().Add(time.Second)
	for len(replacement.observed()) < watch.DefaultMaxObservedDirectories {
		if time.Now().After(deadline) {
			t.Fatalf("replayed %d directories, want %d", len(replacement.observed()), watch.DefaultMaxObservedDirectories)
		}
		time.Sleep(time.Millisecond)
	}
	observed := replacement.observed()
	if len(observed) != watch.DefaultMaxObservedDirectories {
		t.Fatalf("replayed %d directories, want bounded %d", len(observed), watch.DefaultMaxObservedDirectories)
	}
	if observed[0] != "" {
		t.Fatalf("first replay = %q, want root", observed[0])
	}
	if observed[len(observed)-1] != touched {
		t.Fatalf("last replay = %q, want recently touched %q", observed[len(observed)-1], touched)
	}
	for _, directory := range observed {
		if directory == "dir-0" {
			t.Fatal("evicted directory dir-0 was replayed")
		}
	}
}

func TestFolderSessionOwnsOneFolder(t *testing.T) {
	root := initSessionRepository(t, t.TempDir(), "first")
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	runner := &gitx.ExecRunner{}
	repo, err := gitx.Discover(ctx, runner, root)
	if err != nil {
		t.Fatal(err)
	}
	catalog := folder.Open(filepath.Join(t.TempDir(), "folders.json"), 5)
	session, err := newFolderSession(ctx, runner, repo, catalog)
	if err != nil {
		t.Fatal(err)
	}
	defer session.close()

	if session.adapter.current().Root != root {
		t.Fatalf("adapter root = %q, want %q", session.adapter.current().Root, root)
	}
	folders := session.folderCatalog()
	if folders.Current.Path != root || len(folders.Recent) != 1 {
		t.Fatalf("folders = %#v", folders)
	}
	if err := session.close(); err != nil {
		t.Fatal(err)
	}
}
