// Package watch observes a Git repository and reports invalidation events so
// the frontend can refresh state without polling every change.
package watch

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/roie/gitna/internal/gitx"
)

// InvalidationKind names the events emitted when repository state changes.
type InvalidationKind string

const (
	// InvalidateSnapshot means the source-control snapshot may have changed.
	InvalidateSnapshot InvalidationKind = "snapshot-invalidated"
	// InvalidateGraph means branch topology may have changed (consumed by the
	// future graph view).
	InvalidateGraph InvalidationKind = "graph-invalidated"
)

// Watcher reports repository state invalidations.
type Watcher interface {
	// Events delivers invalidation kinds. The channel is closed by Close.
	Events() <-chan InvalidationKind
	Close() error
}

type Coverage string

const (
	CoverageComplete Coverage = "complete"
	CoveragePartial  Coverage = "partial"
)

// DirectoryObserver is implemented by watchers that can add bounded ordinary-
// folder observations after a directory is loaded in Explorer.
type DirectoryObserver interface {
	ObserveDirectory(path string) error
	Coverage() Coverage
}

// Options tunes Repository behavior. Zero values select defaults.
type SetupStats struct {
	WalkDuration time.Duration
	Directories  int
	Watches      int
	AddErrors    int
}

type Options struct {
	// Debounce is the quiet period before pending invalidations are emitted.
	// Zero means 250ms.
	Debounce time.Duration
	// FallbackInterval is how often the repository fingerprint is re-checked.
	// Zero means 10s; a negative value disables the fallback.
	FallbackInterval time.Duration
	// OnError receives non-fatal watcher errors. Zero means errors are
	// silently dropped.
	OnError func(error)
	// Fingerprint overrides the repository fingerprint function. Used by
	// tests; defaults to a hash of porcelain status.
	Fingerprint func(ctx context.Context) (string, error)
	// OnReady receives bounded setup counts after initial watch installation.
	OnReady func(SetupStats)
	// RootOnly avoids a recursive worktree walk. Loaded directories can be added
	// later through DirectoryObserver. Git metadata watches remain complete.
	RootOnly bool
	// MaxObservedDirectories bounds RootOnly observations. Zero means 2,048.
	MaxObservedDirectories int
}

// Repository watches one Git worktree plus its metadata and emits coalesced
// invalidation kinds. Watching the working tree recursively catches edits,
// while the index, HEAD, and refs are observed directly. A low-frequency
// fingerprint re-check covers events fsnotify may miss (for example when
// inotify watch limits are exceeded).
type Repository struct {
	git  gitx.Repository
	fsw  *fsnotify.Watcher
	opts Options

	mu            sync.Mutex
	closed        bool
	events        chan InvalidationKind
	closedCh      chan struct{}
	once          sync.Once
	observed      map[string]struct{}
	observedOrder []string
	budgetWatches int
	coverage      Coverage
}

// New creates a watcher for git and starts its background loops. ctx and Close
// both stop the watcher; Close is idempotent.
func New(ctx context.Context, git gitx.Repository, runner gitx.Runner, opts Options) (*Repository, error) {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, fmt.Errorf("watch: create watcher: %w", err)
	}
	w := &Repository{
		git:      git,
		fsw:      fsw,
		opts:     opts,
		events:   make(chan InvalidationKind, 32),
		closedCh: make(chan struct{}),
		observed: make(map[string]struct{}),
		coverage: CoverageComplete,
	}
	stats := SetupStats{}
	started := time.Now()
	if err := w.addWorktreeWatches(ctx, &stats); err != nil {
		_ = fsw.Close()
		return nil, err
	}
	if git.IsGit() {
		if err := w.addGitWatches(ctx, &stats); err != nil {
			_ = fsw.Close()
			return nil, err
		}
	}
	stats.WalkDuration = time.Since(started)
	if opts.OnReady != nil {
		opts.OnReady(stats)
	}
	go w.loop(ctx)
	if git.IsGit() {
		go w.fallback(ctx, runner)
	}
	return w, nil
}

// Events returns the stream of invalidation kinds. It is closed by Close.
func (w *Repository) Events() <-chan InvalidationKind { return w.events }

// Coverage reports whether the watcher observes the complete worktree. RootOnly
// mode is intentionally partial because unloaded directories refresh on open.
func (w *Repository) Coverage() Coverage {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.coverage
}

// ObserveDirectory adds one validated ordinary-folder directory to the bounded
// live watch set.
func (w *Repository) ObserveDirectory(relative string) error {
	if !w.opts.RootOnly {
		return nil
	}
	if relative == "" {
		relative = "."
	}
	if filepath.IsAbs(relative) || filepath.VolumeName(relative) != "" {
		return fmt.Errorf("watch: invalid observed directory %q", relative)
	}
	clean := filepath.Clean(filepath.FromSlash(relative))
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return fmt.Errorf("watch: observed directory escapes root")
	}
	full := filepath.Join(w.git.Root, clean)
	rootReal, err := filepath.EvalSymlinks(w.git.Root)
	if err != nil {
		return err
	}
	fullReal, err := filepath.EvalSymlinks(full)
	if err != nil {
		return err
	}
	if fullReal != rootReal && !strings.HasPrefix(fullReal, rootReal+string(filepath.Separator)) {
		return fmt.Errorf("watch: observed directory escapes root")
	}
	info, err := os.Lstat(full)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("watch: observed path is not a directory")
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return fs.ErrClosed
	}
	return w.observeDirectoryLocked(full, nil)
}

func (w *Repository) observeDirectoryLocked(full string, stats *SetupStats) error {
	full = filepath.Clean(full)
	if _, exists := w.observed[full]; exists {
		return nil
	}
	limit := w.opts.MaxObservedDirectories
	if limit <= 0 {
		limit = 2_048
	}
	for len(w.observed) >= limit && len(w.observedOrder) > 1 {
		oldest := w.observedOrder[1]
		w.observedOrder = append(w.observedOrder[:1], w.observedOrder[2:]...)
		delete(w.observed, oldest)
		_ = w.fsw.Remove(oldest)
		if w.budgetWatches > 0 {
			releaseOrdinaryWatchBudget(1)
			w.budgetWatches--
		}
	}
	budgeted := acquireOrdinaryWatchBudget()
	if !budgeted && full != filepath.Clean(w.git.Root) {
		w.coverage = CoveragePartial
		return fmt.Errorf("watch: ordinary folder watch budget exhausted")
	}
	if err := w.fsw.Add(full); err != nil {
		if budgeted {
			releaseOrdinaryWatchBudget(1)
		}
		w.coverage = CoveragePartial
		if w.opts.OnError != nil {
			w.opts.OnError(err)
		}
		return err
	}
	if budgeted {
		w.budgetWatches++
	}
	w.observed[full] = struct{}{}
	w.observedOrder = append(w.observedOrder, full)
	if stats != nil {
		stats.Directories++
		stats.Watches++
	}
	return nil
}

// Close stops observation and closes the Events channel. It is safe to call
// multiple times.
func (w *Repository) Close() error {
	var err error
	w.once.Do(func() {
		w.mu.Lock()
		w.closed = true
		close(w.events)
		w.mu.Unlock()
		close(w.closedCh)
		err = w.fsw.Close()
		if w.budgetWatches > 0 {
			releaseOrdinaryWatchBudget(w.budgetWatches)
			w.budgetWatches = 0
		}
	})
	return err
}

// emit forwards an invalidation without blocking. Under load events are
// dropped; the debounce and fingerprint fallback make this safe.
func (w *Repository) emit(k InvalidationKind) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	select {
	case w.events <- k:
	default:
	}
}

// addWorktreeWatches registers every directory under the worktree root,
// skipping the Git metadata directory. Missing watches for newly created
// directories are added from the event loop.
func (w *Repository) addWorktreeWatches(ctx context.Context, stats *SetupStats) error {
	if w.opts.RootOnly {
		w.coverage = CoveragePartial
		return w.observeDirectoryLocked(w.git.Root, stats)
	}
	err := filepath.WalkDir(w.git.Root, func(p string, d fs.DirEntry, err error) error {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if err != nil || !d.IsDir() {
			return nil
		}
		if d.Name() == ".git" || w.isGitDirPath(p) {
			return filepath.SkipDir
		}
		stats.Directories++
		if werr := w.fsw.Add(p); werr != nil {
			stats.AddErrors++
			if w.opts.OnError != nil {
				w.opts.OnError(werr)
			}
		} else {
			stats.Watches++
		}
		return nil
	})
	return err
}

// addGitWatches observes the Git metadata that affects status: the metadata
// directory itself (index, HEAD, packed-refs, config) and the refs tree
// (branch updates).
func (w *Repository) addGitWatches(ctx context.Context, stats *SetupStats) error {
	add := func(path string) {
		stats.Directories++
		if err := w.fsw.Add(path); err != nil {
			stats.AddErrors++
			if w.opts.OnError != nil {
				w.opts.OnError(err)
			}
		} else {
			stats.Watches++
		}
	}
	add(w.git.GitDir)
	refs := filepath.Join(w.git.GitDir, "refs")
	return filepath.WalkDir(refs, func(p string, d fs.DirEntry, err error) error {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		add(p)
		return nil
	})
}

// shouldWatchDir decides whether a newly created directory gets a watch. Git
// internals are ignored except the refs tree, which holds branch updates.
func (w *Repository) shouldWatchDir(p string) bool {
	if filepath.Base(p) == ".git" {
		return false
	}
	if !w.isGitDirPath(p) {
		return true
	}
	rel, err := filepath.Rel(w.git.GitDir, p)
	if err != nil {
		return false
	}
	rel = filepath.ToSlash(rel)
	return rel == "refs" || strings.HasPrefix(rel, "refs/")
}

// loop coalesces fsnotify events into debounced invalidation kinds.
func (w *Repository) loop(ctx context.Context) {
	debounce := w.opts.Debounce
	if debounce <= 0 {
		debounce = 250 * time.Millisecond
	}
	// maxWait bounds the quiet window so continuous change still flushes.
	const maxWait = 2 * time.Second

	var (
		pending    map[InvalidationKind]bool
		quietTimer *time.Timer
		quietC     <-chan time.Time
		maxTimer   *time.Timer
		maxC       <-chan time.Time
	)

	flush := func() {
		if len(pending) == 0 {
			return
		}
		if quietTimer != nil {
			quietTimer.Stop()
		}
		if maxTimer != nil {
			maxTimer.Stop()
		}
		quietTimer, maxTimer = nil, nil
		quietC, maxC = nil, nil
		for k := range pending {
			w.emit(k)
		}
		pending = nil
	}

	mark := func(k InvalidationKind) {
		if pending == nil {
			pending = map[InvalidationKind]bool{}
		}
		if len(pending) == 0 {
			quietTimer = time.NewTimer(debounce)
			quietC = quietTimer.C
			maxTimer = time.NewTimer(maxWait)
			maxC = maxTimer.C
		} else {
			quietTimer.Reset(debounce)
		}
		pending[k] = true
	}

	for {
		select {
		case <-ctx.Done():
			flush()
			return
		case <-w.closedCh:
			flush()
			return
		case ev, ok := <-w.fsw.Events:
			if !ok {
				flush()
				return
			}
			for _, k := range w.classify(ev) {
				mark(k)
			}
			if ev.Op&fsnotify.Create != 0 {
				if info, err := os.Stat(ev.Name); err == nil && info.IsDir() && w.shouldWatchDir(ev.Name) {
					if w.opts.RootOnly {
						relative, relErr := filepath.Rel(w.git.Root, ev.Name)
						if relErr == nil {
							_ = w.ObserveDirectory(filepath.ToSlash(relative))
						}
						continue
					}
					_ = filepath.WalkDir(ev.Name, func(path string, entry fs.DirEntry, err error) error {
						if ctxErr := ctx.Err(); ctxErr != nil {
							return ctxErr
						}
						if err != nil || !entry.IsDir() {
							return nil
						}
						if !w.shouldWatchDir(path) {
							return filepath.SkipDir
						}
						if err := w.fsw.Add(path); err != nil && w.opts.OnError != nil {
							w.opts.OnError(err)
						}
						return nil
					})
				}
			}
		case err, ok := <-w.fsw.Errors:
			if !ok {
				flush()
				return
			}
			if errors.Is(err, fsnotify.ErrEventOverflow) {
				mark(InvalidateSnapshot)
				continue
			}
			if w.opts.OnError != nil {
				w.opts.OnError(err)
			}
		case <-quietC:
			flush()
		case <-maxC:
			flush()
		}
	}
}

// classify maps a filesystem event to the invalidation kinds it implies.
func (w *Repository) classify(ev fsnotify.Event) []InvalidationKind {
	name := filepath.Clean(ev.Name)
	if strings.HasSuffix(name, ".lock") {
		return nil
	}
	if w.isGitDirPath(name) {
		rel, err := filepath.Rel(w.git.GitDir, name)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		switch {
		case rel == "index", rel == "HEAD", rel == "packed-refs":
			return []InvalidationKind{InvalidateSnapshot}
		case rel == "refs" || strings.HasPrefix(rel, "refs/"):
			return []InvalidationKind{InvalidateSnapshot, InvalidateGraph}
		default:
			return nil
		}
	}
	if w.isInsideWorktree(name) {
		return []InvalidationKind{InvalidateSnapshot}
	}
	return nil
}

func (w *Repository) isGitDirPath(p string) bool {
	if !w.git.IsGit() {
		return false
	}
	git := filepath.Clean(w.git.GitDir)
	return p == git || strings.HasPrefix(p, git+string(filepath.Separator))
}

func (w *Repository) isInsideWorktree(p string) bool {
	if p == w.git.Root {
		return true
	}
	rel, err := filepath.Rel(w.git.Root, p)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	return true
}

// fallback periodically compares a cheap repository fingerprint so state is
// eventually invalidated even when watcher events are lost. The fingerprint is
// porcelain status output, so a quiet repository does not trigger spurious
// invalidations.
func (w *Repository) fallback(ctx context.Context, runner gitx.Runner) {
	interval := w.opts.FallbackInterval
	if interval == 0 {
		interval = 10 * time.Second
	}
	if interval < 0 {
		return
	}
	fp := w.opts.Fingerprint
	if fp == nil {
		fp = func(ctx context.Context) (string, error) {
			return fingerprint(ctx, runner, w.git.Root)
		}
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	var last string
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.closedCh:
			return
		case <-ticker.C:
			current, err := fp(ctx)
			if err != nil {
				continue
			}
			if last == "" {
				last = current
				continue
			}
			if current != last {
				last = current
				w.emit(InvalidateSnapshot)
			}
		}
	}
}

func fingerprint(ctx context.Context, runner gitx.Runner, root string) (string, error) {
	res, err := runner.Run(ctx, root, "status", "--porcelain", "-z")
	if err != nil {
		return "", err
	}
	if res.ExitCode != 0 {
		return "", fmt.Errorf("watch: fingerprint status failed: %s", strings.TrimSpace(string(res.Stderr)))
	}
	sum := sha256.Sum256(res.Stdout)
	return fmt.Sprintf("%x", sum), nil
}
