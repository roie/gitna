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
	return r.repositoryFiles(ctx, runner, after, limit, os.Lstat)
}

func (r Repository) repositoryFiles(
	ctx context.Context,
	runner Runner,
	after string,
	limit int,
	lstat func(string) (os.FileInfo, error),
) (protocol.RepositoryFiles, error) {
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
		// Git already reports ignored entries from the live worktree. Avoid a
		// filesystem lookup for every dependency file in large ignored trees.
		if _, isIgnored := ignoredSet[path]; !isIgnored {
			if _, err := lstat(filepath.Join(r.Root, filepath.FromSlash(path))); err != nil {
				if os.IsNotExist(err) {
					continue
				}
				return protocol.RepositoryFiles{}, err
			}
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

type nulRecordRunner interface {
	RunNUL(context.Context, string, func([]byte) error, ...string) (Result, error)
}

// RepositoryFileCount returns the exact number of current worktree files
// without serializing the complete Explorer manifest.
func (r Repository) RepositoryFileCount(ctx context.Context, runner Runner) (int, error) {
	if !r.IsGit() {
		return 0, fmt.Errorf("gitx: repository file count requires a Git repository")
	}
	if streamer, ok := runner.(nulRecordRunner); ok {
		return r.streamRepositoryFileCount(ctx, streamer)
	}
	visible, err := r.listRepositoryFiles(ctx, runner, "--cached", "--others", "--exclude-standard", "--deduplicate")
	if err != nil {
		return 0, err
	}
	ignored, err := r.listRepositoryFiles(ctx, runner, "--others", "--ignored", "--exclude-standard", "--deduplicate")
	if err != nil {
		return 0, err
	}

	paths := make(map[string]struct{}, len(visible)+len(ignored))
	for _, path := range visible {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		if _, err := os.Lstat(filepath.Join(r.Root, filepath.FromSlash(path))); err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return 0, err
		}
		paths[path] = struct{}{}
	}
	for _, path := range ignored {
		paths[path] = struct{}{}
	}
	return len(paths), nil
}

func (r Repository) streamRepositoryFileCount(ctx context.Context, runner nulRecordRunner) (int, error) {
	total := 0
	visible, err := runner.RunNUL(ctx, r.Root, func(record []byte) error {
		path := string(record)
		if _, err := os.Lstat(filepath.Join(r.Root, filepath.FromSlash(path))); err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		total++
		return nil
	}, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate")
	if err != nil {
		return 0, err
	}
	if visible.ExitCode != 0 {
		return 0, fmt.Errorf("gitx: count repository files: %s", strings.TrimSpace(string(visible.Stderr)))
	}
	ignored, err := runner.RunNUL(ctx, r.Root, func([]byte) error {
		total++
		return nil
	}, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--deduplicate")
	if err != nil {
		return 0, err
	}
	if ignored.ExitCode != 0 {
		return 0, fmt.Errorf("gitx: count ignored repository files: %s", strings.TrimSpace(string(ignored.Stderr)))
	}
	return total, nil
}

type folderFileCandidate struct {
	path         string
	directory    bool
	continuation bool
	parent       string
	after        string
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

type folderDirectoryPage struct {
	candidates  []folderFileCandidate
	truncated   bool
	nextCursor  string
	maxRetained int
}

type folderDirectoryReader func(context.Context, string, string, string, string, int) (folderDirectoryPage, error)

type folderFileSelection []folderFileCandidate

func (values folderFileSelection) Len() int { return len(values) }
func (values folderFileSelection) Less(left, right int) bool {
	return values[left].path > values[right].path
}
func (values folderFileSelection) Swap(left, right int) {
	values[left], values[right] = values[right], values[left]
}
func (values *folderFileSelection) Push(value any) {
	*values = append(*values, value.(folderFileCandidate))
}
func (values *folderFileSelection) Pop() any {
	items := *values
	last := len(items) - 1
	value := items[last]
	*values = items[:last]
	return value
}

func selectFolderDirectoryCandidates(
	ctx context.Context,
	read directoryBatchReader,
	relative string,
	globalAfter string,
	pageAfter string,
	limit int,
) (folderDirectoryPage, error) {
	retainedLimit := limit + 1
	selected := make(folderFileSelection, 0, retainedLimit)
	heap.Init(&selected)
	maxRetained := 0
	for {
		if err := ctx.Err(); err != nil {
			return folderDirectoryPage{}, err
		}
		entries, readErr := read(folderDirectoryReadBatch)
		for _, entry := range entries {
			if entry.Name() == ".git" {
				continue
			}
			candidatePath := entry.Name()
			if relative != "" {
				candidatePath = relative + "/" + candidatePath
			}
			candidate := folderFileCandidate{path: candidatePath, directory: entry.IsDir()}
			if candidate.path <= pageAfter || !folderCandidateMayFollow(candidate, globalAfter) {
				continue
			}
			if selected.Len() < retainedLimit {
				heap.Push(&selected, candidate)
			} else if candidate.path < selected[0].path {
				selected[0] = candidate
				heap.Fix(&selected, 0)
			}
			if selected.Len() > maxRetained {
				maxRetained = selected.Len()
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			return folderDirectoryPage{}, readErr
		}
	}
	ordered := make([]folderFileCandidate, len(selected))
	copy(ordered, selected)
	sort.Slice(ordered, func(left, right int) bool { return ordered[left].path < ordered[right].path })
	page := folderDirectoryPage{candidates: ordered, maxRetained: maxRetained}
	if len(page.candidates) > limit {
		page.candidates = page.candidates[:limit]
		page.truncated = true
		page.nextCursor = page.candidates[len(page.candidates)-1].path
	}
	return page, nil
}

func readFolderDirectory(
	ctx context.Context,
	root string,
	relative string,
	globalAfter string,
	pageAfter string,
	limit int,
) (folderDirectoryPage, error) {
	absolute := root
	if relative != "" {
		absolute = filepath.Join(root, filepath.FromSlash(relative))
		info, err := os.Lstat(absolute)
		if err != nil {
			return folderDirectoryPage{}, err
		}
		// A directory replaced by a symlink while paging must never be followed.
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return folderDirectoryPage{}, nil
		}
	}
	directory, err := os.Open(absolute)
	if err != nil {
		return folderDirectoryPage{}, err
	}
	defer directory.Close()
	return selectFolderDirectoryCandidates(ctx, directory.ReadDir, relative, globalAfter, pageAfter, limit)
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
	candidates := make(folderFileCandidates, 0, limit+2)
	heap.Init(&candidates)
	enqueuePage := func(relative, cursor string) error {
		page, err := readDirectory(ctx, r.Root, relative, after, cursor, limit)
		if err != nil {
			return err
		}
		for _, candidate := range page.candidates {
			heap.Push(&candidates, candidate)
		}
		if page.truncated {
			// NUL is not valid in filesystem names and sorts immediately after the
			// retained candidate, allowing descendants to stay globally ordered.
			heap.Push(&candidates, folderFileCandidate{
				path: page.nextCursor + "\x00", continuation: true,
				parent: relative, after: page.nextCursor,
			})
		}
		return nil
	}
	if err := enqueuePage("", ""); err != nil {
		return protocol.RepositoryFiles{}, err
	}

	for candidates.Len() > 0 {
		if err := ctx.Err(); err != nil {
			return protocol.RepositoryFiles{}, err
		}
		if len(result.Paths) == limit {
			result.Truncated = true
			result.NextCursor = result.Paths[len(result.Paths)-1]
			return result, nil
		}
		candidate := heap.Pop(&candidates).(folderFileCandidate)
		switch {
		case candidate.continuation:
			if err := enqueuePage(candidate.parent, candidate.after); err != nil {
				return protocol.RepositoryFiles{}, err
			}
		case candidate.directory:
			if err := enqueuePage(candidate.path, ""); err != nil {
				return protocol.RepositoryFiles{}, err
			}
		default:
			result.Paths = append(result.Paths, candidate.path)
		}
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
