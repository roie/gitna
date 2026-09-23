package gitx

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/roie/gitna/internal/protocol"
)

// OpenWorktreeMedia pins a regular file inside the authorized root without
// allocating memory proportional to its size or following symlink aliases.
func (r Repository) OpenWorktreeMedia(ctx context.Context, path string) (*os.File, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := validateWorktreePath(path); err != nil {
		return nil, err
	}
	parts := strings.Split(path, "/")
	for _, part := range parts {
		if strings.EqualFold(strings.TrimRight(part, ". "), ".git") || strings.Contains(part, ":") {
			return nil, fmt.Errorf("%w: reserved path", protocol.ErrInvalidPath)
		}
	}
	root, err := os.OpenRoot(r.Root)
	if err != nil {
		return nil, err
	}
	defer func() { root.Close() }()
	// Pin each parent separately so a rename/symlink race cannot redirect a later
	// open into metadata or another directory after validation.
	for _, part := range parts[:len(parts)-1] {
		before, err := root.Lstat(part)
		if err != nil {
			return nil, err
		}
		if !before.IsDir() {
			return nil, fmt.Errorf("%w: non-directory parent", protocol.ErrInvalidPath)
		}
		child, err := root.OpenRoot(part)
		if err != nil {
			return nil, err
		}
		after, err := child.Stat(".")
		if err != nil || !os.SameFile(before, after) {
			child.Close()
			return nil, fmt.Errorf("%w: parent changed while opening", protocol.ErrInvalidPath)
		}
		root.Close()
		root = child
	}
	name := parts[len(parts)-1]
	before, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() {
		return nil, fmt.Errorf("%w: not a regular file", protocol.ErrInvalidPath)
	}
	file, err := root.OpenFile(name, os.O_RDONLY|mediaNonblock, 0)
	if err != nil {
		return nil, err
	}
	after, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	if !after.Mode().IsRegular() || !os.SameFile(before, after) {
		file.Close()
		return nil, fmt.Errorf("%w: file changed while opening", protocol.ErrInvalidPath)
	}
	if err := ctx.Err(); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}
