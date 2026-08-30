// Package app wires the local workbench process together: loopback server,
// browser launch, and (in later tasks) repository discovery and sessions.
package app

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/roie/gitna/internal/browser"
	"github.com/roie/gitna/internal/folder"
	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
	"github.com/roie/gitna/internal/server"
	"github.com/roie/gitna/internal/session"
	"github.com/roie/gitna/internal/webui"
)

// repoAdapter bridges the git-backed repository to the server's Repo interface.
// Mutations are serialized through a shared queue so concurrent requests cannot
// interleave Git index operations.
type repoAdapter struct {
	ctx              context.Context
	runner           *gitx.ExecRunner
	queue            *gitx.MutationQueue
	search           folderSearchIndex
	directories      folderDirectoryIndexCache
	observeDirectory func(string) protocol.WatchCoverage

	mu   sync.RWMutex
	repo gitx.Repository
}

func (a *repoAdapter) current() gitx.Repository {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.repo
}

func (a *repoAdapter) switchTo(ctx context.Context, repo gitx.Repository) error {
	return a.queue.Do(ctx, func(context.Context) error {
		a.mu.Lock()
		a.repo = repo
		a.mu.Unlock()
		a.invalidateFileSearch()
		return nil
	})
}

func (a *repoAdapter) Snapshot(ctx context.Context) (protocol.RepoSnapshot, error) {
	repo := a.current()
	if repo.IsGit() {
		return repo.Status(ctx, a.runner)
	}
	return protocol.RepoSnapshot{
		Root:       repo.Root,
		Operation:  protocol.OperationNone,
		Staged:     make([]protocol.FileChange, 0),
		Unstaged:   make([]protocol.FileChange, 0),
		Conflicts:  make([]protocol.ConflictEntry, 0),
		Repository: false,
	}, nil
}

func (a *repoAdapter) RepositoryFiles(ctx context.Context, after string, limit int) (protocol.RepositoryFiles, error) {
	return a.current().RepositoryFiles(ctx, a.runner, after, limit)
}

func (a *repoAdapter) DirectoryEntries(ctx context.Context, directory, after string, limit int) (protocol.DirectoryEntries, error) {
	repo := a.current()
	var entries protocol.DirectoryEntries
	var err error
	if repo.IsGit() {
		entries, err = repo.DirectoryEntries(ctx, directory, after, limit)
	} else {
		entries, err = a.directories.page(ctx, repo, directory, after, limit)
	}
	if err == nil && a.observeDirectory != nil {
		entries.WatchCoverage = a.observeDirectory(directory)
	}
	return entries, err
}

func (a *repoAdapter) SearchFiles(
	ctx context.Context,
	query string,
	recentPaths []string,
	refresh bool,
	limit int,
) (protocol.FileSearchResults, error) {
	if refresh {
		a.invalidateFileSearch()
	}
	return a.searchFiles(ctx, query, recentPaths, limit)
}

func (a *repoAdapter) ReadWorktreeFile(ctx context.Context, path string) (protocol.WorktreeFile, error) {
	return a.current().ReadWorktreeFile(ctx, path)
}

func (a *repoAdapter) CompareWorktreeFiles(ctx context.Context, leftPath, rightPath string) (protocol.FileDiff, error) {
	return a.current().CompareWorktreeFiles(ctx, leftPath, rightPath)
}

func (a *repoAdapter) WriteWorktreeFile(ctx context.Context, path, content, expectedHash string) (protocol.WorktreeFile, error) {
	var file protocol.WorktreeFile
	err := a.queue.Do(ctx, func(ctx context.Context) error {
		var err error
		file, err = a.current().WriteWorktreeFile(ctx, path, content, expectedHash)
		return err
	})
	return file, err
}

func (a *repoAdapter) CreateWorktreeEntry(ctx context.Context, path string, directory bool) error {
	err := a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().CreateWorktreeEntry(ctx, path, directory)
	})
	if err == nil {
		a.invalidateFileSearch()
	}
	return err
}

func (a *repoAdapter) RenameWorktreeEntry(ctx context.Context, source, destination string) error {
	err := a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().RenameWorktreeEntry(ctx, source, destination)
	})
	if err == nil {
		a.invalidateFileSearch()
	}
	return err
}

func (a *repoAdapter) Diff(ctx context.Context, scope protocol.DiffScope, opts protocol.DiffOptions) (protocol.FileDiff, error) {
	return a.current().Diff(ctx, a.runner, scope, opts)
}

func (a *repoAdapter) Review(ctx context.Context, scope protocol.DiffScope, opts protocol.DiffOptions, after string) (protocol.ReviewPage, error) {
	return a.current().Review(ctx, a.runner, scope, opts, after)
}

func (a *repoAdapter) HistoryAt(ctx context.Context, tip string, skip, limit int) ([]protocol.GraphCommit, error) {
	return a.current().HistoryAt(ctx, a.runner, tip, skip, limit)
}

func (a *repoAdapter) HistoryCount(ctx context.Context, tip string) (int, error) {
	return a.current().HistoryCount(ctx, a.runner, tip)
}

func (a *repoAdapter) FilesChanged(ctx context.Context, oid string) (protocol.CommitFiles, error) {
	return a.current().CommitDetails(ctx, a.runner, oid)
}

func (a *repoAdapter) Branches(ctx context.Context) ([]protocol.Branch, error) {
	return a.current().ListBranches(ctx, a.runner)
}

func (a *repoAdapter) StagePaths(ctx context.Context, paths []string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().Stage(ctx, a.runner, paths)
	})
}

func (a *repoAdapter) UnstagePaths(ctx context.Context, paths []string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().Unstage(ctx, a.runner, paths)
	})
}

func (a *repoAdapter) DiscardTracked(ctx context.Context, paths []string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().DiscardTracked(ctx, a.runner, paths)
	})
}

func (a *repoAdapter) DeleteUntracked(ctx context.Context, paths []string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().DeleteUntracked(ctx, a.runner, paths)
	})
}

func (a *repoAdapter) StagePatch(ctx context.Context, patch []byte) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().ApplyPatch(ctx, a.runner, patch, false)
	})
}

func (a *repoAdapter) UnstagePatch(ctx context.Context, patch []byte) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().ApplyPatch(ctx, a.runner, patch, true)
	})
}

func (a *repoAdapter) Commit(ctx context.Context, req protocol.CommitRequest) (protocol.OperationResult, error) {
	var result protocol.OperationResult
	err := a.queue.Do(ctx, func(ctx context.Context) error {
		res, err := a.current().Commit(ctx, a.runner, req.Message, req.Amend)
		result.OK = res.ExitCode == 0
		result.ExitCode = res.ExitCode
		result.Stdout = strings.TrimSpace(string(res.Stdout))
		result.Stderr = strings.TrimSpace(string(res.Stderr))
		return err
	})
	return result, err
}

func (a *repoAdapter) CreateBranch(ctx context.Context, name, start string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().CreateBranch(ctx, a.runner, name, start)
	})
}

func (a *repoAdapter) SwitchBranch(ctx context.Context, name string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().SwitchBranch(ctx, a.runner, name)
	})
}

func (a *repoAdapter) DeleteBranch(ctx context.Context, name string, force bool) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().DeleteBranch(ctx, a.runner, name, force)
	})
}

func (a *repoAdapter) Fetch(ctx context.Context) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().Fetch(ctx, a.runner)
	})
}

func (a *repoAdapter) Pull(ctx context.Context) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().Pull(ctx, a.runner)
	})
}

func (a *repoAdapter) Push(ctx context.Context) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().Push(ctx, a.runner)
	})
}

func (a *repoAdapter) PushSetUpstream(ctx context.Context, remote, branch string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().PushSetUpstream(ctx, a.runner, remote, branch)
	})
}

func (a *repoAdapter) Stashes(ctx context.Context) ([]protocol.StashEntry, error) {
	return a.current().ListStashes(ctx, a.runner)
}

func (a *repoAdapter) StashPush(ctx context.Context, message string, includeUntracked bool) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().StashPush(ctx, a.runner, message, includeUntracked)
	})
}

func (a *repoAdapter) StashApply(ctx context.Context, ref string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().StashApply(ctx, a.runner, ref)
	})
}

func (a *repoAdapter) StashPop(ctx context.Context, ref string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().StashPop(ctx, a.runner, ref)
	})
}

func (a *repoAdapter) StashDrop(ctx context.Context, ref string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().StashDrop(ctx, a.runner, ref)
	})
}

func (a *repoAdapter) Tags(ctx context.Context) ([]protocol.Tag, error) {
	return a.current().ListTags(ctx, a.runner)
}

func (a *repoAdapter) CreateTag(ctx context.Context, name, target, message string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().CreateTag(ctx, a.runner, name, target, message)
	})
}

func (a *repoAdapter) DeleteTag(ctx context.Context, name string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().DeleteTag(ctx, a.runner, name)
	})
}

func (a *repoAdapter) PushTag(ctx context.Context, remote, name string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().PushTag(ctx, a.runner, remote, name)
	})
}

func (a *repoAdapter) CherryPick(ctx context.Context, oid string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().CherryPick(ctx, a.runner, oid)
	})
}

func (a *repoAdapter) CherryPickAbort(ctx context.Context) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().CherryPickAbort(ctx, a.runner)
	})
}

func (a *repoAdapter) CherryPickContinue(ctx context.Context) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().CherryPickContinue(ctx, a.runner)
	})
}

func (a *repoAdapter) Revert(ctx context.Context, oid string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().Revert(ctx, a.runner, oid)
	})
}

func (a *repoAdapter) RevertAbort(ctx context.Context) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().RevertAbort(ctx, a.runner)
	})
}

func (a *repoAdapter) RevertContinue(ctx context.Context) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().RevertContinue(ctx, a.runner)
	})
}

func (a *repoAdapter) Reset(ctx context.Context, target, mode string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().Reset(ctx, a.runner, target, mode)
	})
}

func (a *repoAdapter) CompareFiles(ctx context.Context, from, to string) ([]protocol.CommitFile, error) {
	return a.current().CompareFiles(ctx, a.runner, from, to)
}

func (a *repoAdapter) Conflicts(ctx context.Context) ([]protocol.ConflictEntry, error) {
	return a.current().ListConflicts(ctx, a.runner)
}

func (a *repoAdapter) Merge(ctx context.Context, branch string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().Merge(ctx, a.runner, branch)
	})
}

func (a *repoAdapter) MergeAbort(ctx context.Context) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().MergeAbort(ctx, a.runner)
	})
}

func (a *repoAdapter) MergeContinue(ctx context.Context) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().MergeContinue(ctx, a.runner)
	})
}

func (a *repoAdapter) Rebase(ctx context.Context, upstream string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().Rebase(ctx, a.runner, upstream)
	})
}

func (a *repoAdapter) RebaseAbort(ctx context.Context) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().RebaseAbort(ctx, a.runner)
	})
}

func (a *repoAdapter) RebaseContinue(ctx context.Context) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().RebaseContinue(ctx, a.runner)
	})
}

func (a *repoAdapter) ResolveConflict(ctx context.Context, path string, theirs bool) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().ResolveConflictSide(ctx, a.runner, path, theirs)
	})
}

func (a *repoAdapter) ResolveConflictBoth(ctx context.Context, path string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.current().ResolveConflictBoth(ctx, a.runner, path)
	})
}

// Run starts the workbench session for path and blocks until ctx is cancelled
// or the server fails. path must be an existing directory; Git worktrees open
// at their repository root. The session binds to a loopback-only OS-assigned port.
func Run(ctx context.Context, path, version string) error {
	runner := &gitx.ExecRunner{}
	repo, err := gitx.OpenFolder(ctx, runner, path)
	if err != nil {
		return fmt.Errorf("app: %w", err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("app: listen: %w", err)
	}

	tcpAddr, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		return fmt.Errorf("app: unexpected listener address %T", ln.Addr())
	}

	token, err := session.NewToken()
	if err != nil {
		return fmt.Errorf("app: %w", err)
	}
	host := fmt.Sprintf("127.0.0.1:%d", tcpAddr.Port)

	staticFS, err := webui.Assets()
	if err != nil {
		return fmt.Errorf("app: load embedded assets: %w", err)
	}

	basePath := server.CapabilityPath(token)
	registry, err := newFolderRegistry(
		ctx,
		runner,
		staticFS,
		version,
		folder.OpenDefault(),
		basePath,
		repo,
	)
	if err != nil {
		return fmt.Errorf("app: create folder registry: %w", err)
	}
	defer registry.close()

	url := fmt.Sprintf("http://%s%s", host, registry.initialHref())
	httpSrv := &http.Server{
		Handler: server.Security{
			Token: token,
			Host:  host,
		}.Wrap(registry),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    16 << 10,
	}

	errCh := make(chan error, 1)
	go func() { errCh <- httpSrv.Serve(ln) }()

	fmt.Printf("Gitna %s\n", version)
	fmt.Printf("Folder      %s\n", repo.Root)
	fmt.Printf("URL         %s\n", url)

	// Full-process browser tests drive the emitted capability URL themselves.
	// Production sessions retain the normal default-browser launch.
	if os.Getenv("GITNA_NO_BROWSER") != "1" {
		if err := browser.Open(url); err != nil {
			fmt.Fprintf(os.Stderr, "gitna: could not open browser: %v\n", err)
		}
	}

	select {
	case err := <-errCh:
		return fmt.Errorf("app: server: %w", err)
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return httpSrv.Shutdown(shutdownCtx)
	}
}
