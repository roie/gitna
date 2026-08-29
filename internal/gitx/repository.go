package gitx

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Repository describes a discovered Git worktree.
type Repository struct {
	Root   string
	GitDir string
}

var ErrNotRepository = errors.New("not inside a git repository")

type openFolderTraceKey struct{}

// WithOpenFolderTrace installs an opt-in local phase observer for folder
// canonicalization and Git discovery. It carries no paths or repository data.
func WithOpenFolderTrace(ctx context.Context, trace func(string, time.Duration)) context.Context {
	if trace == nil {
		return ctx
	}
	return context.WithValue(ctx, openFolderTraceKey{}, trace)
}

func traceOpenFolder(ctx context.Context, phase string, started time.Time) {
	trace, _ := ctx.Value(openFolderTraceKey{}).(func(string, time.Duration))
	if trace != nil {
		trace(phase, time.Since(started))
	}
}

func (r Repository) IsGit() bool { return r.GitDir != "" }

// OpenFolder resolves start to a Git worktree root when one contains it,
// otherwise to the canonical ordinary directory itself.
func OpenFolder(ctx context.Context, runner Runner, start string) (Repository, error) {
	canonicalStarted := time.Now()
	absolute, err := filepath.Abs(start)
	if err != nil {
		return Repository{}, err
	}
	root, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return Repository{}, fmt.Errorf("open folder: %w", err)
	}
	info, err := os.Stat(root)
	if err != nil {
		return Repository{}, fmt.Errorf("open folder: %w", err)
	}
	if !info.IsDir() {
		return Repository{}, fmt.Errorf("open folder: %q is not a directory", root)
	}
	traceOpenFolder(ctx, "folder-resolve-symlink", canonicalStarted)
	gitStarted := time.Now()
	repo, err := Discover(ctx, runner, root)
	traceOpenFolder(ctx, "folder-resolve-git", gitStarted)
	if err == nil {
		return repo, nil
	}
	if !errors.Is(err, ErrNotRepository) || hasGitMarker(root) {
		return Repository{}, err
	}
	return Repository{Root: filepath.Clean(root)}, nil
}

func hasGitMarker(start string) bool {
	for path := filepath.Clean(start); ; path = filepath.Dir(path) {
		if _, err := os.Lstat(filepath.Join(path, ".git")); err == nil || !errors.Is(err, os.ErrNotExist) {
			return true
		}
		parent := filepath.Dir(path)
		if parent == path {
			break
		}
	}
	_, headErr := os.Stat(filepath.Join(start, "HEAD"))
	objects, objectsErr := os.Stat(filepath.Join(start, "objects"))
	return headErr == nil && objectsErr == nil && objects.IsDir()
}

// Discover resolves the repository containing start. start may be the
// repository root, a nested directory, or a path inside the worktree. An error
// is returned when start is not inside a Git repository.
func Discover(ctx context.Context, r Runner, start string) (Repository, error) {
	res, err := r.Run(ctx, start,
		"rev-parse", "--show-toplevel", "--absolute-git-dir",
	)
	if err != nil {
		return Repository{}, err
	}
	if res.ExitCode != 0 {
		msg := strings.TrimSpace(string(res.Stderr))
		if msg == "" {
			msg = strings.TrimSpace(string(res.Stdout))
		}
		return Repository{}, fmt.Errorf("gitx: %w: %q: %s", ErrNotRepository, start, msg)
	}

	lines := strings.Split(strings.TrimRight(string(res.Stdout), "\n"), "\n")
	if len(lines) < 2 {
		return Repository{}, fmt.Errorf("gitx: unexpected rev-parse output %q", string(res.Stdout))
	}

	repo := Repository{
		Root:   filepath.Clean(lines[0]),
		GitDir: filepath.Clean(lines[1]),
	}
	if repo.Root == "" {
		return Repository{}, fmt.Errorf("gitx: rev-parse returned empty root for %q", start)
	}
	return repo, nil
}
