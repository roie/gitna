package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/roie/gitna/internal/gitx"
)

func TestLineHistoryIsIndependentOfMutationQueue(t *testing.T) {
	root := initSessionRepository(t, t.TempDir(), "repo")
	runner := &gitx.ExecRunner{}
	repo, err := gitx.OpenFolder(t.Context(), runner, root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "note.txt"), []byte("original\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	queue := gitx.NewMutationQueue()
	defer func() { queue.Stop(); queue.Wait() }()
	adapter := &repoAdapter{repo: repo, runner: runner, queue: queue}

	started, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		done <- queue.Do(t.Context(), func(context.Context) error {
			close(started)
			<-release
			return nil
		})
	}()
	<-started
	defer func() { close(release); <-done }()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	history, err := adapter.LineHistory(ctx, "note.txt", 1)
	if err != nil || !history.Uncommitted {
		t.Fatalf("blame waited for mutations: history=%+v err=%v", history, err)
	}
}

func TestBusyLineHistoryDoesNotBlockSaveOrStage(t *testing.T) {
	root := initSessionRepository(t, t.TempDir(), "repo")
	runner := &gitx.ExecRunner{}
	repo, err := gitx.OpenFolder(t.Context(), runner, root)
	if err != nil {
		t.Fatal(err)
	}
	queue := gitx.NewMutationQueue()
	defer func() { queue.Stop(); queue.Wait() }()
	adapter := &repoAdapter{repo: repo, runner: runner, queue: queue}
	adapter.historyOnce.Do(func() { adapter.historySlot = make(chan struct{}, 1) })
	adapter.historySlot <- struct{}{}
	defer func() { <-adapter.historySlot }()

	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	file, err := adapter.CreateWorktreeFile(ctx, "note.txt", "original\n")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := adapter.WriteWorktreeFile(ctx, "note.txt", "saved\n", file.Hash); err != nil {
		t.Fatalf("save blocked by blame: %v", err)
	}
	if err := adapter.StagePaths(ctx, []string{"note.txt"}); err != nil {
		t.Fatalf("stage blocked by blame: %v", err)
	}
	cancel()
	if _, err := adapter.LineHistory(ctx, "note.txt", 1); !errors.Is(err, context.Canceled) {
		t.Fatalf("waiting blame ignored cancellation: %v", err)
	}
}
