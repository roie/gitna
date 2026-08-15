package gitx

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
)

// Repository describes a discovered Git worktree.
type Repository struct {
	Root   string
	GitDir string
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
		return Repository{}, fmt.Errorf("gitx: %q is not inside a git repository: %s", start, msg)
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
