package app

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"

	"github.com/roie/gitna/internal/browser"
	"github.com/roie/gitna/internal/folder"
	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
	"github.com/roie/gitna/internal/watch"
)

// folderSession owns one stable folder backend. Multiple browser documents for
// the same route share its watcher and mutation queue. If the folder gains or
// loses Git capabilities, refresh replaces the adapter target and watcher
// without changing either shared identity.
type folderSession struct {
	ctx     context.Context
	runner  *gitx.ExecRunner
	adapter *repoAdapter
	events  chan watch.InvalidationKind
	folders *folder.Catalog

	mu        sync.Mutex
	watcher   watch.Watcher
	forwards  sync.WaitGroup
	closeOnce sync.Once
	closeErr  error
}

func newFolderSession(
	ctx context.Context,
	runner *gitx.ExecRunner,
	repo gitx.Repository,
	folders *folder.Catalog,
) (*folderSession, error) {
	watcher, err := watch.New(ctx, repo, runner, watch.Options{})
	if err != nil {
		return nil, err
	}
	if folders == nil {
		folders = folder.Open("", folder.DefaultRecentLimit)
	}
	s := &folderSession{
		ctx:     ctx,
		runner:  runner,
		adapter: &repoAdapter{runner: runner, repo: repo, queue: gitx.NewMutationQueue()},
		events:  make(chan watch.InvalidationKind, 16),
		watcher: watcher,
		folders: folders,
	}
	s.folders.Record(repo.Root, repo.IsGit())
	s.forward(watcher)
	return s, nil
}

func (s *folderSession) forward(watcher watch.Watcher) {
	s.forwards.Add(1)
	go func() {
		defer s.forwards.Done()
		for event := range watcher.Events() {
			select {
			case s.events <- event:
			default:
			}
		}
	}()
}

func (s *folderSession) refresh(ctx context.Context, repo gitx.Repository) error {
	current := s.adapter.current()
	if folder.PathKey(current.Root) != folder.PathKey(repo.Root) {
		return fmt.Errorf("refresh folder session: root changed from %q to %q", current.Root, repo.Root)
	}
	if current.IsGit() == repo.IsGit() {
		s.folders.Record(repo.Root, repo.IsGit())
		return nil
	}

	watcher, err := watch.New(s.ctx, repo, s.runner, watch.Options{})
	if err != nil {
		return fmt.Errorf("refresh folder watcher: %w", err)
	}
	// switchTo uses the existing mutation queue, so capability replacement waits
	// for any active mutation and cannot create a second queue for this folder.
	if err := s.adapter.switchTo(ctx, repo); err != nil {
		_ = watcher.Close()
		return fmt.Errorf("refresh folder adapter: %w", err)
	}

	s.mu.Lock()
	previous := s.watcher
	s.watcher = watcher
	s.mu.Unlock()
	s.forward(watcher)
	if previous != nil {
		_ = previous.Close()
	}

	s.folders.Record(repo.Root, repo.IsGit())
	for _, event := range []watch.InvalidationKind{watch.InvalidateSnapshot, watch.InvalidateGraph} {
		select {
		case s.events <- event:
		default:
		}
	}
	return nil
}

func (s *folderSession) folderCatalog() protocol.FolderCatalog {
	active := s.adapter.current()
	currentRoot := active.Root
	entries := s.folders.Recent()
	recent := make([]protocol.Folder, 0, len(entries))
	current := protocol.Folder{Path: currentRoot, Name: folderName(currentRoot), Repository: active.IsGit()}
	for _, entry := range entries {
		item := protocol.Folder{
			Path:       entry.Path,
			Name:       entry.Name,
			Repository: entry.Repository,
			LastOpened: entry.LastOpened,
		}
		recent = append(recent, item)
		if folder.PathKey(entry.Path) == folder.PathKey(currentRoot) {
			current = item
		}
	}
	return protocol.FolderCatalog{Current: current, Recent: recent}
}

func folderName(path string) string {
	name := filepath.Base(path)
	if name == "." || name == string(filepath.Separator) {
		return path
	}
	return name
}

func (s *folderSession) revealFolder(context.Context) error {
	return browser.Reveal(s.adapter.current().Root)
}

func (s *folderSession) close() error {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		watcher := s.watcher
		s.watcher = nil
		s.mu.Unlock()
		if watcher != nil {
			s.closeErr = watcher.Close()
		}
		s.forwards.Wait()
		close(s.events)
	})
	return s.closeErr
}
