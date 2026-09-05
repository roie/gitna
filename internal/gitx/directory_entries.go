package gitx

import (
	"container/heap"
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"sort"
	"strings"

	"github.com/roie/gitna/internal/protocol"
)

type boundedDirectoryEntry struct {
	name      string
	directory bool
}

type boundedDirectoryEntries []boundedDirectoryEntry

func (entries boundedDirectoryEntries) Len() int { return len(entries) }

// The largest retained name is the heap root so a better candidate can replace it.
func (entries boundedDirectoryEntries) Less(left, right int) bool {
	return entries[left].name > entries[right].name
}
func (entries boundedDirectoryEntries) Swap(left, right int) {
	entries[left], entries[right] = entries[right], entries[left]
}
func (entries *boundedDirectoryEntries) Push(value any) {
	*entries = append(*entries, value.(boundedDirectoryEntry))
}
func (entries *boundedDirectoryEntries) Pop() any {
	values := *entries
	last := len(values) - 1
	value := values[last]
	*entries = values[:last]
	return value
}

type directoryBatchReader func(int) ([]fs.DirEntry, error)

// selectDirectoryEntries scans a directory in fixed-size batches while
// retaining only the next limit+1 names. The returned retained count is used
// by tests to enforce the memory bound independently of directory width.
func selectDirectoryEntries(
	ctx context.Context,
	read directoryBatchReader,
	after string,
	limit int,
) ([]boundedDirectoryEntry, int, error) {
	retainedLimit := limit + 1
	selected := make(boundedDirectoryEntries, 0, retainedLimit)
	heap.Init(&selected)
	maxRetained := 0
	for {
		if err := ctx.Err(); err != nil {
			return nil, maxRetained, err
		}
		entries, readErr := read(folderDirectoryReadBatch)
		for _, entry := range entries {
			name := entry.Name()
			if name == ".git" || name <= after {
				continue
			}
			candidate := boundedDirectoryEntry{name: name, directory: entry.IsDir()}
			if selected.Len() < retainedLimit {
				heap.Push(&selected, candidate)
			} else if name < selected[0].name {
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
			return nil, maxRetained, readErr
		}
	}
	ordered := make([]boundedDirectoryEntry, len(selected))
	copy(ordered, selected)
	sort.Slice(ordered, func(left, right int) bool { return ordered[left].name < ordered[right].name })
	return ordered, maxRetained, nil
}

func (r Repository) openDirectoryForScan(directory string) (*os.Root, *os.File, error) {
	directory = strings.TrimSuffix(directory, "/")
	if directory != "" {
		if err := validateWorktreePath(directory); err != nil {
			return nil, nil, err
		}
	}
	root, err := os.OpenRoot(r.Root)
	if err != nil {
		return nil, nil, err
	}

	// Check every ancestor without following symlinks. os.Root confines the
	// lookup, while Lstat makes the no-directory-symlink contract explicit.
	current := ""
	for _, segment := range strings.Split(directory, "/") {
		if segment == "" {
			continue
		}
		current = path.Join(current, segment)
		info, statErr := root.Lstat(current)
		if statErr != nil {
			root.Close()
			return nil, nil, statErr
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			root.Close()
			return nil, nil, fmt.Errorf("%w: %q is not a directory", protocol.ErrInvalidPath, current)
		}
	}

	openPath := directory
	if openPath == "" {
		openPath = "."
	}
	file, err := root.Open(openPath)
	if err != nil {
		root.Close()
		return nil, nil, err
	}
	return root, file, nil
}

func openedDirectoryMatches(info fs.FileInfo, file *os.File) bool {
	openedInfo, err := file.Stat()
	return err == nil && openedInfo.IsDir() && os.SameFile(info, openedInfo)
}

// directoryHasExplorerChildren peeks only far enough to determine whether a
// directory has a child visible in Explorer. Lstat and f.Stat identity checks
// prevent a replacement between validation and open from being treated as the
// validated directory. Filesystem errors and mismatches remain conservatively
// expandable so opening can surface the authoritative result.
func directoryHasExplorerChildren(ctx context.Context, root *os.Root, directory string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	info, err := root.Lstat(directory)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return true, nil
	}
	file, err := root.Open(directory)
	if err != nil {
		return true, nil
	}
	defer file.Close()
	if !openedDirectoryMatches(info, file) {
		return true, nil
	}
	for {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		entries, readErr := file.ReadDir(2)
		for _, entry := range entries {
			if entry.Name() != ".git" {
				return true, nil
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				return false, nil
			}
			return true, nil
		}
	}
}

func populateDirectoryEntryChildren(
	ctx context.Context,
	root *os.Root,
	entries []protocol.DirectoryEntry,
) error {
	for index := range entries {
		if entries[index].Kind != protocol.DirectoryEntryDirectory {
			continue
		}
		hasChildren, err := directoryHasExplorerChildren(
			ctx,
			root,
			strings.TrimSuffix(entries[index].Path, "/"),
		)
		if err != nil {
			return err
		}
		entries[index].HasChildren = &hasChildren
	}
	return nil
}

// PopulateDirectoryEntryChildren adds bounded, immediate-child metadata to a
// page produced by Gitna's disk-backed ordinary-folder directory index.
func (r Repository) PopulateDirectoryEntryChildren(
	ctx context.Context,
	entries []protocol.DirectoryEntry,
) error {
	root, err := os.OpenRoot(r.Root)
	if err != nil {
		return err
	}
	defer root.Close()
	return populateDirectoryEntryChildren(ctx, root, entries)
}

// ScanDirectoryEntries visits the immediate children of one validated
// directory in bounded read batches without following directory symlinks.
// Ordering is deliberately unspecified; callers that page results must impose
// and persist their own deterministic ordering.
func (r Repository) ScanDirectoryEntries(
	ctx context.Context,
	directory string,
	visit func(name string, directory bool) error,
) error {
	root, file, err := r.openDirectoryForScan(directory)
	if err != nil {
		return err
	}
	defer root.Close()
	defer file.Close()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		entries, readErr := file.ReadDir(folderDirectoryReadBatch)
		for _, entry := range entries {
			if entry.Name() == ".git" {
				continue
			}
			if err := visit(entry.Name(), entry.IsDir()); err != nil {
				return err
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				return nil
			}
			return readErr
		}
	}
}

// DirectoryEntries returns one deterministic page of immediate children. It
// never follows directory symlinks and keeps Git metadata outside Explorer.
func (r Repository) DirectoryEntries(
	ctx context.Context,
	directory string,
	after string,
	limit int,
) (protocol.DirectoryEntries, error) {
	result := protocol.DirectoryEntries{
		Directory: directory,
		Entries:   make([]protocol.DirectoryEntry, 0),
	}
	if limit <= 0 {
		return result, nil
	}
	directory = strings.TrimSuffix(directory, "/")
	if strings.Contains(after, "/") || after == "." || after == ".." {
		return protocol.DirectoryEntries{}, fmt.Errorf("%w: invalid directory cursor", protocol.ErrInvalidPath)
	}
	root, file, err := r.openDirectoryForScan(directory)
	if err != nil {
		return protocol.DirectoryEntries{}, err
	}
	defer root.Close()
	defer file.Close()

	entries, _, err := selectDirectoryEntries(ctx, file.ReadDir, after, limit)
	if err != nil {
		return protocol.DirectoryEntries{}, err
	}
	if len(entries) > limit {
		entries = entries[:limit]
		result.Truncated = true
	}
	for _, entry := range entries {
		kind := protocol.DirectoryEntryFile
		if entry.directory {
			kind = protocol.DirectoryEntryDirectory
		}
		entryPath := entry.name
		if directory != "" {
			entryPath = directory + "/" + entry.name
		}
		if kind == protocol.DirectoryEntryDirectory {
			entryPath += "/"
		}
		result.Entries = append(result.Entries, protocol.DirectoryEntry{
			Name: entry.name,
			Path: entryPath,
			Kind: kind,
		})
	}
	if result.Truncated {
		result.NextCursor = result.Entries[len(result.Entries)-1].Name
	}
	if err := populateDirectoryEntryChildren(ctx, root, result.Entries); err != nil {
		return protocol.DirectoryEntries{}, err
	}
	return result, nil
}
