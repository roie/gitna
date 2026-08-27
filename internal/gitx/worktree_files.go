package gitx

import (
	"context"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	slashpath "path"
	"path/filepath"
	"strings"

	"github.com/roie/gitna/internal/protocol"
)

// ReadWorktreeFile returns one bounded, regular text file from the worktree.
func (r Repository) ReadWorktreeFile(ctx context.Context, path string) (protocol.WorktreeFile, error) {
	if err := ctx.Err(); err != nil {
		return protocol.WorktreeFile{}, err
	}
	_, info, err := r.resolveWorktreeEntry(path, true)
	if err != nil {
		return protocol.WorktreeFile{}, err
	}
	if !info.Mode().IsRegular() {
		return protocol.WorktreeFile{}, fmt.Errorf("%w: %q is not a regular file", protocol.ErrInvalidPath, path)
	}
	if info.Size() > DefaultDiffBytes {
		return protocol.WorktreeFile{}, fmt.Errorf("%w: %q", protocol.ErrWorktreeFileTooLarge, path)
	}
	data, err := r.readBoundedWorktreeFile(path)
	if err != nil {
		return protocol.WorktreeFile{}, err
	}
	if isBinary(data) {
		return protocol.WorktreeFile{}, fmt.Errorf("%w: %q", protocol.ErrWorktreeBinary, path)
	}
	return worktreeFile(path, data), nil
}

// WriteWorktreeFile atomically replaces an existing regular text file when its
// current content still matches expectedHash.
func (r Repository) WriteWorktreeFile(ctx context.Context, path, content, expectedHash string) (protocol.WorktreeFile, error) {
	if err := ctx.Err(); err != nil {
		return protocol.WorktreeFile{}, err
	}
	if len(content) > DefaultDiffBytes {
		return protocol.WorktreeFile{}, fmt.Errorf("%w: %q", protocol.ErrWorktreeFileTooLarge, path)
	}
	data := []byte(content)
	if isBinary(data) {
		return protocol.WorktreeFile{}, fmt.Errorf("%w: %q", protocol.ErrWorktreeBinary, path)
	}
	_, info, err := r.resolveWorktreeEntry(path, true)
	if err != nil {
		return protocol.WorktreeFile{}, err
	}
	if !info.Mode().IsRegular() {
		return protocol.WorktreeFile{}, fmt.Errorf("%w: %q is not a regular file", protocol.ErrInvalidPath, path)
	}
	current, err := r.readBoundedWorktreeFile(path)
	if err != nil {
		return protocol.WorktreeFile{}, err
	}
	if worktreeHash(current) != expectedHash {
		return protocol.WorktreeFile{}, fmt.Errorf("%w: %q", protocol.ErrWorktreeConflict, path)
	}

	root, err := os.OpenRoot(r.Root)
	if err != nil {
		return protocol.WorktreeFile{}, err
	}
	defer root.Close()
	temporaryPath, temporary, err := createWorktreeTemp(root, path)
	if err != nil {
		return protocol.WorktreeFile{}, err
	}
	defer root.Remove(temporaryPath)
	if err := temporary.Chmod(info.Mode().Perm()); err != nil {
		temporary.Close()
		return protocol.WorktreeFile{}, err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return protocol.WorktreeFile{}, err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return protocol.WorktreeFile{}, err
	}
	if err := temporary.Close(); err != nil {
		return protocol.WorktreeFile{}, err
	}
	latest, err := r.readBoundedWorktreeFile(path)
	if err != nil {
		return protocol.WorktreeFile{}, err
	}
	if worktreeHash(latest) != expectedHash {
		return protocol.WorktreeFile{}, fmt.Errorf("%w: %q", protocol.ErrWorktreeConflict, path)
	}
	if err := root.Rename(temporaryPath, path); err != nil {
		return protocol.WorktreeFile{}, fmt.Errorf("replace file: %w", err)
	}
	return worktreeFile(path, data), nil
}

// CreateWorktreeEntry creates one empty file or directory without overwriting
// an existing entry. Parent directories must already exist.
func (r Repository) CreateWorktreeEntry(ctx context.Context, path string, directory bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateWorktreePath(path); err != nil {
		return err
	}
	root, err := os.OpenRoot(r.Root)
	if err != nil {
		return err
	}
	defer root.Close()
	if directory {
		err = root.Mkdir(path, 0o755)
	} else {
		var file *os.File
		file, err = root.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err == nil {
			err = file.Close()
		}
	}
	if errors.Is(err, os.ErrExist) {
		return fmt.Errorf("%w: %q", protocol.ErrWorktreeEntryExists, path)
	}
	return err
}

// RenameWorktreeEntry moves one file or directory without overwriting the
// destination.
func (r Repository) RenameWorktreeEntry(ctx context.Context, source, destination string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	sourcePath, sourceInfo, err := r.resolveWorktreeEntry(source, false)
	if err != nil {
		return err
	}
	destinationPath, err := r.resolveNewWorktreeEntry(destination)
	if err != nil {
		return err
	}
	if strings.HasPrefix(destinationPath+string(filepath.Separator), sourcePath+string(filepath.Separator)) {
		return fmt.Errorf("%w: cannot move %q inside itself", protocol.ErrInvalidPath, source)
	}
	if sourceInfo.Mode().IsRegular() {
		root, err := os.OpenRoot(r.Root)
		if err != nil {
			return err
		}
		defer root.Close()
		if err := root.Link(source, destination); err != nil {
			if errors.Is(err, os.ErrExist) {
				return fmt.Errorf("%w: %q", protocol.ErrWorktreeEntryExists, destination)
			}
			return err
		}
		if err := root.Remove(source); err != nil {
			_ = root.Remove(destination)
			return err
		}
		return nil
	}
	if !sourceInfo.IsDir() {
		return fmt.Errorf("%w: %q is not a regular file or directory", protocol.ErrInvalidPath, source)
	}
	root, err := os.OpenRoot(r.Root)
	if err != nil {
		return err
	}
	defer root.Close()
	if err := root.Rename(source, destination); err != nil {
		if errors.Is(err, os.ErrExist) {
			return fmt.Errorf("%w: %q", protocol.ErrWorktreeEntryExists, destination)
		}
		return err
	}
	return nil
}

func (r Repository) resolveWorktreeEntry(path string, rejectSymlink bool) (string, os.FileInfo, error) {
	if err := validateWorktreePath(path); err != nil {
		return "", nil, err
	}
	rootReal, err := filepath.EvalSymlinks(r.Root)
	if err != nil {
		return "", nil, err
	}
	full := filepath.Join(rootReal, filepath.FromSlash(path))
	parentReal, err := filepath.EvalSymlinks(filepath.Dir(full))
	if err != nil {
		return "", nil, fmt.Errorf("%w: resolve parent for %q: %v", protocol.ErrInvalidPath, path, err)
	}
	if !withinRoot(rootReal, parentReal) {
		return "", nil, fmt.Errorf("%w: %q", protocol.ErrNotInRepo, path)
	}
	target := filepath.Join(parentReal, filepath.Base(full))
	info, err := os.Lstat(target)
	if err != nil {
		return "", nil, err
	}
	if rejectSymlink && info.Mode()&os.ModeSymlink != 0 {
		return "", nil, fmt.Errorf("%w: symlink %q", protocol.ErrInvalidPath, path)
	}
	return target, info, nil
}

func (r Repository) resolveNewWorktreeEntry(path string) (string, error) {
	if err := validateWorktreePath(path); err != nil {
		return "", err
	}
	rootReal, err := filepath.EvalSymlinks(r.Root)
	if err != nil {
		return "", err
	}
	full := filepath.Join(rootReal, filepath.FromSlash(path))
	parentReal, err := filepath.EvalSymlinks(filepath.Dir(full))
	if err != nil {
		return "", fmt.Errorf("%w: resolve parent for %q: %v", protocol.ErrInvalidPath, path, err)
	}
	if !withinRoot(rootReal, parentReal) {
		return "", fmt.Errorf("%w: %q", protocol.ErrNotInRepo, path)
	}
	target := filepath.Join(parentReal, filepath.Base(full))
	if _, err := os.Lstat(target); err == nil {
		return "", fmt.Errorf("%w: %q", protocol.ErrWorktreeEntryExists, path)
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	return target, nil
}

func validateWorktreePath(path string) error {
	if err := validatePath(path); err != nil {
		return err
	}
	if strings.Contains(path, `\`) || filepath.VolumeName(filepath.FromSlash(path)) != "" {
		return fmt.Errorf("%w: platform-specific path %q", protocol.ErrInvalidPath, path)
	}
	if path == ".git" || strings.HasPrefix(path, ".git/") {
		return fmt.Errorf("%w: Git metadata", protocol.ErrInvalidPath)
	}
	return nil
}

func createWorktreeTemp(root *os.Root, path string) (string, *os.File, error) {
	var random [12]byte
	for range 10 {
		if _, err := cryptorand.Read(random[:]); err != nil {
			return "", nil, err
		}
		name := ".gitna-edit-" + hex.EncodeToString(random[:])
		if parent := slashpath.Dir(path); parent != "." {
			name = slashpath.Join(parent, name)
		}
		file, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			return name, file, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return "", nil, err
		}
	}
	return "", nil, errors.New("could not allocate temporary worktree file")
}

func (r Repository) readBoundedWorktreeFile(path string) ([]byte, error) {
	root, err := os.OpenRoot(r.Root)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	info, err := root.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("%w: symlink %q", protocol.ErrInvalidPath, path)
	}
	file, err := root.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !openedInfo.Mode().IsRegular() {
		return nil, fmt.Errorf("%w: %q is not a regular file", protocol.ErrInvalidPath, path)
	}
	data, err := io.ReadAll(io.LimitReader(file, DefaultDiffBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > DefaultDiffBytes {
		return nil, fmt.Errorf("%w: %q", protocol.ErrWorktreeFileTooLarge, path)
	}
	return data, nil
}

func worktreeFile(path string, data []byte) protocol.WorktreeFile {
	return protocol.WorktreeFile{Path: path, Content: string(data), Hash: worktreeHash(data)}
}

func worktreeHash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
