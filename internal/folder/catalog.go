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
	mu      sync.RWMutex
	path    string
	limit   int
	now     func() time.Time
	recent  []Entry
	lastErr error
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
	err = c.persistLocked()
	c.lastErr = err
	c.mu.Unlock()
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
		key := pathKey(entry.Path)
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
	if c.path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(c.path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(state{Version: stateVersion, Recent: c.recent}, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if len(data) > maxStateBytes {
		return fmt.Errorf("folder catalog: encoded state exceeds %d bytes", maxStateBytes)
	}

	dir := filepath.Dir(c.path)
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
	return root.Rename(filepath.Base(temporaryPath), filepath.Base(c.path))
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

func folderName(path string) string {
	name := filepath.Base(path)
	if name == "." || name == string(filepath.Separator) {
		return path
	}
	return name
}

func samePath(left, right string) bool {
	return pathKey(left) == pathKey(right)
}

func pathKey(path string) string {
	key := filepath.Clean(path)
	if runtime.GOOS == "windows" {
		return strings.ToLower(key)
	}
	return key
}
