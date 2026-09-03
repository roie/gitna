package gitx

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/roie/gitna/internal/protocol"
)

// maxPatchBytes bounds patches accepted for index application.
const maxPatchBytes = 8 << 20 // 8 MiB

var (
	// ErrPatchDoesNotApply is returned when git apply rejects a patch because
	// the index or worktree no longer matches what the patch was generated against.
	ErrPatchDoesNotApply = errors.New("gitx: patch does not apply")
	// ErrPatchTooLarge is returned before invoking Git when an index patch
	// exceeds maxPatchBytes.
	ErrPatchTooLarge = errors.New("gitx: patch too large")
)

// validatePaths rejects empty path lists and every invalid path in them.
func validatePaths(paths []string) error {
	if len(paths) == 0 {
		return fmt.Errorf("%w: no paths", protocol.ErrInvalidPath)
	}
	for _, p := range paths {
		if err := validatePath(p); err != nil {
			return err
		}
	}
	return nil
}

func (r Repository) runIndex(ctx context.Context, runner Runner, args ...string) error {
	res, err := runner.Run(ctx, r.Root, args...)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("gitx: %s: %s", args[0], strings.TrimSpace(string(res.Stderr)))
	}
	return nil
}

// Stage adds the given paths to the index without touching the worktree.
func (r Repository) Stage(ctx context.Context, runner Runner, paths []string) error {
	if err := validatePaths(paths); err != nil {
		return err
	}
	return r.runIndex(ctx, runner, append([]string{"add", "--"}, paths...)...)
}

// Unstage removes the given paths from the index, leaving the worktree intact.
func (r Repository) Unstage(ctx context.Context, runner Runner, paths []string) error {
	if err := validatePaths(paths); err != nil {
		return err
	}
	return r.runIndex(ctx, runner, append([]string{"restore", "--staged", "--"}, paths...)...)
}

// DiscardTracked restores the given tracked paths in the worktree from the
// index, discarding local modifications.
func (r Repository) DiscardTracked(ctx context.Context, runner Runner, paths []string) error {
	if err := validatePaths(paths); err != nil {
		return err
	}
	return r.runIndex(ctx, runner, append([]string{"restore", "--worktree", "--"}, paths...)...)
}

// DeleteUntracked removes selected untracked filesystem entries. Regular files
// and symlinks are removed without following the selected entry; directories,
// special files, and paths escaping through a symlinked parent are refused.
func (r Repository) DeleteUntracked(ctx context.Context, runner Runner, paths []string) error {
	if err := validatePaths(paths); err != nil {
		return err
	}

	unique := make([]string, 0, len(paths))
	seen := make(map[string]struct{}, len(paths))
	for _, path := range paths {
		if _, ok := seen[path]; ok {
			continue
		}
		seen[path] = struct{}{}
		unique = append(unique, path)
	}

	args := append([]string{"ls-files", "--others", "--exclude-standard", "-z", "--"}, unique...)
	res, err := runner.Run(ctx, r.Root, args...)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return opError("list untracked files", res)
	}
	untracked := make(map[string]struct{})
	for _, path := range strings.Split(string(res.Stdout), "\x00") {
		if path != "" {
			untracked[path] = struct{}{}
		}
	}
	for _, path := range unique {
		if _, ok := untracked[path]; !ok {
			return fmt.Errorf("%w: %q is no longer untracked", protocol.ErrInvalidPath, path)
		}
	}

	rootReal, err := filepath.EvalSymlinks(r.Root)
	if err != nil {
		return fmt.Errorf("gitx: resolve repository root: %w", err)
	}
	targets := make([]string, 0, len(unique))
	for _, path := range unique {
		full := filepath.Join(rootReal, filepath.FromSlash(path))
		if !withinRoot(rootReal, full) {
			return fmt.Errorf("%w: %q", protocol.ErrNotInRepo, path)
		}
		parentReal, err := filepath.EvalSymlinks(filepath.Dir(full))
		if err != nil {
			return fmt.Errorf("%w: resolve parent for %q: %v", protocol.ErrInvalidPath, path, err)
		}
		if !withinRoot(rootReal, parentReal) {
			return fmt.Errorf("%w: %q", protocol.ErrNotInRepo, path)
		}
		target := filepath.Join(parentReal, filepath.Base(full))
		st, err := os.Lstat(target)
		if err != nil {
			return fmt.Errorf("%w: inspect %q: %v", protocol.ErrInvalidPath, path, err)
		}
		if !st.Mode().IsRegular() && st.Mode()&os.ModeSymlink == 0 {
			return fmt.Errorf("%w: %q is not a regular file or symlink", protocol.ErrInvalidPath, path)
		}
		targets = append(targets, target)
	}

	for i, target := range targets {
		if err := os.Remove(target); err != nil {
			return fmt.Errorf("gitx: remove %q: %w", unique[i], err)
		}
	}
	return nil
}

// ApplyPatch applies a unified diff patch to the index (git apply --cached).
// With reverse set, the patch is applied in reverse; unstaging a staged hunk
// is achieved by reverse-applying the staged diff. Stale patches are rejected
// by git and surface as ErrPatchDoesNotApply rather than being re-derived.
func (r Repository) ApplyPatch(ctx context.Context, runner Runner, patch []byte, reverse bool) error {
	if len(patch) == 0 {
		return fmt.Errorf("%w: empty patch", protocol.ErrInvalidPath)
	}
	if len(patch) > maxPatchBytes {
		return fmt.Errorf("%w: exceeds %d bytes", ErrPatchTooLarge, maxPatchBytes)
	}
	args := []string{"apply", "--cached", "--whitespace=nowarn"}
	if reverse {
		args = append(args, "--reverse")
	}
	args = append(args, "-")
	checkArgs := append([]string{}, args...)
	checkArgs = append(checkArgs[:len(checkArgs)-1], "--check", "-")
	checked, err := runner.RunInput(ctx, r.Root, patch, checkArgs...)
	if err != nil {
		return err
	}
	if checked.ExitCode != 0 {
		// `git apply --check` uses the same nonzero exit status for a stale patch
		// and for repository/index failures. Probe the index through a documented
		// porcelain command so infrastructure errors are not mislabeled as stale.
		health, healthErr := runner.Run(ctx, r.Root, "status", "--porcelain=v1", "-z", "--untracked-files=no")
		if healthErr != nil {
			return healthErr
		}
		if health.ExitCode != 0 {
			return opError("check index", health)
		}
		return ErrPatchDoesNotApply
	}
	res, err := runner.RunInput(ctx, r.Root, patch, args...)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		// The index may have changed between the applicability check and the
		// mutation. Confirm that race without parsing localized diagnostics; if
		// the patch is still applicable, preserve the actual operational error.
		rechecked, recheckErr := runner.RunInput(ctx, r.Root, patch, checkArgs...)
		if recheckErr != nil {
			return recheckErr
		}
		if rechecked.ExitCode != 0 {
			return ErrPatchDoesNotApply
		}
		return opError("apply", res)
	}
	return nil
}
