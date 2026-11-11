package conversations

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"sync"
)

// Library opens one Store per worktree below a private base directory.
type Library struct {
	dir    string
	mu     sync.Mutex
	stores map[string]*Store
}

func NewLibrary(dir string) *Library {
	return &Library{dir: dir, stores: make(map[string]*Store)}
}

// Store returns the store for a canonical repository key, opening it once.
func (l *Library) Store(key string) (*Store, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if store := l.stores[key]; store != nil {
		return store, nil
	}
	sum := sha256.Sum256([]byte(key))
	dir := filepath.Join(l.dir, hex.EncodeToString(sum[:12]))
	store, err := Open(dir)
	if err != nil {
		return nil, err
	}
	// Names the worktree this log belongs to for people inspecting the directory.
	if err := os.WriteFile(filepath.Join(dir, "worktree"), []byte(key+"\n"), 0o600); err != nil {
		store.Close()
		return nil, err
	}
	l.stores[key] = store
	return store, nil
}

func (l *Library) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	for key, store := range l.stores {
		store.Close()
		delete(l.stores, key)
	}
	return nil
}
