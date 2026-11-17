package conversations

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"sync"

	"github.com/fsnotify/fsnotify"
)

// Library opens one Store per worktree below a private base directory.
type Library struct {
	dir       string
	mu        sync.Mutex
	stores    map[string]*Store
	watcher   *fsnotify.Watcher
	watchDone chan struct{}
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
	if l.watcher == nil {
		if err := os.MkdirAll(l.dir, 0o700); err != nil {
			return nil, err
		}
		watcher, err := fsnotify.NewWatcher()
		if err != nil {
			return nil, err
		}
		if err := watcher.Add(l.dir); err != nil {
			watcher.Close()
			return nil, err
		}
		l.watcher = watcher
		l.watchDone = make(chan struct{})
		go l.watch()
	}
	sum := sha256.Sum256([]byte(key))
	dir := filepath.Join(l.dir, hex.EncodeToString(sum[:12]))
	store, err := Open(dir)
	if err != nil {
		return nil, err
	}
	store.worktree = key
	if err := l.watcher.Add(dir); err != nil && !errors.Is(err, os.ErrNotExist) {
		store.Close()
		return nil, err
	}
	l.stores[key] = store
	store.Touch()
	return store, nil
}

func (l *Library) watch() {
	defer close(l.watchDone)
	for {
		select {
		case event, ok := <-l.watcher.Events:
			if !ok {
				return
			}
			l.mu.Lock()
			for _, store := range l.stores {
				if event.Name == store.dir && event.Has(fsnotify.Create) {
					l.watcher.Add(store.dir)
					store.Touch()
				} else if filepath.Dir(event.Name) == store.dir {
					store.Touch()
				}
			}
			l.mu.Unlock()
		case _, ok := <-l.watcher.Errors:
			if !ok {
				return
			}
			l.mu.Lock()
			for _, store := range l.stores {
				store.Touch()
			}
			l.mu.Unlock()
		}
	}
}

func (l *Library) Close() error {
	l.mu.Lock()
	var err error
	for key, store := range l.stores {
		err = errors.Join(err, store.Close())
		delete(l.stores, key)
	}
	watcher, done := l.watcher, l.watchDone
	l.mu.Unlock()
	if watcher != nil {
		err = errors.Join(err, watcher.Close())
		<-done
	}
	return err
}
