package gitx

import (
	"context"
	"io/fs"
	"path/filepath"

	"github.com/roie/gitna/internal/protocol"
)

// RepositoryFiles returns one bounded page of the worktree's complete visible
// file set. The walk never follows symlinks and excludes Git's private metadata.
// after is the last slash-separated path from the previous page.
func (r Repository) RepositoryFiles(ctx context.Context, after string, limit int) (protocol.RepositoryFiles, error) {
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
		rel = filepath.ToSlash(rel)
		if rel <= after {
			return nil
		}
		if len(result.Paths) == limit {
			result.Truncated = true
			result.NextCursor = result.Paths[len(result.Paths)-1]
			return fs.SkipAll
		}
		result.Paths = append(result.Paths, rel)
		return nil
	})
	if err != nil {
		return protocol.RepositoryFiles{}, err
	}
	return result, nil
}
