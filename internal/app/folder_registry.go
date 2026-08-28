package app

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/roie/gitna/internal/folder"
	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
	"github.com/roie/gitna/internal/server"
)

const defaultFolderDormancyGrace = 45 * time.Second

var errFolderRegistryClosed = errors.New("folder registry closed")

type dormancyTimer interface {
	Stop() bool
}

type folderRegistryOptions struct {
	dormancyGrace time.Duration
	afterFunc     func(time.Duration, func()) dormancyTimer
}

type folderRoute struct {
	route string
	root  string

	mu          sync.Mutex
	session     *folderSession
	server      *server.Server
	generation  uint64
	active      int
	subscribers int
	dormancy    dormancyTimer
	dormancyID  uint64
	transition  chan struct{}
	shutting    bool
	requests    sync.WaitGroup
}

// folderRegistry maps canonical folder roots to stable process-lifetime routes.
// Route metadata survives dormancy while heavyweight watchers and servers are
// revived lazily on the next request.
type folderRegistry struct {
	ctx      context.Context
	runner   *gitx.ExecRunner
	static   fs.FS
	version  string
	folders  *folder.Catalog
	basePath string

	dormancyGrace time.Duration
	afterFunc     func(time.Duration, func()) dormancyTimer
	closing       atomic.Bool

	mu           sync.RWMutex
	byRoot       map[string]string
	byRoute      map[string]*folderRoute
	initialRoute string
}

func newFolderRegistry(
	ctx context.Context,
	runner *gitx.ExecRunner,
	static fs.FS,
	version string,
	folders *folder.Catalog,
	basePath string,
	initial gitx.Repository,
	options ...folderRegistryOptions,
) (*folderRegistry, error) {
	config := folderRegistryOptions{
		dormancyGrace: defaultFolderDormancyGrace,
		afterFunc: func(delay time.Duration, callback func()) dormancyTimer {
			return time.AfterFunc(delay, callback)
		},
	}
	if len(options) > 0 {
		if options[0].dormancyGrace >= 0 {
			config.dormancyGrace = options[0].dormancyGrace
		}
		if options[0].afterFunc != nil {
			config.afterFunc = options[0].afterFunc
		}
	}
	r := &folderRegistry{
		ctx:           ctx,
		runner:        runner,
		static:        static,
		version:       version,
		folders:       folders,
		basePath:      strings.TrimSuffix(basePath, "/"),
		dormancyGrace: config.dormancyGrace,
		afterFunc:     config.afterFunc,
		byRoot:        make(map[string]string),
		byRoute:       make(map[string]*folderRoute),
	}
	r.mu.Lock()
	route, err := r.addLocked(initial)
	if err == nil {
		r.initialRoute = route
	}
	r.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return r, nil
}

func (r *folderRegistry) openFolder(ctx context.Context, path string) (protocol.OpenFolderResult, error) {
	if r.closing.Load() {
		return protocol.OpenFolderResult{}, errFolderRegistryClosed
	}
	repo, err := gitx.OpenFolder(ctx, r.runner, path)
	if err != nil {
		return protocol.OpenFolderResult{}, fmt.Errorf("open folder: %w", err)
	}

	rootKey := folder.PathKey(repo.Root)
	r.mu.RLock()
	route, exists := r.byRoot[rootKey]
	entry := r.byRoute[route]
	r.mu.RUnlock()
	if exists {
		if entry == nil {
			return protocol.OpenFolderResult{}, fmt.Errorf("open folder: route %q is unavailable", route)
		}
		if err := r.ensureActive(ctx, entry, &repo); err != nil {
			return protocol.OpenFolderResult{}, err
		}
		session, release, err := r.acquire(ctx, entry)
		if err != nil {
			return protocol.OpenFolderResult{}, err
		}
		err = session.refresh(ctx, repo)
		release()
		if err != nil {
			return protocol.OpenFolderResult{}, err
		}
		return protocol.OpenFolderResult{Root: repo.Root, Href: "../" + route + "/"}, nil
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if route, exists = r.byRoot[rootKey]; exists {
		entry = r.byRoute[route]
	} else {
		route, err = r.addLocked(repo)
		if err != nil {
			return protocol.OpenFolderResult{}, err
		}
		entry = r.byRoute[route]
	}
	if entry == nil {
		return protocol.OpenFolderResult{}, fmt.Errorf("open folder: route %q is unavailable", route)
	}
	return protocol.OpenFolderResult{Root: repo.Root, Href: "../" + route + "/"}, nil
}

func (r *folderRegistry) removeRecentFolder(_ context.Context, path string) error {
	return r.folders.Remove(path)
}

func (r *folderRegistry) addLocked(repo gitx.Repository) (string, error) {
	route := r.allocateRouteLocked(folderName(repo.Root))
	entry := &folderRoute{route: route, root: repo.Root, generation: 1}
	session, srv, err := r.createBackend(entry, repo, entry.generation)
	if err != nil {
		return "", err
	}
	entry.session = session
	entry.server = srv
	r.byRoot[folder.PathKey(repo.Root)] = route
	r.byRoute[route] = entry
	return route, nil
}

func (r *folderRegistry) createBackend(
	entry *folderRoute,
	repo gitx.Repository,
	generation uint64,
) (*folderSession, *server.Server, error) {
	session, err := newFolderSession(r.ctx, r.runner, repo, r.folders)
	if err != nil {
		return nil, nil, fmt.Errorf("create folder session: %w", err)
	}
	srv, err := server.New(r.static, server.Options{
		Version:                   r.version,
		Repo:                      session.adapter,
		Events:                    session.events,
		InitialGeneration:         generation,
		OnEventSubscribersChanged: func(delta int) { r.subscribersChanged(entry, delta) },
		OpenFolder:                r.openFolder,
		RevealFolder:              session.revealFolder,
		Folders:                   session.folderCatalog,
		RemoveRecentFolder:        r.removeRecentFolder,
	})
	if err != nil {
		_ = session.close()
		return nil, nil, fmt.Errorf("create folder server: %w", err)
	}
	return session, srv, nil
}

func (r *folderRegistry) ensureActive(
	ctx context.Context,
	entry *folderRoute,
	opened *gitx.Repository,
) error {
	for {
		entry.mu.Lock()
		r.cancelDormancyLocked(entry)
		if entry.shutting || r.closing.Load() {
			entry.mu.Unlock()
			return errFolderRegistryClosed
		}
		if entry.session != nil && entry.server != nil {
			entry.mu.Unlock()
			return nil
		}
		if entry.transition != nil {
			transition := entry.transition
			entry.mu.Unlock()
			select {
			case <-transition:
				continue
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		transition := make(chan struct{})
		entry.transition = transition
		root := entry.root
		generation := entry.generation
		entry.mu.Unlock()

		repo := gitx.Repository{}
		var err error
		if opened != nil && folder.PathKey(opened.Root) == folder.PathKey(root) {
			repo = *opened
		} else {
			repo, err = gitx.OpenFolder(ctx, r.runner, root)
		}
		var session *folderSession
		var srv *server.Server
		if err == nil {
			session, srv, err = r.createBackend(entry, repo, generation)
		}

		entry.mu.Lock()
		if err == nil && !entry.shutting && !r.closing.Load() {
			entry.root = repo.Root
			entry.session = session
			entry.server = srv
		} else if err == nil {
			err = errFolderRegistryClosed
		}
		entry.transition = nil
		close(transition)
		entry.mu.Unlock()
		if err != nil {
			if session != nil {
				_ = session.close()
			}
			return err
		}
		return nil
	}
}

func (r *folderRegistry) acquire(
	ctx context.Context,
	entry *folderRoute,
) (*folderSession, func(), error) {
	for {
		if err := r.ensureActive(ctx, entry, nil); err != nil {
			return nil, nil, err
		}
		entry.mu.Lock()
		if entry.shutting || r.closing.Load() {
			entry.mu.Unlock()
			return nil, nil, errFolderRegistryClosed
		}
		if entry.session == nil || entry.server == nil {
			entry.mu.Unlock()
			continue
		}
		r.cancelDormancyLocked(entry)
		entry.active++
		entry.requests.Add(1)
		session := entry.session
		entry.mu.Unlock()
		return session, func() { r.release(entry) }, nil
	}
}

func (r *folderRegistry) acquireServer(
	ctx context.Context,
	entry *folderRoute,
) (*server.Server, func(), error) {
	for {
		if err := r.ensureActive(ctx, entry, nil); err != nil {
			return nil, nil, err
		}
		entry.mu.Lock()
		if entry.shutting || r.closing.Load() {
			entry.mu.Unlock()
			return nil, nil, errFolderRegistryClosed
		}
		if entry.session == nil || entry.server == nil {
			entry.mu.Unlock()
			continue
		}
		r.cancelDormancyLocked(entry)
		entry.active++
		entry.requests.Add(1)
		srv := entry.server
		entry.mu.Unlock()
		return srv, func() { r.release(entry) }, nil
	}
}

func (r *folderRegistry) release(entry *folderRoute) {
	entry.mu.Lock()
	if entry.active > 0 {
		entry.active--
	}
	r.scheduleDormancyLocked(entry)
	entry.mu.Unlock()
	entry.requests.Done()
}

func (r *folderRegistry) subscribersChanged(entry *folderRoute, delta int) {
	entry.mu.Lock()
	if delta > 0 {
		entry.subscribers += delta
		r.cancelDormancyLocked(entry)
	} else {
		entry.subscribers += delta
		if entry.subscribers < 0 {
			entry.subscribers = 0
		}
		r.scheduleDormancyLocked(entry)
	}
	entry.mu.Unlock()
}

func (r *folderRegistry) cancelDormancyLocked(entry *folderRoute) {
	entry.dormancyID++
	if entry.dormancy != nil {
		entry.dormancy.Stop()
		entry.dormancy = nil
	}
}

func (r *folderRegistry) scheduleDormancyLocked(entry *folderRoute) {
	if entry.shutting || r.closing.Load() || entry.session == nil || entry.server == nil ||
		entry.active != 0 || entry.subscribers != 0 || entry.transition != nil || entry.dormancy != nil {
		return
	}
	entry.dormancyID++
	id := entry.dormancyID
	entry.dormancy = r.afterFunc(r.dormancyGrace, func() { r.retire(entry, id) })
}

func (r *folderRegistry) retire(entry *folderRoute, id uint64) {
	entry.mu.Lock()
	if entry.shutting || r.closing.Load() || entry.dormancyID != id ||
		entry.active != 0 || entry.subscribers != 0 || entry.transition != nil ||
		entry.session == nil || entry.server == nil {
		entry.mu.Unlock()
		return
	}
	transition := make(chan struct{})
	entry.transition = transition
	entry.dormancy = nil
	session := entry.session
	srv := entry.server
	entry.session = nil
	entry.server = nil
	entry.mu.Unlock()

	_ = session.close()
	srv.WaitEvents()

	entry.mu.Lock()
	entry.generation = srv.Generation() + 1
	entry.transition = nil
	close(transition)
	entry.mu.Unlock()
}

func (r *folderRegistry) allocateRouteLocked(name string) string {
	base := folderRouteSlug(name)
	if _, exists := r.byRoute[base]; !exists {
		return base
	}
	for suffix := 2; ; suffix++ {
		candidate := fmt.Sprintf("%s-%d", base, suffix)
		if _, exists := r.byRoute[candidate]; !exists {
			return candidate
		}
	}
}

func folderRouteSlug(name string) string {
	var slug strings.Builder
	separator := false
	for _, char := range strings.ToLower(name) {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') {
			slug.WriteRune(char)
			separator = false
			continue
		}
		if slug.Len() > 0 && !separator {
			slug.WriteByte('-')
			separator = true
		}
	}
	value := strings.Trim(slug.String(), "-")
	if value == "" || value == "api" || value == "g" {
		return "folder"
	}
	return value
}

func (r *folderRegistry) initialHref() string {
	return r.basePath + "/" + r.initialRoute + "/"
}

func (r *folderRegistry) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	if request.URL.Path == "/" {
		http.Redirect(w, request, r.initialHref(), http.StatusFound)
		return
	}
	trimmed := strings.TrimPrefix(request.URL.Path, "/")
	route, rest, found := strings.Cut(trimmed, "/")
	if !found {
		r.mu.RLock()
		_, exists := r.byRoute[route]
		r.mu.RUnlock()
		if exists {
			http.Redirect(w, request, r.basePath+"/"+route+"/", http.StatusFound)
			return
		}
		http.NotFound(w, request)
		return
	}

	r.mu.RLock()
	entry := r.byRoute[route]
	r.mu.RUnlock()
	if entry == nil {
		http.NotFound(w, request)
		return
	}
	srv, release, err := r.acquireServer(request.Context(), entry)
	if err != nil {
		if errors.Is(err, errFolderRegistryClosed) {
			http.Error(w, "service unavailable", http.StatusServiceUnavailable)
			return
		}
		http.Error(w, "folder unavailable", http.StatusServiceUnavailable)
		return
	}
	defer release()
	request.URL.Path = "/" + rest
	srv.ServeHTTP(w, request)
}

func (r *folderRegistry) close() error {
	if !r.closing.CompareAndSwap(false, true) {
		return nil
	}
	r.mu.RLock()
	entries := make([]*folderRoute, 0, len(r.byRoute))
	for _, entry := range r.byRoute {
		entries = append(entries, entry)
	}
	r.mu.RUnlock()

	for _, entry := range entries {
		entry.mu.Lock()
		entry.shutting = true
		r.cancelDormancyLocked(entry)
		entry.mu.Unlock()
	}
	for _, entry := range entries {
		entry.requests.Wait()
		for {
			entry.mu.Lock()
			if entry.transition == nil {
				session := entry.session
				srv := entry.server
				entry.session = nil
				entry.server = nil
				entry.mu.Unlock()
				if session != nil {
					_ = session.close()
				}
				if srv != nil {
					srv.WaitEvents()
				}
				break
			}
			transition := entry.transition
			entry.mu.Unlock()
			<-transition
		}
	}
	return nil
}
