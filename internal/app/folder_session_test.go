package app

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
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
