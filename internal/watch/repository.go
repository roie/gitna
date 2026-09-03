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
	// DefaultMaxObservedDirectories bounds ordinary-folder observation while
	// retaining the root watch. Sessions use the same limit for replay state.
	DefaultMaxObservedDirectories = 2_048

	// InvalidateSnapshot means the source-control snapshot may have changed.
	InvalidateSnapshot InvalidationKind = "snapshot-invalidated"
	// InvalidateFiles means worktree path membership changed. Consumers must
	// refresh both the source-control snapshot and file-tree structure.
	InvalidateFiles InvalidationKind = "files-invalidated"
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

	mu                  sync.Mutex
	closed              bool
	events              chan InvalidationKind
	closedCh            chan struct{}
	once                sync.Once
	observed            map[string]struct{}
	observedOrder       []string
	directorySignatures map[string][sha256.Size]byte
	budgetWatches       int
	coverage            Coverage
}

// New creates a watcher for git and starts its background loops. ctx and Close
// both stop the watcher; Close is idempotent.
func New(ctx context.Context, git gitx.Repository, runner gitx.Runner, opts Options) (*Repository, error) {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, fmt.Errorf("watch: create watcher: %w", err)
	}
	w := &Repository{
		git:                 git,
		fsw:                 fsw,
		opts:                opts,
		events:              make(chan InvalidationKind, 32),
		closedCh:            make(chan struct{}),
		observed:            make(map[string]struct{}),
		directorySignatures: make(map[string][sha256.Size]byte),
		coverage:            CoverageComplete,
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
		w.touchObservedLocked(full)
		return nil
	}
	limit := w.opts.MaxObservedDirectories
	if limit <= 0 {
		limit = DefaultMaxObservedDirectories
	}
	for len(w.observed) >= limit && len(w.observedOrder) > 1 {
		oldest := w.observedOrder[1]
		w.observedOrder = append(w.observedOrder[:1], w.observedOrder[2:]...)
		delete(w.observed, oldest)
		delete(w.directorySignatures, oldest)
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
	w.rememberDirectoryLocked(full)
	if stats != nil {
		stats.Directories++
		stats.Watches++
	}
	return nil
}

func (w *Repository) touchObservedLocked(full string) {
	root := filepath.Clean(w.git.Root)
	if full == root {
		return
	}
	for index := 1; index < len(w.observedOrder); index++ {
		if w.observedOrder[index] != full {
			continue
		}
		copy(w.observedOrder[index:], w.observedOrder[index+1:])
		w.observedOrder[len(w.observedOrder)-1] = full
		return
	}
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

// emit forwards an invalidation without blocking. If the bounded queue fills,
// it is compacted by semantic impact: file invalidation subsumes snapshot
// invalidation, while graph invalidation remains independent.
func (w *Repository) emit(k InvalidationKind) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	select {
	case w.events <- k:
		return
	default:
	}

	pending := map[InvalidationKind]bool{k: true}
	for {
		select {
		case queued := <-w.events:
			pending[queued] = true
		default:
			if pending[InvalidateFiles] {
				delete(pending, InvalidateSnapshot)
			}
			for _, kind := range []InvalidationKind{InvalidateFiles, InvalidateSnapshot, InvalidateGraph} {
				if pending[kind] {
					w.events <- kind
				}
			}
			return
		}
	}
}

// addWorktreeWatches registers every directory under the worktree root,
// skipping the Git metadata directory. Missing watches for newly created
// directories are added from the event loop.
func (w *Repository) addWorktreeWatches(ctx context.Context, stats *SetupStats) error {
	if w.opts.RootOnly {
		w.mu.Lock()
		defer w.mu.Unlock()
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
			w.mu.Lock()
			w.rememberDirectoryLocked(p)
			w.mu.Unlock()
		}
		return nil
	})
	return err
}

// addGitWatches observes per-worktree metadata (HEAD and index) plus shared
// metadata (loose refs and packed-refs). In a linked worktree these live under
// different directories.
func (w *Repository) addGitWatches(ctx context.Context, stats *SetupStats) error {
	watched := make(map[string]struct{})
	for _, path := range w.fsw.WatchList() {
		watched[filepath.Clean(path)] = struct{}{}
	}
	add := func(path string) {
		path = filepath.Clean(path)
		if _, exists := watched[path]; exists {
			return
		}
		stats.Directories++
		if err := w.fsw.Add(path); err != nil {
			stats.AddErrors++
			if w.opts.OnError != nil {
				w.opts.OnError(err)
			}
		} else {
			watched[path] = struct{}{}
			stats.Watches++
		}
	}
	add(w.git.GitDir)
	common := w.git.GitCommonDir()
	add(common)
	refs := filepath.Join(common, "refs")
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
// internals are ignored except the shared refs tree.
func (w *Repository) shouldWatchDir(p string) bool {
	if filepath.Base(p) == ".git" {
		return false
	}
	if !w.isGitMetadataPath(p) {
		return true
	}
	rel, err := filepath.Rel(w.git.GitCommonDir(), p)
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
		pending        map[InvalidationKind]bool
		structuralDirs map[string]struct{}
		quietTimer     *time.Timer
		quietC         <-chan time.Time
		maxTimer       *time.Timer
		maxC           <-chan time.Time
	)

	flush := func() {
		if len(pending) == 0 {
			return
		}
		if len(structuralDirs) > 0 && w.worktreeStructureChanged(structuralDirs) {
			pending[InvalidateFiles] = true
			delete(pending, InvalidateSnapshot)
		}
		structuralDirs = nil
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
			kinds := w.classify(ev)
			for _, k := range kinds {
				mark(k)
			}
			if len(kinds) > 0 && w.isInsideWorktree(ev.Name) && !w.isGitDirPath(ev.Name) &&
				ev.Op&(fsnotify.Create|fsnotify.Remove|fsnotify.Rename) != 0 {
				if structuralDirs == nil {
					structuralDirs = make(map[string]struct{})
				}
				structuralDirs[filepath.Dir(filepath.Clean(ev.Name))] = struct{}{}
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
						if err := w.fsw.Add(path); err != nil {
							if w.opts.OnError != nil {
								w.opts.OnError(err)
							}
						} else {
							w.mu.Lock()
							w.rememberDirectoryLocked(path)
							w.mu.Unlock()
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
				// Overflow means events were lost. Reinstall any directory watches
				// whose creation may have been missed and conservatively reconcile
				// both independent state domains.
				stats := SetupStats{}
				_ = w.addWorktreeWatches(ctx, &stats)
				_ = w.addGitWatches(ctx, &stats)
				mark(InvalidateFiles)
				mark(InvalidateGraph)
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
		if err == nil {
			rel = filepath.ToSlash(rel)
			switch rel {
			case "index":
				return []InvalidationKind{InvalidateSnapshot}
			case "HEAD":
				return []InvalidationKind{InvalidateSnapshot, InvalidateGraph}
			}
		}
	}
	if w.isGitCommonDirPath(name) {
		rel, err := filepath.Rel(w.git.GitCommonDir(), name)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		switch {
		case rel == "packed-refs", rel == "refs" || strings.HasPrefix(rel, "refs/"):
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

func (w *Repository) rememberDirectoryLocked(path string) {
	signature, err := directorySignature(path)
	if err != nil {
		delete(w.directorySignatures, filepath.Clean(path))
		return
	}
	w.directorySignatures[filepath.Clean(path)] = signature
}

func (w *Repository) worktreeStructureChanged(directories map[string]struct{}) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	changed := false
	for directory := range directories {
		directory = filepath.Clean(directory)
		current, err := directorySignature(directory)
		previous, known := w.directorySignatures[directory]
		if err != nil {
			delete(w.directorySignatures, directory)
			changed = true
			continue
		}
		if !known || previous != current {
			changed = true
		}
		w.directorySignatures[directory] = current
	}
	return changed
}

func directorySignature(path string) ([sha256.Size]byte, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		return [sha256.Size]byte{}, err
	}
	hash := sha256.New()
	for _, entry := range entries {
		_, _ = hash.Write([]byte(entry.Name()))
		_, _ = hash.Write([]byte{0})
		_, _ = hash.Write([]byte(entry.Type().String()))
		_, _ = hash.Write([]byte{0})
	}
	var signature [sha256.Size]byte
	copy(signature[:], hash.Sum(nil))
	return signature, nil
}

func pathWithin(root, path string) bool {
	root = filepath.Clean(root)
	path = filepath.Clean(path)
	return path == root || strings.HasPrefix(path, root+string(filepath.Separator))
}

func (w *Repository) isGitDirPath(p string) bool {
	return w.git.IsGit() && pathWithin(w.git.GitDir, p)
}

func (w *Repository) isGitCommonDirPath(p string) bool {
	return w.git.IsGit() && pathWithin(w.git.GitCommonDir(), p)
}

func (w *Repository) isGitMetadataPath(p string) bool {
	return w.isGitDirPath(p) || w.isGitCommonDirPath(p)
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

// fallback periodically compares logical repository state so it can recover
// when filesystem notifications are missed. Worktree and ref state remain
// separate to avoid recounting Explorer for a ref-only change.
func (w *Repository) fallback(ctx context.Context, runner gitx.Runner) {
	interval := w.opts.FallbackInterval
	if interval == 0 {
		interval = 10 * time.Second
	}
	if interval < 0 {
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	if w.opts.Fingerprint != nil {
		last, initialErr := w.opts.Fingerprint(ctx)
		haveLast := initialErr == nil
		for {
			select {
			case <-ctx.Done():
				return
			case <-w.closedCh:
				return
			case <-ticker.C:
				current, err := w.opts.Fingerprint(ctx)
				if err != nil {
					continue
				}
				if haveLast && current != last {
					w.emit(InvalidateFiles)
				}
				last, haveLast = current, true
			}
		}
	}

	last, initialErr := repositoryFingerprint(ctx, runner, w.git.Root)
	haveLast := initialErr == nil
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.closedCh:
			return
		case <-ticker.C:
			current, err := repositoryFingerprint(ctx, runner, w.git.Root)
			if err != nil {
				continue
			}
			if haveLast && current.worktree != last.worktree {
				w.emit(InvalidateFiles)
			}
			if haveLast && current.graph != last.graph {
				w.emit(InvalidateSnapshot)
				w.emit(InvalidateGraph)
			}
			last, haveLast = current, true
		}
	}
}

type repositoryStateFingerprint struct {
	worktree string
	graph    string
}

func repositoryFingerprint(ctx context.Context, runner gitx.Runner, root string) (repositoryStateFingerprint, error) {
	worktree, err := fingerprint(ctx, runner, root)
	if err != nil {
		return repositoryStateFingerprint{}, err
	}

	hash := sha256.New()
	for _, command := range [][]string{
		{"symbolic-ref", "--quiet", "HEAD"},
		{"rev-parse", "--verify", "HEAD"},
		{"for-each-ref", "--sort=refname", "--format=%(refname)%00%(objectname)%00%(symref)"},
	} {
		res, runErr := runner.Run(ctx, root, command...)
		if runErr != nil {
			return repositoryStateFingerprint{}, runErr
		}
		// symbolic-ref and rev-parse legitimately fail for detached and unborn
		// HEAD states; their exit status is part of the fingerprint.
		if res.ExitCode != 0 && command[0] == "for-each-ref" {
			return repositoryStateFingerprint{}, fmt.Errorf("watch: fingerprint refs failed: %s", strings.TrimSpace(string(res.Stderr)))
		}
		_, _ = fmt.Fprintf(hash, "%s\x00%d\x00", command[0], res.ExitCode)
		_, _ = hash.Write(res.Stdout)
		_, _ = hash.Write([]byte{0})
	}
	return repositoryStateFingerprint{worktree: worktree, graph: fmt.Sprintf("%x", hash.Sum(nil))}, nil
}

func fingerprint(ctx context.Context, runner gitx.Runner, root string) (string, error) {
	res, err := runner.Run(ctx, root, "status", "--porcelain=v2", "-z")
	if err != nil {
		return "", err
	}
	if res.ExitCode != 0 {
		return "", fmt.Errorf("watch: fingerprint status failed: %s", strings.TrimSpace(string(res.Stderr)))
	}
	sum := sha256.Sum256(res.Stdout)
	return fmt.Sprintf("%x", sum), nil
}
