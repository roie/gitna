package app

import (
	"context"
	"fmt"
	"sync"

	"github.com/roie/gitna/internal/browser"
	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/watch"
)

// repositorySession keeps the HTTP capability URL stable while the user
// explicitly switches the repository behind it. The adapter and watcher are
// replaced together; the public events channel remains stable for existing SSE
// clients.
type repositorySession struct {
	ctx     context.Context
	runner  *gitx.ExecRunner
	adapter *repoAdapter
	events  chan watch.InvalidationKind

	switchMu sync.Mutex
	mu       sync.Mutex
	watcher  watch.Watcher
}

func newRepositorySession(
	ctx context.Context,
	runner *gitx.ExecRunner,
	repo gitx.Repository,
) (*repositorySession, error) {
	watcher, err := watch.New(ctx, repo, runner, watch.Options{})
	if err != nil {
		return nil, err
	}
	s := &repositorySession{
		ctx:     ctx,
		runner:  runner,
		adapter: &repoAdapter{runner: runner, repo: repo, queue: gitx.NewMutationQueue()},
		events:  make(chan watch.InvalidationKind, 16),
		watcher: watcher,
	}
	s.forward(watcher)
	return s, nil
}

func (s *repositorySession) forward(watcher watch.Watcher) {
	go func() {
		for event := range watcher.Events() {
			select {
			case s.events <- event:
			default:
			}
		}
	}()
}

func (s *repositorySession) switchRepository(ctx context.Context, path string) (string, error) {
	s.switchMu.Lock()
	defer s.switchMu.Unlock()

	repo, err := gitx.Discover(ctx, s.runner, path)
	if err != nil {
		return "", fmt.Errorf("discover repository: %w", err)
	}
	if repo.Root == s.adapter.current().Root {
		return repo.Root, nil
	}

	watcher, err := watch.New(s.ctx, repo, s.runner, watch.Options{})
	if err != nil {
		return "", fmt.Errorf("watch repository: %w", err)
	}
	if err := s.adapter.switchTo(ctx, repo); err != nil {
		_ = watcher.Close()
		return "", err
	}

	s.mu.Lock()
	previous := s.watcher
	s.watcher = watcher
	s.mu.Unlock()
	s.forward(watcher)
	if previous != nil {
		_ = previous.Close()
	}

	for _, event := range []watch.InvalidationKind{watch.InvalidateSnapshot, watch.InvalidateGraph} {
		select {
		case s.events <- event:
		default:
		}
	}
	return repo.Root, nil
}

func (s *repositorySession) revealRepository(context.Context) error {
	return browser.Reveal(s.adapter.current().Root)
}

func (s *repositorySession) close() error {
	s.mu.Lock()
	watcher := s.watcher
	s.watcher = nil
	s.mu.Unlock()
	if watcher == nil {
		return nil
	}
	return watcher.Close()
}
