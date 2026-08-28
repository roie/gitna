package app

import (
	"context"
	"path/filepath"
	"sync"

	"github.com/roie/gitna/internal/browser"
	"github.com/roie/gitna/internal/folder"
	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
	"github.com/roie/gitna/internal/watch"
)

// folderSession owns one immutable folder backend. Multiple browser documents
// for the same stable route share its watcher and mutation queue.
type folderSession struct {
	adapter *repoAdapter
	events  chan watch.InvalidationKind
	folders *folder.Catalog
	watcher watch.Watcher

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
		adapter: &repoAdapter{runner: runner, repo: repo, queue: gitx.NewMutationQueue()},
		events:  make(chan watch.InvalidationKind, 16),
		watcher: watcher,
		folders: folders,
	}
	s.folders.Record(repo.Root, repo.IsGit())
	go s.forward()
	return s, nil
}

func (s *folderSession) forward() {
	defer close(s.events)
	for event := range s.watcher.Events() {
		select {
		case s.events <- event:
		default:
		}
	}
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
	s.closeOnce.Do(func() { s.closeErr = s.watcher.Close() })
	return s.closeErr
}
