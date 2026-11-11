package app

import (
	"context"
	"fmt"
	"io/fs"
	"strings"
	"sync"

	"github.com/roie/gitna/internal/conversations"
	"github.com/roie/gitna/internal/folder"
	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/server"
)

func (r *folderRegistry) newConversations(repo gitx.Repository) *server.Conversations {
	if r.conversations == nil {
		return nil
	}
	root := repo.Root
	library := r.conversations
	backend := &server.Conversations{
		Root: root,
		Open: func() (*conversations.Store, error) { return library.Store(folder.PathKey(root)) },
	}
	var once sync.Once
	human := conversations.Participant{ID: "human:local", Kind: conversations.KindHuman, Name: "You"}
	backend.Human = func() conversations.Participant {
		once.Do(func() {
			if !repo.IsGit() {
				return
			}
			result, err := r.runner.Run(r.ctx, root, "config", "user.name")
			if name := strings.TrimSpace(string(result.Stdout)); err == nil && result.ExitCode == 0 && name != "" && len(name) <= 128 {
				human.Name = name
			}
		})
		return human
	}
	worktree := conversations.WorktreeContent(root)
	backend.Content = func(ctx context.Context, source, revision, path string) ([]byte, error) {
		if source == conversations.SourceWorktree {
			return worktree(ctx, source, revision, path)
		}
		if !repo.IsGit() {
			return nil, fs.ErrNotExist
		}
		if source == conversations.SourceIndex {
			revision = ""
		}
		data, present, err := repo.Blob(ctx, r.runner, revision, path)
		if err == nil && !present {
			err = fs.ErrNotExist
		}
		return data, err
	}
	if repo.IsGit() {
		backend.Head = func(ctx context.Context) string {
			result, err := r.runner.Run(ctx, root, "rev-parse", "--verify", "--quiet", "HEAD")
			if err != nil || result.ExitCode != 0 {
				return ""
			}
			return strings.TrimSpace(string(result.Stdout))
		}
		backend.Renames = func(ctx context.Context, source, revision string) (map[string]string, error) {
			args := []string{"diff", "-M", "--name-status", "-z", revision, "--"}
			if source == conversations.SourceIndex {
				args = []string{"diff", "--cached", "-M", "--name-status", "-z", revision, "--"}
			}
			result, err := r.runner.Run(ctx, root, args...)
			if err != nil {
				return nil, err
			}
			if result.ExitCode != 0 {
				return nil, fmt.Errorf("git diff exited %d", result.ExitCode)
			}
			return conversations.ParseRenames(result.Stdout), nil
		}
		backend.Changed = func(ctx context.Context) ([]string, error) {
			result, err := r.runner.Run(ctx, root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
			if err != nil {
				return nil, err
			}
			if result.ExitCode != 0 {
				return nil, fmt.Errorf("git status exited %d", result.ExitCode)
			}
			return conversations.ParseChanged(result.Stdout), nil
		}
	}
	return backend
}

// conversationsFor returns the conversations of an already open folder that
// contains path. Agents cannot use it to reach folders the user never opened.
func (r *folderRegistry) conversationsFor(ctx context.Context, path string) (*server.Conversations, error) {
	repo, err := r.resolveFolder(ctx, path)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", server.ErrFolderNotOpen, err)
	}
	r.mu.RLock()
	entry := r.byRoute[r.byRoot[folder.PathKey(repo.Root)]]
	r.mu.RUnlock()
	if entry == nil || entry.conversations == nil {
		return nil, server.ErrFolderNotOpen
	}
	return entry.conversations, nil
}
