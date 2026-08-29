package gitx

import (
	"bytes"
	"container/heap"
	"context"
	"fmt"
	"io"
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

type folderFileCandidate struct {
	path      string
	directory bool
}

type folderFileCandidates []folderFileCandidate

func (candidates folderFileCandidates) Len() int { return len(candidates) }
func (candidates folderFileCandidates) Less(left, right int) bool {
	return candidates[left].path < candidates[right].path
}
func (candidates folderFileCandidates) Swap(left, right int) {
	candidates[left], candidates[right] = candidates[right], candidates[left]
}
func (candidates *folderFileCandidates) Push(value any) {
	*candidates = append(*candidates, value.(folderFileCandidate))
}
func (candidates *folderFileCandidates) Pop() any {
	values := *candidates
	last := len(values) - 1
	value := values[last]
	*candidates = values[:last]
	return value
}

const folderDirectoryReadBatch = 256

type folderDirectoryReader func(context.Context, string, string, func(folderFileCandidate)) error

func readFolderDirectory(
	ctx context.Context,
	root string,
	relative string,
	enqueue func(folderFileCandidate),
) error {
	absolute := root
	if relative != "" {
		absolute = filepath.Join(root, filepath.FromSlash(relative))
		info, err := os.Lstat(absolute)
		if err != nil {
			return err
		}
		// A directory replaced by a symlink while paging must never be followed.
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
	}
	directory, err := os.Open(absolute)
	if err != nil {
		return err
	}
	defer directory.Close()

	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		entries, readErr := directory.ReadDir(folderDirectoryReadBatch)
		for _, entry := range entries {
			if entry.Name() == ".git" {
				continue
			}
			path := entry.Name()
			if relative != "" {
				path = relative + "/" + path
			}
			enqueue(folderFileCandidate{path: path, directory: entry.IsDir()})
		}
		if readErr != nil {
			if readErr == io.EOF {
				return nil
			}
			return readErr
		}
	}
}

func folderCandidateMayFollow(candidate folderFileCandidate, after string) bool {
	if !candidate.directory {
		return candidate.path > after
	}
	prefix := candidate.path + "/"
	return after == "" || strings.HasPrefix(after, prefix) || prefix > after
}

func (r Repository) folderFiles(ctx context.Context, after string, limit int) (protocol.RepositoryFiles, error) {
	return r.folderFilesWithReader(ctx, after, limit, readFolderDirectory)
}

func (r Repository) folderFilesWithReader(
	ctx context.Context,
	after string,
	limit int,
	readDirectory folderDirectoryReader,
) (protocol.RepositoryFiles, error) {
	result := protocol.RepositoryFiles{Paths: make([]string, 0, limit), IgnoredPaths: make([]string, 0)}
	candidates := make(folderFileCandidates, 0)
	heap.Init(&candidates)
	enqueue := func(candidate folderFileCandidate) {
		if folderCandidateMayFollow(candidate, after) {
			heap.Push(&candidates, candidate)
		}
	}
	if err := readDirectory(ctx, r.Root, "", enqueue); err != nil {
		return protocol.RepositoryFiles{}, err
	}

	for candidates.Len() > 0 {
		if err := ctx.Err(); err != nil {
			return protocol.RepositoryFiles{}, err
		}
		candidate := heap.Pop(&candidates).(folderFileCandidate)
		if candidate.directory {
			if err := readDirectory(ctx, r.Root, candidate.path, enqueue); err != nil {
				return protocol.RepositoryFiles{}, err
			}
			continue
		}
		if len(result.Paths) == limit {
			result.Truncated = true
			result.NextCursor = result.Paths[len(result.Paths)-1]
			return result, nil
		}
		result.Paths = append(result.Paths, candidate.path)
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
