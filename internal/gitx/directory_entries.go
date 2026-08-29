package gitx

import (
	"context"
	"fmt"
	"os"
	"path"
	"sort"
	"strings"

	"github.com/roie/gitna/internal/protocol"
)

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

	entries, err := file.ReadDir(-1)
	if err != nil {
		return protocol.DirectoryEntries{}, err
	}
	sort.Slice(entries, func(left, right int) bool {
		return entries[left].Name() < entries[right].Name()
	})
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return protocol.DirectoryEntries{}, err
		}
		name := entry.Name()
		if name == ".git" || name <= after {
			continue
		}
		if len(result.Entries) == limit {
			result.Truncated = true
			result.NextCursor = result.Entries[len(result.Entries)-1].Name
			return result, nil
		}
		kind := protocol.DirectoryEntryFile
		if entry.IsDir() {
			kind = protocol.DirectoryEntryDirectory
		}
		entryPath := name
		if directory != "" {
			entryPath = directory + "/" + name
		}
		if kind == protocol.DirectoryEntryDirectory {
			entryPath += "/"
		}
		result.Entries = append(result.Entries, protocol.DirectoryEntry{
			Name: name,
			Path: entryPath,
			Kind: kind,
		})
	}
	return result, nil
}
