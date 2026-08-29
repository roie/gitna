package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/roie/gitna/internal/browser"
	"github.com/roie/gitna/internal/folder"
	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
	"github.com/roie/gitna/internal/server"
	"github.com/roie/gitna/internal/watch"
)

var errFolderSessionClosed = errors.New("folder session closed")

type folderWatcherFactory func(
	context.Context,
	gitx.Repository,
	gitx.Runner,
	watch.Options,
) (watch.Watcher, error)

// folderSession owns one stable folder backend. The adapter is usable as soon
// as the session is created; recursive watcher installation is deliberately
// asynchronous so large folder walks never block route rendering or snapshots.
type folderSession struct {
	ctx        context.Context
	cancel     context.CancelFunc
	runner     *gitx.ExecRunner
	adapter    *repoAdapter
	events     chan watch.InvalidationKind
	folders    *folder.Catalog
	newWatcher folderWatcherFactory

	refreshMu sync.Mutex
	closed    bool
	mu        sync.Mutex
	watcher   watch.Watcher
	watchID   uint64
	watchErr  error
	setups    sync.WaitGroup
	forwards  sync.WaitGroup
	closeOnce sync.Once
	closeErr  error
}

func newFolderSession(
	ctx context.Context,
	runner *gitx.ExecRunner,
	repo gitx.Repository,
	folders *folder.Catalog,
	factories ...folderWatcherFactory,
) (*folderSession, error) {
	if folders == nil {
		folders = folder.Open("", folder.DefaultRecentLimit)
	}
	newWatcher := folderWatcherFactory(func(
		ctx context.Context,
		repo gitx.Repository,
		runner gitx.Runner,
		opts watch.Options,
	) (watch.Watcher, error) {
		watcher, err := watch.New(ctx, repo, runner, opts)
		if err != nil {
			return nil, err
		}
		return watcher, nil
	})
	if len(factories) > 0 && factories[0] != nil {
		newWatcher = factories[0]
	}
	sessionCtx, cancel := context.WithCancel(ctx)
	s := &folderSession{
		ctx:        sessionCtx,
		cancel:     cancel,
		runner:     runner,
		adapter:    &repoAdapter{runner: runner, repo: repo, queue: gitx.NewMutationQueue()},
		events:     make(chan watch.InvalidationKind, 16),
		folders:    folders,
		newWatcher: newWatcher,
	}
	s.recordFolder(repo)
	s.startWatcher(repo)
	return s, nil
}

func traceStartup(phase string, duration time.Duration, format string, args ...any) {
	if !server.StartupTraceEnabled() {
		return
	}
	detail := fmt.Sprintf(format, args...)
	fmt.Fprintf(os.Stderr, "gitna startup phase=%s duration_ms=%.2f %s\n", phase, float64(duration.Microseconds())/1000, detail)
}

func (s *folderSession) recordFolder(repo gitx.Repository) {
	if !server.StartupTraceEnabled() {
		s.folders.RecordDeferred(repo.Root, repo.IsGit())
		return
	}
	s.folders.RecordDeferredObserved(repo.Root, repo.IsGit(), func(duration time.Duration, err error) {
		if err != nil {
			traceStartup("catalog-persist", duration, "root=%q error=%q", repo.Root, err.Error())
			return
		}
		traceStartup("catalog-persist", duration, "root=%q", repo.Root)
	})
}

func (s *folderSession) startWatcher(repo gitx.Repository) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.watchID++
	id := s.watchID
	s.setups.Add(1)
	s.mu.Unlock()

	go func() {
		defer s.setups.Done()
		started := time.Now()
		watcher, err := s.newWatcher(s.ctx, repo, s.runner, watch.Options{
			OnError: func(err error) {
				if server.StartupTraceEnabled() {
					fmt.Fprintf(os.Stderr, "gitna startup phase=watcher-degraded error=%q\n", err.Error())
				}
			},
			OnReady: func(stats watch.SetupStats) {
				traceStartup(
					"watcher-ready",
					stats.WalkDuration,
					"directories=%d watches=%d add_errors=%d",
					stats.Directories,
					stats.Watches,
					stats.AddErrors,
				)
			},
		})
		elapsed := time.Since(started)

		s.mu.Lock()
		if s.closed || id != s.watchID {
			s.mu.Unlock()
			if watcher != nil {
				_ = watcher.Close()
			}
			return
		}
		if err != nil {
			s.watchErr = err
			s.mu.Unlock()
			if !errors.Is(err, context.Canceled) {
				traceStartup("watcher-failed", elapsed, "error=%q", err.Error())
			}
			// Watcher setup is an enhancement. Snapshot and explicit refresh APIs
			// remain usable even if the OS cannot allocate a watcher.
			return
		}
		previous := s.watcher
		s.watcher = watcher
		s.watchErr = nil
		s.mu.Unlock()

		s.forward(watcher)
		if previous != nil {
			_ = previous.Close()
		}
		// Reconcile once installation completes to cover changes made during
		// the initial recursive walk.
		for _, event := range []watch.InvalidationKind{watch.InvalidateSnapshot, watch.InvalidateGraph} {
			select {
			case s.events <- event:
			default:
			}
		}
	}()
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
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	if s.closed {
		return errFolderSessionClosed
	}
	current := s.adapter.current()
	if folder.PathKey(current.Root) != folder.PathKey(repo.Root) {
		return fmt.Errorf("refresh folder session: root changed from %q to %q", current.Root, repo.Root)
	}
	if current.IsGit() == repo.IsGit() {
		s.recordFolder(repo)
		return nil
	}

	// switchTo uses the existing mutation queue, so capability replacement waits
	// for any active mutation and cannot create a second queue for this folder.
	if err := s.adapter.switchTo(ctx, repo); err != nil {
		return fmt.Errorf("refresh folder adapter: %w", err)
	}
	s.startWatcher(repo)
	s.recordFolder(repo)
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
		s.refreshMu.Lock()
		s.mu.Lock()
		s.closed = true
		s.watchID++
		watcher := s.watcher
		s.watcher = nil
		s.mu.Unlock()
		s.cancel()
		s.refreshMu.Unlock()

		// Wait for a context-aware setup walk to observe cancellation before
		// closing the installed watcher and event source.
		s.setups.Wait()
		s.folders.Flush()
		if watcher != nil {
			s.closeErr = watcher.Close()
		}
		s.forwards.Wait()
		close(s.events)
	})
	return s.closeErr
}
