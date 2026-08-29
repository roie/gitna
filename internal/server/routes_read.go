package server

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/roie/gitna/internal/protocol"
)

// timeoutReached checks whether a handler should return 504: either the
// context deadline actually expired, or the repo returned a context error
// directly (which our slowRepo tests do).
func timeoutReached(ctx context.Context, err error) bool {
	return ctx.Err() == context.DeadlineExceeded || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled)
}

// apiRoutes builds the versioned API router.
func (s *Server) apiRoutes() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/api/v1")
		switch {
		case r.Method == http.MethodGet && p == "/snapshot":
			s.handleSnapshot(w, r)
		case r.Method == http.MethodGet && p == "/folders":
			s.handleFolders(w)
		case r.Method == http.MethodDelete && p == "/folders/recent":
			s.handleRemoveRecentFolder(w, r)
		case r.Method == http.MethodGet && p == "/files":
			s.handleRepositoryFiles(w, r)
		case r.Method == http.MethodGet && p == "/directory":
			s.handleDirectoryEntries(w, r)
		case r.Method == http.MethodGet && p == "/files/search":
			s.handleFileSearch(w, r)
		case r.Method == http.MethodGet && p == "/worktree/file":
			s.handleReadWorktreeFile(w, r)
		case r.Method == http.MethodPut && p == "/worktree/file":
			s.handleWriteWorktreeFile(w, r)
		case r.Method == http.MethodPost && p == "/worktree/entry":
			s.handleCreateWorktreeEntry(w, r)
		case r.Method == http.MethodPatch && p == "/worktree/entry":
			s.handleRenameWorktreeEntry(w, r)
		case r.Method == http.MethodGet && p == "/diff":
			s.handleDiff(w, r)
		case r.Method == http.MethodGet && p == "/review":
			s.handleReview(w, r)
		case r.Method == http.MethodGet && p == "/graph":
			s.handleGraph(w, r)
		case r.Method == http.MethodGet && p == "/graph/count":
			s.handleGraphCount(w, r)
		case r.Method == http.MethodGet && p == "/branches":
			s.handleBranches(w, r)
		case r.Method == http.MethodGet && p == "/stashes":
			s.handleStashes(w, r)
		case r.Method == http.MethodGet && p == "/tags":
			s.handleTags(w, r)
		case r.Method == http.MethodGet && p == "/conflicts":
			s.handleConflicts(w, r)
		case r.Method == http.MethodGet && p == "/compare":
			s.handleCompare(w, r)
		case r.Method == http.MethodGet && isCommitSubroute(p, "files"):
			s.handleCommitFiles(w, r)
		case r.Method == http.MethodGet && p == "/events":
			s.handleEvents(w, r)
		case r.Method == http.MethodPost && p == "/folder/reveal":
			s.handleRevealFolder(w, r)
		case r.Method == http.MethodPost && p == "/folder":
			s.handleOpenFolder(w, r)
		case r.Method == http.MethodPost && p == "/operations":
			s.handleOperation(w, r)
		default:
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		}
	})
}

func (s *Server) handleFolders(w http.ResponseWriter) {
	if s.folders == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "folder catalog unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, s.folders())
}

// handleDiff returns one file diff from a stable repository generation. Mutable
// staged/unstaged patches receive an opaque identity that is verified before a
// later partial-patch mutation is allowed.
func (s *Server) handleDiff(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), DiffTimeout)
	defer cancel()
	q := r.URL.Query()
	scope := protocol.DiffScope(q.Get("scope"))
	opts := protocol.DiffOptions{
		Path:        q.Get("path"),
		OldPath:     q.Get("oldPath"),
		Commit:      q.Get("commit"),
		CompareFrom: q.Get("from"),
		CompareTo:   q.Get("to"),
	}

	const maxDiffAttempts = 3
	for range maxDiffAttempts {
		generation := s.gen.Load()
		d, err := s.repo.Diff(ctx, scope, opts)
		if err != nil {
			if timeoutReached(ctx, err) {
				writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "diff timed out"})
				return
			}
			status := http.StatusInternalServerError
			switch {
			case errors.Is(err, protocol.ErrInvalidPath), errors.Is(err, protocol.ErrInvalidRef), errors.Is(err, protocol.ErrNotInRepo):
				status = http.StatusBadRequest
			}
			writeJSON(w, status, map[string]string{"error": err.Error()})
			return
		}
		if generation != s.gen.Load() {
			continue
		}
		if d.Patch != "" && (scope == protocol.DiffUnstaged || scope == protocol.DiffStaged) {
			patchID, err := s.issuePatchIdentity(generation, scope, opts.Path, d.Patch)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			d.PatchID = patchID
		}
		writeJSON(w, http.StatusOK, d)
		return
	}

	writeJSON(w, http.StatusConflict, map[string]string{
		"error": "repository changed while diff was loading",
		"code":  "diff-invalidated",
	})
}

// handleReview returns one bounded page from a stable repository generation.
// First-page races retry from the beginning; stale continuation cursors fail
// instead of mixing files from different generations.
func (s *Server) handleReview(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ReviewTimeout)
	defer cancel()
	q := r.URL.Query()
	scope := protocol.DiffScope(q.Get("scope"))
	if scope != protocol.DiffUnstaged && scope != protocol.DiffStaged && scope != protocol.DiffCommit && scope != protocol.DiffCompare {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid review scope", "code": "invalid-review"})
		return
	}
	opts := protocol.DiffOptions{
		Commit:      q.Get("commit"),
		CompareFrom: q.Get("from"),
		CompareTo:   q.Get("to"),
	}

	var cursor reviewCursor
	continuation := q.Get("cursor") != ""
	if continuation {
		var err error
		cursor, err = decodeReviewCursor(q.Get("cursor"))
		if err != nil || !cursor.matches(scope, opts) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid review cursor", "code": "invalid-review-cursor"})
			return
		}
	}

	const maxReviewAttempts = 3
	for range maxReviewAttempts {
		generation := s.gen.Load()
		if continuation && cursor.Generation != generation {
			writeReviewInvalidated(w)
			return
		}
		page, err := s.repo.Review(ctx, scope, opts, cursor.After)
		if err != nil {
			if timeoutReached(ctx, err) {
				writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "review timed out"})
				return
			}
			status := http.StatusInternalServerError
			code := "review-failed"
			switch {
			case errors.Is(err, protocol.ErrInvalidRef), errors.Is(err, protocol.ErrInvalidPath), errors.Is(err, protocol.ErrNotInRepo):
				status = http.StatusBadRequest
				code = "invalid-review"
			}
			writeJSON(w, status, map[string]string{"error": err.Error(), "code": code})
			return
		}
		if generation != s.gen.Load() {
			if continuation {
				writeReviewInvalidated(w)
				return
			}
			continue
		}
		response := page.Response
		response.Generation = generation
		if page.NextAfter != "" {
			nextCursor, err := encodeReviewCursor(reviewCursor{
				Version:    1,
				Generation: generation,
				Scope:      scope,
				Commit:     opts.Commit,
				From:       opts.CompareFrom,
				To:         opts.CompareTo,
				After:      page.NextAfter,
			})
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not encode review cursor", "code": "review-failed"})
				return
			}
			response.NextCursor = nextCursor
		}
		writeJSON(w, http.StatusOK, response)
		return
	}

	writeReviewInvalidated(w)
}

func writeReviewInvalidated(w http.ResponseWriter) {
	writeJSON(w, http.StatusConflict, map[string]string{
		"error": "repository changed while review was loading",
		"code":  "review-invalidated",
	})
}

// handleSnapshot returns normalized repository state stamped with the stable
// generation observed while it was read. If an invalidation races the read,
// the snapshot is retried instead of publishing old state under a new identity.
func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), SnapshotTimeout)
	defer cancel()

	const maxSnapshotAttempts = 3
	for range maxSnapshotAttempts {
		generation := s.gen.Load()
		snap, err := s.repo.Snapshot(ctx)
		if err != nil {
			if timeoutReached(ctx, err) {
				writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "snapshot timed out"})
				return
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if generation != s.gen.Load() {
			continue
		}

		fileCount := len(snap.Staged) + len(snap.Unstaged) + len(snap.Conflicts)
		if fileCount > snapshotFileLimit {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{
				"error": "snapshot file limit exceeded",
				"code":  "snapshot-too-large",
				"limit": snapshotFileLimit,
				"count": fileCount,
			})
			return
		}
		snap.AppVersion = s.version
		snap.Generation = generation
		writeJSON(w, http.StatusOK, snap)
		return
	}

	writeJSON(w, http.StatusConflict, map[string]string{
		"error": "repository changed while snapshot was loading",
		"code":  "snapshot-invalidated",
	})
}

// handleRepositoryFiles returns the bounded filesystem Explorer model with the
// same generation-race protection as the source-control snapshot.
func (s *Server) handleRepositoryFiles(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ReadTimeout)
	defer cancel()

	const maxAttempts = 3
	cursor := r.URL.Query().Get("cursor")
	for range maxAttempts {
		generation := s.gen.Load()
		files, err := s.repo.RepositoryFiles(ctx, cursor, repositoryFileLimit)
		if err != nil {
			if timeoutReached(ctx, err) {
				writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "repository files timed out"})
				return
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if generation != s.gen.Load() {
			continue
		}
		files.Generation = generation
		writeJSON(w, http.StatusOK, files)
		return
	}

	writeJSON(w, http.StatusConflict, map[string]string{
		"error": "repository changed while files were loading",
		"code":  "files-invalidated",
	})
}

type directoryEntriesRepo interface {
	DirectoryEntries(context.Context, string, string, int) (protocol.DirectoryEntries, error)
}

const directoryEntryLimit = 2_000

func (s *Server) handleDirectoryEntries(w http.ResponseWriter, r *http.Request) {
	repo, ok := s.repo.(directoryEntriesRepo)
	if !ok {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "directory listing unavailable"})
		return
	}
	cursor := r.URL.Query().Get("cursor")
	after := ""
	if cursor != "" {
		decoded, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil || len(decoded) == 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid directory cursor"})
			return
		}
		after = string(decoded)
	}
	ctx, cancel := context.WithTimeout(r.Context(), ReadTimeout)
	defer cancel()
	for range 3 {
		generation := s.gen.Load()
		entries, err := repo.DirectoryEntries(ctx, r.URL.Query().Get("path"), after, directoryEntryLimit)
		if err != nil {
			if timeoutReached(ctx, err) {
				writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "directory listing timed out"})
				return
			}
			if errors.Is(err, protocol.ErrInvalidPath) || errors.Is(err, protocol.ErrNotInRepo) {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if generation != s.gen.Load() {
			continue
		}
		entries.Generation = generation
		if entries.NextCursor != "" {
			entries.NextCursor = base64.RawURLEncoding.EncodeToString([]byte(entries.NextCursor))
		}
		writeJSON(w, http.StatusOK, entries)
		return
	}
	writeJSON(w, http.StatusConflict, map[string]string{
		"error": "folder changed while directory was loading",
		"code":  "directory-invalidated",
	})
}

type fileSearchRepo interface {
	SearchFiles(context.Context, string, []string, bool, int) (protocol.FileSearchResults, error)
}

const fileSearchResultLimit = 100

func (s *Server) handleFileSearch(w http.ResponseWriter, r *http.Request) {
	repo, ok := s.repo.(fileSearchRepo)
	if !ok {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "file search unavailable"})
		return
	}
	query := r.URL.Query().Get("q")
	if len(query) > 512 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "file search query is too long"})
		return
	}
	recentPaths := r.URL.Query()["recent"]
	if len(recentPaths) > 20 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "too many recent file paths"})
		return
	}
	totalRecentLength := 0
	for _, path := range recentPaths {
		totalRecentLength += len(path)
	}
	if totalRecentLength > 8_192 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "recent file paths are too long"})
		return
	}
	refresh := r.URL.Query().Get("refresh") == "1"
	ctx, cancel := context.WithTimeout(r.Context(), ReadTimeout)
	defer cancel()
	for range 3 {
		generation := s.gen.Load()
		results, err := repo.SearchFiles(ctx, query, recentPaths, refresh, fileSearchResultLimit)
		if err != nil {
			if timeoutReached(ctx, err) {
				writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "file search timed out"})
				return
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if generation != s.gen.Load() {
			continue
		}
		results.Generation = generation
		writeJSON(w, http.StatusOK, results)
		return
	}
	writeJSON(w, http.StatusConflict, map[string]string{
		"error": "folder changed while file search was loading",
		"code":  "search-invalidated",
	})
}

// graphPageSize bounds a single history page; the frontend appends pages until
// HasMore clears.
const graphPageSize = 100

// handleGraph returns a bounded history page pinned to one immutable HEAD OID.
func (s *Server) handleGraph(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	skip, err := parseNonNegInt(r.URL.Query().Get("skip"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	limit := graphPageSize
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid limit value"})
			return
		}
		if n > graphMaxPage {
			n = graphMaxPage
		}
		limit = n
	}
	ctx, cancel := context.WithTimeout(r.Context(), GraphTimeout)
	defer cancel()
	generation := s.gen.Load()
	snapshot, err := s.repo.Snapshot(ctx)
	if err != nil {
		if timeoutReached(ctx, err) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "history timed out"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	tip := r.URL.Query().Get("tip")
	if tip == "" {
		tip = snapshot.HeadOID
	} else if tip != snapshot.HeadOID {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "graph tip changed"})
		return
	}
	if tip == "" {
		writeJSON(w, http.StatusOK, protocol.GraphPage{Commits: []protocol.GraphCommit{}, Generation: generation})
		return
	}
	commits, err := s.repo.HistoryAt(ctx, tip, skip, limit+1)
	if err != nil {
		if timeoutReached(ctx, err) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "history timed out"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if generation != s.gen.Load() {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "graph changed while loading"})
		return
	}
	hasMore := len(commits) > limit
	if hasMore {
		commits = commits[:limit]
	}
	writeJSON(w, http.StatusOK, protocol.GraphPage{
		Commits: commits, HasMore: hasMore, Tip: tip, Generation: generation,
	})
}

// handleGraphCount counts the same immutable tip without delaying a history page.
func (s *Server) handleGraphCount(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	tip := r.URL.Query().Get("tip")
	if tip == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "tip is required"})
		return
	}
	generationValue := r.URL.Query().Get("generation")
	generation, err := strconv.ParseUint(generationValue, 10, 64)
	if generationValue == "" || err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "valid generation is required"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), GraphCountTimeout)
	defer cancel()
	if generation != s.gen.Load() {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "graph changed while counting"})
		return
	}
	snapshot, err := s.repo.Snapshot(ctx)
	if err != nil {
		if timeoutReached(ctx, err) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "history count timed out"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if snapshot.HeadOID != tip {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "graph tip changed"})
		return
	}
	if generation != s.gen.Load() {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "graph changed while counting"})
		return
	}
	total, err := s.repo.HistoryCount(ctx, tip)
	if generation != s.gen.Load() {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "graph changed while counting"})
		return
	}
	if err != nil {
		if timeoutReached(ctx, err) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "history count timed out"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, protocol.GraphCount{Tip: tip, Generation: generation, Total: total})
}

// handleBranches returns every local and remote branch with its upstream
// relationship, for the branch/switching UI.
func (s *Server) handleBranches(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ReadTimeout)
	defer cancel()
	branches, err := s.repo.Branches(ctx)
	if err != nil {
		if timeoutReached(ctx, err) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "branches timed out"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, branches)
}

func isCommitSubroute(requestPath, action string) bool {
	rest := strings.TrimPrefix(requestPath, "/commit/")
	oid, tail, found := strings.Cut(rest, "/")
	return found && oid != "" && !strings.Contains(oid, "/") && tail == action
}

// handleCommitFiles returns the paths changed by one commit. The OID is the
// path segment between /commit/ and /files and is validated by the gitx layer
// before reaching Git.
func (s *Server) handleCommitFiles(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ReadTimeout)
	defer cancel()
	oid := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/api/v1"), "/commit/")
	oid = strings.TrimSuffix(oid, "/files")
	details, err := s.repo.FilesChanged(ctx, oid)
	if err != nil {
		if timeoutReached(ctx, err) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "commit files timed out"})
			return
		}
		status := http.StatusInternalServerError
		if errors.Is(err, protocol.ErrInvalidRef) {
			status = http.StatusBadRequest
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, details)
}

// handleStashes returns the current stash list with display refs, OIDs, and
// parsed subjects for the stash management UI.
func (s *Server) handleStashes(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ReadTimeout)
	defer cancel()
	entries, err := s.repo.Stashes(ctx)
	if err != nil {
		if timeoutReached(ctx, err) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "stashes timed out"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

// handleTags returns every tag (lightweight and annotated) with its target OID
// for the tag management UI.
func (s *Server) handleTags(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ReadTimeout)
	defer cancel()
	tags, err := s.repo.Tags(ctx)
	if err != nil {
		if timeoutReached(ctx, err) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "tags timed out"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, tags)
}

// handleCompare returns the name-status change set between two refs, reusing
// the diff pipeline so the frontend compare view renders like a commit.
func (s *Server) handleCompare(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	q := r.URL.Query()
	from := q.Get("from")
	to := q.Get("to")
	if from == "" || to == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "compare requires from and to"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ReadTimeout)
	defer cancel()
	files, err := s.repo.CompareFiles(ctx, from, to)
	if err != nil {
		if timeoutReached(ctx, err) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "compare timed out"})
			return
		}
		status := http.StatusInternalServerError
		if errors.Is(err, protocol.ErrInvalidRef) {
			status = http.StatusBadRequest
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, protocol.CommitFiles{Files: files})
}

// parseNonNegInt parses a non-negative integer query value; empty means zero.
func parseNonNegInt(s string) (int, error) {
	if s == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("invalid skip value %q", s)
	}
	return n, nil
}

// handleConflicts returns the unmerged files from the index. Each entry
// carries the path and per-side OIDs for base/ours/theirs so the frontend
// can show a3-way conflict view and offer explicit resolution actions.
func (s *Server) handleConflicts(w http.ResponseWriter, r *http.Request) {
	if s.repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "repository unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ReadTimeout)
	defer cancel()
	conflicts, err := s.repo.Conflicts(ctx)
	if err != nil {
		if timeoutReached(ctx, err) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "conflicts timed out"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, conflicts)
}
