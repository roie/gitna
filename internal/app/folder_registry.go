package app

import (
	"context"
	"fmt"
	"io/fs"
	"net/http"
	"strings"
	"sync"

	"github.com/roie/gitna/internal/folder"
	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
	"github.com/roie/gitna/internal/server"
)

type folderRoute struct {
	session *folderSession
	server  *server.Server
}

// folderRegistry maps canonical folder roots to stable process-lifetime routes.
type folderRegistry struct {
	ctx      context.Context
	runner   *gitx.ExecRunner
	static   fs.FS
	version  string
	folders  *folder.Catalog
	basePath string

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
) (*folderRegistry, error) {
	r := &folderRegistry{
		ctx:      ctx,
		runner:   runner,
		static:   static,
		version:  version,
		folders:  folders,
		basePath: strings.TrimSuffix(basePath, "/"),
		byRoot:   make(map[string]string),
		byRoute:  make(map[string]*folderRoute),
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
	repo, err := gitx.OpenFolder(ctx, r.runner, path)
	if err != nil {
		return protocol.OpenFolderResult{}, fmt.Errorf("open folder: %w", err)
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	rootKey := folder.PathKey(repo.Root)
	if route, ok := r.byRoot[rootKey]; ok {
		entry := r.byRoute[route]
		if entry == nil {
			return protocol.OpenFolderResult{}, fmt.Errorf("open folder: route %q is unavailable", route)
		}
		if err := entry.session.refresh(ctx, repo); err != nil {
			return protocol.OpenFolderResult{}, err
		}
		return protocol.OpenFolderResult{Root: repo.Root, Href: "../" + route + "/"}, nil
	}
	route, err := r.addLocked(repo)
	if err != nil {
		return protocol.OpenFolderResult{}, err
	}
	return protocol.OpenFolderResult{Root: repo.Root, Href: "../" + route + "/"}, nil
}

func (r *folderRegistry) removeRecentFolder(_ context.Context, path string) error {
	return r.folders.Remove(path)
}

func (r *folderRegistry) addLocked(repo gitx.Repository) (string, error) {
	session, err := newFolderSession(r.ctx, r.runner, repo, r.folders)
	if err != nil {
		return "", fmt.Errorf("create folder session: %w", err)
	}
	route := r.allocateRouteLocked(folderName(repo.Root))
	srv, err := server.New(r.static, server.Options{
		Version:            r.version,
		Repo:               session.adapter,
		Events:             session.events,
		OpenFolder:         r.openFolder,
		RevealFolder:       session.revealFolder,
		Folders:            session.folderCatalog,
		RemoveRecentFolder: r.removeRecentFolder,
	})
	if err != nil {
		_ = session.close()
		return "", fmt.Errorf("create folder server: %w", err)
	}
	r.byRoot[folder.PathKey(repo.Root)] = route
	r.byRoute[route] = &folderRoute{session: session, server: srv}
	return route, nil
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
	request.URL.Path = "/" + rest
	entry.server.ServeHTTP(w, request)
}

func (r *folderRegistry) close() error {
	r.mu.RLock()
	entries := make([]*folderRoute, 0, len(r.byRoute))
	for _, entry := range r.byRoute {
		entries = append(entries, entry)
	}
	r.mu.RUnlock()
	var first error
	for _, entry := range entries {
		if err := entry.session.close(); err != nil && first == nil {
			first = err
		}
	}
	return first
}
