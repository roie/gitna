package server

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"sync/atomic"

	"github.com/roie/gitna/internal/protocol"
	"github.com/roie/gitna/internal/watch"
)

// Repo provides repository state and mutations to the API handlers. Mutations
// are individually atomic; callers that need ordering across requests use the
// shared mutation queue wired at the app layer.
type Repo interface {
	Snapshot(ctx context.Context) (protocol.RepoSnapshot, error)
	RepositoryFiles(ctx context.Context, after string, limit int) (protocol.RepositoryFiles, error)
	Diff(ctx context.Context, scope protocol.DiffScope, opts protocol.DiffOptions) (protocol.FileDiff, error)
	Review(ctx context.Context, scope protocol.DiffScope, opts protocol.DiffOptions, after string) (protocol.ReviewPage, error)
	History(ctx context.Context, skip, limit int) ([]protocol.GraphCommit, error)
	FilesChanged(ctx context.Context, oid string) (protocol.CommitFiles, error)
	CommitFile(ctx context.Context, oid, path string, before bool) (protocol.FileDiff, error)
	Branches(ctx context.Context) ([]protocol.Branch, error)
	StagePaths(ctx context.Context, paths []string) error
	UnstagePaths(ctx context.Context, paths []string) error
	DiscardTracked(ctx context.Context, paths []string) error
	DeleteUntracked(ctx context.Context, paths []string) error
	StagePatch(ctx context.Context, patch []byte) error
	UnstagePatch(ctx context.Context, patch []byte) error
	Commit(ctx context.Context, req protocol.CommitRequest) (protocol.OperationResult, error)
	CreateBranch(ctx context.Context, name, start string) error
	SwitchBranch(ctx context.Context, name string) error
	DeleteBranch(ctx context.Context, name string, force bool) error
	Fetch(ctx context.Context) error
	Pull(ctx context.Context) error
	Push(ctx context.Context) error
	PushSetUpstream(ctx context.Context, remote, branch string) error
	Stashes(ctx context.Context) ([]protocol.StashEntry, error)
	StashPush(ctx context.Context, message string, includeUntracked bool) error
	StashApply(ctx context.Context, ref string) error
	StashPop(ctx context.Context, ref string) error
	StashDrop(ctx context.Context, ref string) error
	Tags(ctx context.Context) ([]protocol.Tag, error)
	CreateTag(ctx context.Context, name, target, message string) error
	DeleteTag(ctx context.Context, name string) error
	PushTag(ctx context.Context, remote, name string) error
	CherryPick(ctx context.Context, oid string) error
	CherryPickAbort(ctx context.Context) error
	CherryPickContinue(ctx context.Context) error
	Revert(ctx context.Context, oid string) error
	RevertAbort(ctx context.Context) error
	RevertContinue(ctx context.Context) error
	Reset(ctx context.Context, target, mode string) error
	CompareFiles(ctx context.Context, from, to string) ([]protocol.CommitFile, error)
	Conflicts(ctx context.Context) ([]protocol.ConflictEntry, error)
	Merge(ctx context.Context, branch string) error
	MergeAbort(ctx context.Context) error
	MergeContinue(ctx context.Context) error
	Rebase(ctx context.Context, upstream string) error
	RebaseAbort(ctx context.Context) error
	RebaseContinue(ctx context.Context) error
	ResolveConflict(ctx context.Context, path string, theirs bool) error
	ResolveConflictBoth(ctx context.Context, path string) error
}

// Options carries server configuration.
type Options struct {
	// Version identifies the running Gitna binary.
	Version string
	// Token is the capability token required in every session URL. When empty,
	// the server rejects all requests.
	Token string
	// Host is the only permitted Host header, e.g. "127.0.0.1:PORT".
	Host string
	// Repo supplies repository state. When nil, snapshot routes return 503.
	Repo Repo
	// Events streams repository invalidation kinds. When nil, the events
	// endpoint closes its stream immediately.
	Events <-chan watch.InvalidationKind
	// InitialGeneration seeds repository generation when reviving a dormant
	// route. Values below one use generation one.
	InitialGeneration uint64
	// OnEventSubscribersChanged observes SSE subscriber connections and
	// disconnections. The callback receives +1 or -1.
	OnEventSubscribersChanged func(int)
	// OpenFolder validates a folder and returns its stable capability-relative route.
	OpenFolder func(context.Context, string) (protocol.OpenFolderResult, error)
	// RevealFolder opens the current repository in the platform file manager.
	RevealFolder func(context.Context) error
	// Folders returns the active and bounded recent folder catalog.
	Folders func() protocol.FolderCatalog
	// RemoveRecentFolder removes one path from shared recent-folder history.
	RemoveRecentFolder func(context.Context, string) error
}

// Server serves the embedded frontend and the repository API.
type Server struct {
	static             fs.FS
	version            string
	api                http.Handler
	security           Security
	repo               Repo
	hub                *eventsHub
	gen                atomic.Uint64
	openFolder         func(context.Context, string) (protocol.OpenFolderResult, error)
	revealFolder       func(context.Context) error
	folders            func() protocol.FolderCatalog
	removeRecentFolder func(context.Context, string) error
}

// New creates a Server that serves static assets from staticFS (rooted at the
// frontend build output) with SPA fallback to index.html for extensionless
// non-API GET routes. /api/ misses return JSON 404.
func New(staticFS fs.FS, opts Options) (*Server, error) {
	if staticFS == nil {
		return nil, errors.New("server: nil static filesystem")
	}
	version := opts.Version
	if version == "" {
		version = "dev"
	}
	s := &Server{
		static:             staticFS,
		version:            version,
		repo:               opts.Repo,
		openFolder:         opts.OpenFolder,
		revealFolder:       opts.RevealFolder,
		folders:            opts.Folders,
		removeRecentFolder: opts.RemoveRecentFolder,
		security: Security{
			Token: opts.Token,
			Host:  opts.Host,
		},
	}
	// Generation identifies known repository state. Reads keep it stable;
	// successful mutations and watcher invalidations advance it.
	generation := opts.InitialGeneration
	if generation < 1 {
		generation = 1
	}
	s.gen.Store(generation)
	s.hub = newEventsHub(opts.Events, opts.OnEventSubscribersChanged)
	s.hub.start(func(watch.InvalidationKind) {
		s.gen.Add(1)
	})
	s.api = s.apiRoutes()
	return s, nil
}

// Handler returns the root handler for the server. When a capability token is
// configured, requests must pass the session security boundary first.
func (s *Server) Handler() http.Handler {
	return s.security.Wrap(http.HandlerFunc(s.ServeHTTP))
}

// Generation returns the current route-scoped repository generation.
func (s *Server) Generation() uint64 {
	return s.gen.Load()
}

// WaitEvents waits for the route-scoped invalidation stream to finish after
// its source is closed.
func (s *Server) WaitEvents() {
	s.hub.wait()
}

// ServeHTTP routes requests between the static frontend and the API surface.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		s.api.ServeHTTP(w, r)
		return
	}
	s.serveStatic(w, r)
}

func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "." {
		name = "index.html"
	}

	// SPA fallback: extensionless routes that are not real files serve the
	// application shell. Missing files with an extension stay 404 so bad
	// asset URLs do not silently return HTML.
	if !strings.HasSuffix(name, "/") && path.Ext(name) == "" {
		name = "index.html"
	}

	data, err := fs.ReadFile(s.static, name)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	if ct := mime.TypeByExtension(path.Ext(name)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
