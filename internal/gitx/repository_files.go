package gitx

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/roie/gitna/internal/protocol"
)

// RepositoryFiles returns one bounded page of the worktree's tracked and
// non-ignored untracked files. Git's standard excludes keep local build output,
// private notes, and other intentionally ignored files out of the Explorer.
// after is the last slash-separated path from the previous page.
func (r Repository) RepositoryFiles(ctx context.Context, runner Runner, after string, limit int) (protocol.RepositoryFiles, error) {
	result := protocol.RepositoryFiles{Paths: make([]string, 0)}
	if limit <= 0 {
		return result, nil
	}

	res, err := runner.Run(ctx, r.Root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate")
	if err != nil {
		return protocol.RepositoryFiles{}, err
	}
	if res.ExitCode != 0 {
		return protocol.RepositoryFiles{}, fmt.Errorf("gitx: list repository files: %s", strings.TrimSpace(string(res.Stderr)))
	}

	rawPaths := bytes.Split(res.Stdout, []byte{0})
	paths := make([]string, 0, len(rawPaths))
	for _, raw := range rawPaths {
		if len(raw) > 0 {
			paths = append(paths, string(raw))
		}
	}
	sort.Strings(paths)

	for _, path := range paths {
		if err := ctx.Err(); err != nil {
			return protocol.RepositoryFiles{}, err
		}
		if path <= after {
			continue
		}
		if _, err := os.Lstat(filepath.Join(r.Root, filepath.FromSlash(path))); err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return protocol.RepositoryFiles{}, err
		}
		if len(result.Paths) == limit {
			result.Truncated = true
			result.NextCursor = result.Paths[len(result.Paths)-1]
			break
		}
		result.Paths = append(result.Paths, path)
	}
	return result, nil
}
