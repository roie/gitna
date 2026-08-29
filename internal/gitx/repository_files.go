package gitx

import (
	"bytes"
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/roie/gitna/internal/protocol"
)

// RepositoryFiles returns one bounded page of the worktree's tracked,
// untracked, and ignored files. IgnoredPaths identifies the ignored subset so
// the Explorer can control its visibility independently. after is the last
// slash-separated path from the previous page.
func (r Repository) RepositoryFiles(ctx context.Context, runner Runner, after string, limit int) (protocol.RepositoryFiles, error) {
	result := protocol.RepositoryFiles{Paths: make([]string, 0), IgnoredPaths: make([]string, 0)}
	if limit <= 0 {
		return result, nil
	}
	if !r.IsGit() {
		return r.folderFiles(ctx, after, limit)
	}

	visible, err := r.listRepositoryFiles(ctx, runner, "--cached", "--others", "--exclude-standard", "--deduplicate")
	if err != nil {
		return protocol.RepositoryFiles{}, err
	}
	ignored, err := r.listRepositoryFiles(ctx, runner, "--others", "--ignored", "--exclude-standard", "--deduplicate")
	if err != nil {
		return protocol.RepositoryFiles{}, err
	}

	ignoredSet := make(map[string]struct{}, len(ignored))
	paths := make([]string, 0, len(visible)+len(ignored))
	paths = append(paths, visible...)
	for _, path := range ignored {
		ignoredSet[path] = struct{}{}
		paths = append(paths, path)
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
		if _, ok := ignoredSet[path]; ok {
			result.IgnoredPaths = append(result.IgnoredPaths, path)
		}
	}
	return result, nil
}

func (r Repository) folderFiles(ctx context.Context, after string, limit int) (protocol.RepositoryFiles, error) {
	result := protocol.RepositoryFiles{Paths: make([]string, 0), IgnoredPaths: make([]string, 0)}
	paths := make([]string, 0)
	err := filepath.WalkDir(r.Root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if path == r.Root {
			return nil
		}
		if entry.Name() == ".git" {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(r.Root, path)
		if err != nil {
			return err
		}
		paths = append(paths, filepath.ToSlash(relative))
		return nil
	})
	if err != nil {
		return protocol.RepositoryFiles{}, err
	}
	if err := ctx.Err(); err != nil {
		return protocol.RepositoryFiles{}, err
	}

	// WalkDir is depth-first, while the cursor contract is global lexical order.
	// Sort and compact the complete ordinary-folder manifest before taking a
	// bounded page so adjacent pages cannot overlap at directory boundaries.
	sort.Strings(paths)
	if err := ctx.Err(); err != nil {
		return protocol.RepositoryFiles{}, err
	}
	unique := paths[:0]
	for index, path := range paths {
		if index%4096 == 0 {
			if err := ctx.Err(); err != nil {
				return protocol.RepositoryFiles{}, err
			}
		}
		if len(unique) == 0 || path != unique[len(unique)-1] {
			unique = append(unique, path)
		}
	}
	start := sort.Search(len(unique), func(index int) bool { return unique[index] > after })
	end := min(start+limit, len(unique))
	result.Paths = append(result.Paths, unique[start:end]...)
	if end < len(unique) {
		result.Truncated = true
		result.NextCursor = result.Paths[len(result.Paths)-1]
	}
	return result, nil
}

func (r Repository) listRepositoryFiles(ctx context.Context, runner Runner, args ...string) ([]string, error) {
	res, err := runner.Run(ctx, r.Root, append([]string{"ls-files", "-z"}, args...)...)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, fmt.Errorf("gitx: list repository files: %s", strings.TrimSpace(string(res.Stderr)))
	}

	rawPaths := bytes.Split(res.Stdout, []byte{0})
	paths := make([]string, 0, len(rawPaths))
	for _, raw := range rawPaths {
		if len(raw) > 0 {
			paths = append(paths, string(raw))
		}
	}
	return paths, nil
}
