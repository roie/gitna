package conversations

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"slices"
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
	closed    bool
	adds      sync.WaitGroup
}

func NewLibrary(dir string) *Library {
	return &Library{dir: dir, stores: make(map[string]*Store)}
}

// Store returns the store for a canonical repository key, opening it once.
func (l *Library) Store(key string) (*Store, error) {
	l.mu.Lock()
	store, opened, err := l.open(key)
	l.mu.Unlock()
	if err != nil || !opened {
		return store, err
	}
	if err := l.add(store.dir); err != nil && !errors.Is(err, os.ErrNotExist) {
		l.mu.Lock()
		delete(l.stores, key)
		l.mu.Unlock()
		store.Close()
		return nil, err
	}
	store.Touch()
	return store, nil
}

// open returns the registered store for key, reporting whether it registered
// a new one. The caller holds l.mu.
func (l *Library) open(key string) (*Store, bool, error) {
	if l.closed {
		return nil, false, os.ErrClosed
	}
	if store := l.stores[key]; store != nil {
		return store, false, nil
	}
	if l.watcher == nil {
		if err := os.MkdirAll(l.dir, 0o700); err != nil {
			return nil, false, err
		}
		watcher, err := fsnotify.NewWatcher()
		if err != nil {
			return nil, false, err
		}
		if err := watcher.Add(l.dir); err != nil {
			watcher.Close()
			return nil, false, err
		}
		l.watcher = watcher
		l.watchDone = make(chan struct{})
		go l.watch()
	}
	sum := sha256.Sum256([]byte(key))
	dir := filepath.Join(l.dir, hex.EncodeToString(sum[:12]))
	store, err := Open(dir)
	if err != nil {
		return nil, false, err
	}
	store.worktree = key
	l.stores[key] = store
	return store, true, nil
}

// add watches dir unless the library is closing. fsnotify serves Add from the
// goroutine that delivers Events, so add must not run while l.mu is held or
// on the goroutine draining Events, and must finish before watcher.Close.
func (l *Library) add(dir string) error {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return os.ErrClosed
	}
	l.adds.Add(1)
	defer l.adds.Done()
	watcher := l.watcher
	l.mu.Unlock()
	return watcher.Add(dir)
}

func (l *Library) watch() {
	defer close(l.watchDone)
	for {
		select {
		case event, ok := <-l.watcher.Events:
			if !ok {
				return
			}
			for _, store := range l.snapshot() {
				if event.Name == store.dir && event.Has(fsnotify.Create) {
					go func() {
						l.add(store.dir)
						store.Touch()
					}()
				} else if filepath.Dir(event.Name) == store.dir {
					store.Touch()
				}
			}
		case _, ok := <-l.watcher.Errors:
			if !ok {
				return
			}
			for _, store := range l.snapshot() {
				store.Touch()
			}
		}
	}
}

func (l *Library) snapshot() []*Store {
	l.mu.Lock()
	defer l.mu.Unlock()
	return slices.Collect(maps.Values(l.stores))
}

func (l *Library) Close() error {
	l.mu.Lock()
	l.closed = true
	var err error
	for key, store := range l.stores {
		err = errors.Join(err, store.Close())
		delete(l.stores, key)
	}
	watcher, done := l.watcher, l.watchDone
	l.mu.Unlock()
	l.adds.Wait()
	if watcher != nil {
		err = errors.Join(err, watcher.Close())
		<-done
	}
	return err
}
