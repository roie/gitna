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
	"time"

	"github.com/roie/gitna/internal/browser"
	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
	"github.com/roie/gitna/internal/server"
	"github.com/roie/gitna/internal/session"
	"github.com/roie/gitna/internal/watch"
	"github.com/roie/gitna/internal/webui"
)

// repoAdapter bridges the git-backed repository to the server's Repo interface.
// Mutations are serialized through a shared queue so concurrent requests cannot
// interleave Git index operations.
type repoAdapter struct {
	runner *gitx.ExecRunner
	repo   gitx.Repository
	queue  *gitx.MutationQueue
}

func (a repoAdapter) Snapshot(ctx context.Context) (protocol.RepoSnapshot, error) {
	return a.repo.Status(ctx, a.runner)
}

func (a repoAdapter) RepositoryFiles(ctx context.Context, limit int) (protocol.RepositoryFiles, error) {
	return a.repo.RepositoryFiles(ctx, limit)
}

func (a repoAdapter) Diff(ctx context.Context, scope protocol.DiffScope, opts protocol.DiffOptions) (protocol.FileDiff, error) {
	return a.repo.Diff(ctx, a.runner, scope, opts)
}

func (a repoAdapter) Review(ctx context.Context, scope protocol.DiffScope, opts protocol.DiffOptions) (protocol.ReviewResponse, error) {
	return a.repo.Review(ctx, a.runner, scope, opts)
}

func (a repoAdapter) History(ctx context.Context, skip, limit int) ([]protocol.GraphCommit, error) {
	return a.repo.History(ctx, a.runner, skip, limit)
}

func (a repoAdapter) FilesChanged(ctx context.Context, oid string) ([]protocol.CommitFile, error) {
	return a.repo.ChangedFiles(ctx, a.runner, oid)
}

func (a repoAdapter) Branches(ctx context.Context) ([]protocol.Branch, error) {
	return a.repo.ListBranches(ctx, a.runner)
}

func (a repoAdapter) StagePaths(ctx context.Context, paths []string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.Stage(ctx, a.runner, paths)
	})
}

func (a repoAdapter) UnstagePaths(ctx context.Context, paths []string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.Unstage(ctx, a.runner, paths)
	})
}

func (a repoAdapter) DiscardTracked(ctx context.Context, paths []string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.DiscardTracked(ctx, a.runner, paths)
	})
}

func (a repoAdapter) DeleteUntracked(ctx context.Context, paths []string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.DeleteUntracked(ctx, a.runner, paths)
	})
}

func (a repoAdapter) StagePatch(ctx context.Context, patch []byte) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.ApplyPatch(ctx, a.runner, patch, false)
	})
}

func (a repoAdapter) UnstagePatch(ctx context.Context, patch []byte) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.ApplyPatch(ctx, a.runner, patch, true)
	})
}

func (a repoAdapter) Commit(ctx context.Context, req protocol.CommitRequest) (protocol.OperationResult, error) {
	var result protocol.OperationResult
	err := a.queue.Do(ctx, func(ctx context.Context) error {
		res, err := a.repo.Commit(ctx, a.runner, req.Message, req.Amend)
		result.OK = res.ExitCode == 0
		result.ExitCode = res.ExitCode
		result.Stdout = strings.TrimSpace(string(res.Stdout))
		result.Stderr = strings.TrimSpace(string(res.Stderr))
		return err
	})
	return result, err
}

func (a repoAdapter) CreateBranch(ctx context.Context, name, start string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.CreateBranch(ctx, a.runner, name, start)
	})
}

func (a repoAdapter) SwitchBranch(ctx context.Context, name string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.SwitchBranch(ctx, a.runner, name)
	})
}

func (a repoAdapter) DeleteBranch(ctx context.Context, name string, force bool) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.DeleteBranch(ctx, a.runner, name, force)
	})
}

func (a repoAdapter) Fetch(ctx context.Context) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.Fetch(ctx, a.runner)
	})
}

func (a repoAdapter) Pull(ctx context.Context) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.Pull(ctx, a.runner)
	})
}

func (a repoAdapter) Push(ctx context.Context) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.Push(ctx, a.runner)
	})
}

func (a repoAdapter) PushSetUpstream(ctx context.Context, remote, branch string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.PushSetUpstream(ctx, a.runner, remote, branch)
	})
}

func (a repoAdapter) Stashes(ctx context.Context) ([]protocol.StashEntry, error) {
	return a.repo.ListStashes(ctx, a.runner)
}

func (a repoAdapter) StashPush(ctx context.Context, message string, includeUntracked bool) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.StashPush(ctx, a.runner, message, includeUntracked)
	})
}

func (a repoAdapter) StashApply(ctx context.Context, ref string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.StashApply(ctx, a.runner, ref)
	})
}

func (a repoAdapter) StashPop(ctx context.Context, ref string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.StashPop(ctx, a.runner, ref)
	})
}

func (a repoAdapter) StashDrop(ctx context.Context, ref string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.StashDrop(ctx, a.runner, ref)
	})
}

func (a repoAdapter) Tags(ctx context.Context) ([]protocol.Tag, error) {
	return a.repo.ListTags(ctx, a.runner)
}

func (a repoAdapter) CreateTag(ctx context.Context, name, target, message string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.CreateTag(ctx, a.runner, name, target, message)
	})
}

func (a repoAdapter) DeleteTag(ctx context.Context, name string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.DeleteTag(ctx, a.runner, name)
	})
}

func (a repoAdapter) PushTag(ctx context.Context, remote, name string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.PushTag(ctx, a.runner, remote, name)
	})
}

func (a repoAdapter) CherryPick(ctx context.Context, oid string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.CherryPick(ctx, a.runner, oid)
	})
}

func (a repoAdapter) CherryPickAbort(ctx context.Context) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.CherryPickAbort(ctx, a.runner)
	})
}

func (a repoAdapter) CherryPickContinue(ctx context.Context) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.CherryPickContinue(ctx, a.runner)
	})
}

func (a repoAdapter) Revert(ctx context.Context, oid string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.Revert(ctx, a.runner, oid)
	})
}

func (a repoAdapter) RevertAbort(ctx context.Context) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.RevertAbort(ctx, a.runner)
	})
}

func (a repoAdapter) RevertContinue(ctx context.Context) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.RevertContinue(ctx, a.runner)
	})
}

func (a repoAdapter) Reset(ctx context.Context, target, mode string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.Reset(ctx, a.runner, target, mode)
	})
}

func (a repoAdapter) CompareFiles(ctx context.Context, from, to string) ([]protocol.CommitFile, error) {
	return a.repo.CompareFiles(ctx, a.runner, from, to)
}

func (a repoAdapter) Conflicts(ctx context.Context) ([]protocol.ConflictEntry, error) {
	return a.repo.ListConflicts(ctx, a.runner)
}

func (a repoAdapter) Merge(ctx context.Context, branch string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.Merge(ctx, a.runner, branch)
	})
}

func (a repoAdapter) MergeAbort(ctx context.Context) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.MergeAbort(ctx, a.runner)
	})
}

func (a repoAdapter) MergeContinue(ctx context.Context) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.MergeContinue(ctx, a.runner)
	})
}

func (a repoAdapter) Rebase(ctx context.Context, upstream string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.Rebase(ctx, a.runner, upstream)
	})
}

func (a repoAdapter) RebaseAbort(ctx context.Context) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.RebaseAbort(ctx, a.runner)
	})
}

func (a repoAdapter) RebaseContinue(ctx context.Context) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.RebaseContinue(ctx, a.runner)
	})
}

func (a repoAdapter) ResolveConflict(ctx context.Context, path string, theirs bool) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.ResolveConflictSide(ctx, a.runner, path, theirs)
	})
}

func (a repoAdapter) ResolveConflictBoth(ctx context.Context, path string) error {
	return a.queue.Do(ctx, func(ctx context.Context) error {
		return a.repo.ResolveConflictBoth(ctx, a.runner, path)
	})
}

// Run starts the workbench session for path and blocks until ctx is cancelled
// or the server fails. path must be inside a Git repository; the session binds
// to a loopback-only OS-assigned port.
func Run(ctx context.Context, path string) error {
	runner := &gitx.ExecRunner{}
	repo, err := gitx.Discover(ctx, runner, path)
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

	watcher, err := watch.New(ctx, repo, runner, watch.Options{})
	if err != nil {
		return fmt.Errorf("app: create watcher: %w", err)
	}
	defer watcher.Close()

	srv, err := server.New(staticFS, server.Options{
		Token:  token,
		Host:   host,
		Repo:   repoAdapter{runner: runner, repo: repo, queue: gitx.NewMutationQueue()},
		Events: watcher.Events(),
	})
	if err != nil {
		return fmt.Errorf("app: create server: %w", err)
	}

	url := fmt.Sprintf("http://%s/s/%s/", host, token)
	fmt.Printf("gitna: %s\n", repo.Root)
	fmt.Printf("gitna: serving %s\n", url)

	// Full-process browser tests drive the emitted capability URL themselves.
	// Production sessions retain the normal default-browser launch.
	if os.Getenv("GITNA_NO_BROWSER") != "1" {
		if err := browser.Open(url); err != nil {
			fmt.Fprintf(os.Stderr, "gitna: could not open browser: %v\n", err)
		}
	}

	httpSrv := &http.Server{Handler: srv.Handler()}

	errCh := make(chan error, 1)
	go func() { errCh <- httpSrv.Serve(ln) }()

	select {
	case err := <-errCh:
		return fmt.Errorf("app: server: %w", err)
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return httpSrv.Shutdown(shutdownCtx)
	}
}
