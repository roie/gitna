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

// folderSession keeps the HTTP capability URL stable while the user
// explicitly switches the repository behind it. The adapter and watcher are
// replaced together; the public events channel remains stable for existing SSE
// clients.
type folderSession struct {
	ctx     context.Context
	runner  *gitx.ExecRunner
	adapter *repoAdapter
	events  chan watch.InvalidationKind
	folders *folder.Catalog

	switchMu sync.Mutex
	mu       sync.Mutex
	watcher  watch.Watcher
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
	go func() {
		for event := range watcher.Events() {
			select {
			case s.events <- event:
			default:
			}
		}
	}()
}

func (s *folderSession) openFolder(ctx context.Context, path string) (string, error) {
	s.switchMu.Lock()
	defer s.switchMu.Unlock()

	repo, err := gitx.OpenFolder(ctx, s.runner, path)
	if err != nil {
		return "", fmt.Errorf("open folder: %w", err)
	}
	current := s.adapter.current()
	if repo.Root == current.Root && repo.IsGit() == current.IsGit() {
		s.folders.Record(repo.Root, repo.IsGit())
		return repo.Root, nil
	}

	watcher, err := watch.New(s.ctx, repo, s.runner, watch.Options{})
	if err != nil {
		return "", fmt.Errorf("watch folder: %w", err)
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

	s.folders.Record(repo.Root, repo.IsGit())
	events := []watch.InvalidationKind{watch.InvalidateSnapshot}
	if repo.IsGit() {
		events = append(events, watch.InvalidateGraph)
	}
	for _, event := range events {
		select {
		case s.events <- event:
		default:
		}
	}
	return repo.Root, nil
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
		if entry.Path == currentRoot {
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
	s.mu.Lock()
	watcher := s.watcher
	s.watcher = nil
	s.mu.Unlock()
	if watcher == nil {
		return nil
	}
	return watcher.Close()
}
