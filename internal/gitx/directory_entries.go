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
	if directory != "" {
		if err := validateWorktreePath(directory); err != nil {
			return protocol.DirectoryEntries{}, err
		}
	}
	if strings.Contains(after, "/") || after == "." || after == ".." {
		return protocol.DirectoryEntries{}, fmt.Errorf("%w: invalid directory cursor", protocol.ErrInvalidPath)
	}
	root, err := os.OpenRoot(r.Root)
	if err != nil {
		return protocol.DirectoryEntries{}, err
	}
	defer root.Close()

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
			return protocol.DirectoryEntries{}, statErr
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return protocol.DirectoryEntries{}, fmt.Errorf("%w: %q is not a directory", protocol.ErrInvalidPath, current)
		}
	}

	openPath := directory
	if openPath == "" {
		openPath = "."
	}
	file, err := root.Open(openPath)
	if err != nil {
		return protocol.DirectoryEntries{}, err
	}
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
	return result, nil
}
