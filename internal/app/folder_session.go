package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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

	refreshMu            sync.Mutex
	closed               bool
	mu                   sync.Mutex
	watcher              watch.Watcher
	watchID              uint64
	watchErr             error
	watchCancel          context.CancelFunc
	watchSetupDone       chan struct{}
	observedDirectories  map[string]struct{}
	observedDirectoryLRU []string
	setups               sync.WaitGroup
	forwards             sync.WaitGroup
	closeOnce            sync.Once
	closeErr             error
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
		ctx:                  sessionCtx,
		cancel:               cancel,
		runner:               runner,
		adapter:              &repoAdapter{ctx: sessionCtx, runner: runner, repo: repo, queue: gitx.NewMutationQueue()},
		events:               make(chan watch.InvalidationKind, 16),
		folders:              folders,
		newWatcher:           newWatcher,
		observedDirectories:  map[string]struct{}{"": {}},
		observedDirectoryLRU: []string{""},
	}
	s.adapter.observeDirectory = s.observeDirectory
	if !repo.IsGit() {
		s.adapter.startFileSearchIndex()
	}
	s.recordFolder(repo)
	s.startWatcher(repo)
	return s, nil
}

type startupCount struct {
	name  string
	value int
}

var startupTracePhases = map[string]struct{}{
	"activation-wait":        {},
	"catalog-persist":        {},
	"folder-resolve":         {},
	"folder-resolve-git":     {},
	"folder-resolve-symlink": {},
	"open-total":             {},
	"route-reserve":          {},
	"watcher-degraded":       {},
	"watcher-failed":         {},
	"watcher-ready":          {},
}

func traceStartup(phase string, duration time.Duration, counts ...startupCount) {
	if !server.StartupTraceEnabled() {
		return
	}
	if _, allowed := startupTracePhases[phase]; !allowed {
		return
	}
	fmt.Fprintf(os.Stderr, "gitna startup phase=%s duration_ms=%.2f", phase, float64(duration.Microseconds())/1000)
	for _, count := range counts {
		fmt.Fprintf(os.Stderr, " %s=%d", count.name, count.value)
	}
	fmt.Fprintln(os.Stderr)
}

func (s *folderSession) recordFolder(repo gitx.Repository) {
	if !server.StartupTraceEnabled() {
		s.folders.RecordDeferred(repo.Root, repo.IsGit())
		return
	}
	s.folders.RecordDeferredObserved(repo.Root, repo.IsGit(), func(duration time.Duration, _ error) {
		traceStartup("catalog-persist", duration)
	})
}

func (s *folderSession) startWatcher(repo gitx.Repository) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	if s.watchCancel != nil {
		s.watchCancel()
	}
	previousSetupDone := s.watchSetupDone
	setupCtx, cancel := context.WithCancel(s.ctx)
	setupDone := make(chan struct{})
	s.watchCancel = cancel
	s.watchSetupDone = setupDone
	s.watchID++
	id := s.watchID
	s.setups.Add(1)
	s.mu.Unlock()

	go func() {
		defer s.setups.Done()
		defer close(setupDone)
		if previousSetupDone != nil {
			select {
			case <-previousSetupDone:
			case <-setupCtx.Done():
				return
			}
		}
		if setupCtx.Err() != nil {
			return
		}

		started := time.Now()
		watcher, err := s.newWatcher(setupCtx, repo, s.runner, watch.Options{
			RootOnly:               !repo.IsGit(),
			MaxObservedDirectories: watch.DefaultMaxObservedDirectories,
			OnError: func(error) {
				traceStartup("watcher-degraded", 0)
			},
			OnReady: func(stats watch.SetupStats) {
				traceStartup(
					"watcher-ready",
					stats.WalkDuration,
					startupCount{name: "directories", value: stats.Directories},
					startupCount{name: "watches", value: stats.Watches},
					startupCount{name: "add-errors", value: stats.AddErrors},
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
		s.watchCancel = nil
		if err != nil {
			s.watchErr = err
			s.mu.Unlock()
			if !errors.Is(err, context.Canceled) {
				traceStartup("watcher-failed", elapsed)
			}
			// Watcher setup is an enhancement. Snapshot and explicit refresh APIs
			// remain usable even if the OS cannot allocate a watcher.
			return
		}
		previous := s.watcher
		s.watcher = watcher
		s.watchErr = nil
		observed := append([]string(nil), s.observedDirectoryLRU...)
		s.mu.Unlock()

		if observer, ok := watcher.(watch.DirectoryObserver); ok {
			for _, directory := range observed {
				_ = observer.ObserveDirectory(directory)
			}
		}
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

func (s *folderSession) observeDirectory(directory string) protocol.WatchCoverage {
	directory = strings.TrimSuffix(filepath.ToSlash(directory), "/")
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return protocol.WatchCoveragePartial
	}
	s.rememberObservedDirectoryLocked(directory)
	watcher := s.watcher
	s.mu.Unlock()
	observer, ok := watcher.(watch.DirectoryObserver)
	if !ok {
		return protocol.WatchCoveragePartial
	}
	if err := observer.ObserveDirectory(directory); err != nil {
		return protocol.WatchCoveragePartial
	}
	if observer.Coverage() == watch.CoverageComplete {
		return protocol.WatchCoverageComplete
	}
	return protocol.WatchCoveragePartial
}

func (s *folderSession) rememberObservedDirectoryLocked(directory string) {
	if _, exists := s.observedDirectories[directory]; exists {
		if directory == "" {
			return
		}
		for index := 1; index < len(s.observedDirectoryLRU); index++ {
			if s.observedDirectoryLRU[index] != directory {
				continue
			}
			copy(s.observedDirectoryLRU[index:], s.observedDirectoryLRU[index+1:])
			s.observedDirectoryLRU[len(s.observedDirectoryLRU)-1] = directory
			return
		}
	}
	for len(s.observedDirectoryLRU) >= watch.DefaultMaxObservedDirectories && len(s.observedDirectoryLRU) > 1 {
		oldest := s.observedDirectoryLRU[1]
		s.observedDirectoryLRU = append(s.observedDirectoryLRU[:1], s.observedDirectoryLRU[2:]...)
		delete(s.observedDirectories, oldest)
	}
	s.observedDirectories[directory] = struct{}{}
	s.observedDirectoryLRU = append(s.observedDirectoryLRU, directory)
}

func (s *folderSession) forward(watcher watch.Watcher) {
	s.forwards.Add(1)
	go func() {
		defer s.forwards.Done()
		for event := range watcher.Events() {
			s.adapter.invalidateFileSearch()
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
		if s.watchCancel != nil {
			s.watchCancel()
			s.watchCancel = nil
		}
		watcher := s.watcher
		s.watcher = nil
		s.mu.Unlock()
		s.cancel()
		s.refreshMu.Unlock()

		// Wait for a context-aware setup walk to observe cancellation before
		// closing the installed watcher and event source.
		s.setups.Wait()
		s.adapter.invalidateFileSearch()
		s.folders.Flush()
		if watcher != nil {
			s.closeErr = watcher.Close()
		}
		s.forwards.Wait()
		close(s.events)
	})
	return s.closeErr
}
