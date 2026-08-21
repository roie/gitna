package gitx

import (
	"context"
	"io/fs"
	"path/filepath"

	"github.com/roie/gitna/internal/protocol"
)

// RepositoryFiles returns the worktree's complete visible file set. The walk
// never follows symlinks, excludes Git's private metadata entry, and stops at
// limit so a repository cannot create an unbounded API response.
func (r Repository) RepositoryFiles(ctx context.Context, limit int) (protocol.RepositoryFiles, error) {
	result := protocol.RepositoryFiles{Paths: make([]string, 0)}
	if limit <= 0 {
		return result, nil
	}

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

		rel, err := filepath.Rel(r.Root, path)
		if err != nil {
			return err
		}
		if rel == ".git" {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		if len(result.Paths) == limit {
			result.Truncated = true
			return fs.SkipAll
		}
		result.Paths = append(result.Paths, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return protocol.RepositoryFiles{}, err
	}
	return result, nil
}
