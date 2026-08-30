package folder

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	DefaultRecentLimit = 20
	maxStateBytes      = 64 << 10
	stateVersion       = 1
)

// Entry describes one local folder known to Gitna. Repository identifies
// folders where Gitna can enable its Git-specific workbench.
type Entry struct {
	Path       string    `json:"path"`
	Name       string    `json:"name"`
	Repository bool      `json:"repository"`
	LastOpened time.Time `json:"lastOpened"`
}

type state struct {
	Version int     `json:"version"`
	Recent  []Entry `json:"recent"`
}

// Catalog keeps a bounded most-recently-used folder list in memory and, when
// configured with a path, persists it using atomic replacement. Persistence is
// auxiliary: failures are retained for diagnostics without preventing Gitna
// from opening or switching repositories.
type Catalog struct {
	mu                sync.RWMutex
	path              string
	limit             int
	now               func() time.Time
	recent            []Entry
	lastErr           error
	persistMu         sync.Mutex
	persistScheduleMu sync.Mutex
	persistWG         sync.WaitGroup
}

// Open loads a catalog from path. A missing file starts an empty catalog.
// Malformed or inaccessible state is ignored and exposed through LastError.
func Open(path string, limit int) *Catalog {
	if limit <= 0 {
		limit = DefaultRecentLimit
	}
	catalog := &Catalog{path: path, limit: limit, now: time.Now, recent: make([]Entry, 0)}
	catalog.load()
	return catalog
}

// OpenDefault uses the operating system's per-user configuration directory.
func OpenDefault() *Catalog {
	dir, err := os.UserConfigDir()
	if err != nil {
		return &Catalog{
			limit:   DefaultRecentLimit,
			now:     time.Now,
			recent:  make([]Entry, 0),
			lastErr: err,
		}
	}
	return Open(filepath.Join(dir, "gitna", "folders.json"), DefaultRecentLimit)
}

// Record promotes path to the front of the catalog and persists the bounded
// result. The path must exist so symlink aliases can be normalized.
func (c *Catalog) Record(path string, repository bool) {
	c.record(path, repository, false, nil)
}

// RecordDeferred promotes path immediately and persists the latest catalog in
// the background. Route reservation uses this so auxiliary fsync latency never
// delays navigation; persistence remains serialized with Remove and Record.
func (c *Catalog) RecordDeferred(path string, repository bool) {
	c.record(path, repository, true, nil)
}

// RecordDeferredObserved is RecordDeferred with an optional local completion
// observer used by opt-in startup diagnostics.
func (c *Catalog) RecordDeferredObserved(
	path string,
	repository bool,
	done func(time.Duration, error),
) {
	c.record(path, repository, true, done)
}

func (c *Catalog) record(
	path string,
	repository bool,
	deferred bool,
	done func(time.Duration, error),
) {
	canonical, err := canonicalPath(path)
	if err != nil {
		c.setError(err)
		return
	}
	entry := Entry{
		Path:       canonical,
		Name:       folderName(canonical),
		Repository: repository,
		LastOpened: c.now().UTC(),
	}

	if !deferred {
		c.persistMu.Lock()
		defer c.persistMu.Unlock()
	}
	c.mu.Lock()
	next := make([]Entry, 0, min(c.limit, len(c.recent)+1))
	next = append(next, entry)
	for _, existing := range c.recent {
		if samePath(existing.Path, canonical) {
			continue
		}
		next = append(next, existing)
		if len(next) == c.limit {
			break
		}
	}
	c.recent = next
	if deferred {
		c.persistScheduleMu.Lock()
		c.persistWG.Add(1)
		c.persistScheduleMu.Unlock()
		c.mu.Unlock()
		go func() {
			defer c.persistWG.Done()
			started := time.Now()
			err := c.persistLatest()
			if done != nil {
				done(time.Since(started), err)
			}
		}()
		return
	}
	err = c.persistLocked()
	c.lastErr = err
	c.mu.Unlock()
}

// Flush waits for deferred persistence scheduled before the call.
func (c *Catalog) Flush() {
	c.persistScheduleMu.Lock()
	c.persistWG.Wait()
	c.persistScheduleMu.Unlock()
}

func (c *Catalog) persistLatest() error {
	c.persistMu.Lock()
	defer c.persistMu.Unlock()
	c.mu.RLock()
	path := c.path
	recent := append([]Entry(nil), c.recent...)
	c.mu.RUnlock()
	err := persistState(path, recent)
	c.mu.Lock()
	c.lastErr = err
	c.mu.Unlock()
	return err
}

// Remove deletes path from recent-folder history and atomically persists the
// result. It never removes or modifies the folder itself. Missing folders can
// still be removed by their last canonical absolute path.
func (c *Catalog) Remove(path string) error {
	canonical, err := canonicalRemovalPath(path)
	if err != nil {
		c.setError(err)
		return err
	}

	c.persistMu.Lock()
	defer c.persistMu.Unlock()
	c.mu.Lock()
	defer c.mu.Unlock()
	next := make([]Entry, 0, len(c.recent))
	for _, entry := range c.recent {
		if !samePath(entry.Path, canonical) {
			next = append(next, entry)
		}
	}
	if len(next) == len(c.recent) {
		return nil
	}
	previous := c.recent
	c.recent = next
	if err := c.persistLocked(); err != nil {
		c.recent = previous
		c.lastErr = err
		return err
	}
	c.lastErr = nil
	return nil
}

// Recent returns a copy ordered from most to least recently opened.
func (c *Catalog) Recent() []Entry {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return append([]Entry(nil), c.recent...)
}

// LastError reports the latest load or persistence failure.
func (c *Catalog) LastError() error {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.lastErr
}

func (c *Catalog) load() {
	if c.path == "" {
		return
	}
	file, err := os.Open(c.path)
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil {
		c.lastErr = err
		return
	}
	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, maxStateBytes+1))
	if err != nil {
		c.lastErr = err
		return
	}
	if len(data) > maxStateBytes {
		c.lastErr = fmt.Errorf("folder catalog: state exceeds %d bytes", maxStateBytes)
		return
	}
	var saved state
	if err := json.Unmarshal(data, &saved); err != nil {
		c.lastErr = err
		return
	}
	if saved.Version != stateVersion {
		c.lastErr = fmt.Errorf("folder catalog: unsupported version %d", saved.Version)
		return
	}

	seen := make(map[string]struct{}, len(saved.Recent))
	for _, entry := range saved.Recent {
		entry.Path = filepath.Clean(entry.Path)
		if !filepath.IsAbs(entry.Path) || entry.Path == "." {
			continue
		}
		key := PathKey(entry.Path)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		entry.Name = folderName(entry.Path)
		c.recent = append(c.recent, entry)
		if len(c.recent) == c.limit {
			break
		}
	}
	sort.SliceStable(c.recent, func(i, j int) bool {
		return c.recent[i].LastOpened.After(c.recent[j].LastOpened)
	})
}

func (c *Catalog) persistLocked() error {
	return persistState(c.path, c.recent)
}

func persistState(path string, recent []Entry) error {
	if path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(state{Version: stateVersion, Recent: recent}, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if len(data) > maxStateBytes {
		return fmt.Errorf("folder catalog: encoded state exceeds %d bytes", maxStateBytes)
	}

	dir := filepath.Dir(path)
	temporary, err := os.CreateTemp(dir, ".folders-")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}

	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer root.Close()
	return root.Rename(filepath.Base(temporaryPath), filepath.Base(path))
}

func (c *Catalog) setError(err error) {
	c.mu.Lock()
	c.lastErr = err
	c.mu.Unlock()
}

func canonicalPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	return filepath.Clean(resolved), nil
}

func canonicalRemovalPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err == nil {
		return filepath.Clean(resolved), nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}

	current := absolute
	missing := make([]string, 0, 1)
	for {
		parent := filepath.Dir(current)
		if parent == current {
			return filepath.Clean(absolute), nil
		}
		missing = append(missing, filepath.Base(current))
		current = parent
		resolved, err = filepath.EvalSymlinks(current)
		if err == nil {
			for index := len(missing) - 1; index >= 0; index-- {
				resolved = filepath.Join(resolved, missing[index])
			}
			return filepath.Clean(resolved), nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
	}
}

func folderName(path string) string {
	name := filepath.Base(path)
	if name == "." || name == string(filepath.Separator) {
		return path
	}
	return name
}

func samePath(left, right string) bool {
	return PathKey(left) == PathKey(right)
}

// PathKey returns the platform-normalized identity key used to deduplicate
// canonical folder paths. Existing folders on macOS use their filesystem
// identity so aliases differing only by case deduplicate on case-insensitive
// volumes without conflating distinct folders on case-sensitive volumes.
func PathKey(path string) string {
	cleaned := filepath.Clean(path)
	if key, ok := platformPathIdentity(cleaned); ok {
		return key
	}
	return pathKeyForOS(cleaned, runtime.GOOS)
}

func pathKeyForOS(path, goos string) string {
	key := filepath.Clean(path)
	if goos == "windows" {
		return strings.ToLower(key)
	}
	return key
}
