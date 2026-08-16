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

// ErrPatchDoesNotApply is returned when git apply rejects a patch because the
// index or worktree no longer matches what the patch was generated against.
var ErrPatchDoesNotApply = errors.New("gitx: patch does not apply")

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

// DeleteUntracked removes the given untracked files from disk. Only regular
// files inside the repository root are removed; directories and symlinks that
// escape the root are refused.
func (r Repository) DeleteUntracked(ctx context.Context, runner Runner, paths []string) error {
	if err := validatePaths(paths); err != nil {
		return err
	}
	rootReal, err := filepath.EvalSymlinks(r.Root)
	if err != nil {
		rootReal = r.Root
	}
	for _, p := range paths {
		full := filepath.Join(rootReal, filepath.FromSlash(p))
		if !withinRoot(rootReal, full) {
			return fmt.Errorf("%w: %q", protocol.ErrNotInRepo, p)
		}
		real, err := filepath.EvalSymlinks(full)
		if err != nil {
			continue
		}
		if !withinRoot(rootReal, real) {
			return fmt.Errorf("%w: %q", protocol.ErrNotInRepo, p)
		}
		st, err := os.Stat(real)
		if err != nil {
			continue
		}
		if !st.Mode().IsRegular() {
			return fmt.Errorf("%w: %q is not a regular file", protocol.ErrInvalidPath, p)
		}
		if err := os.Remove(real); err != nil {
			return fmt.Errorf("gitx: remove %q: %w", p, err)
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
		return fmt.Errorf("gitx: patch exceeds %d bytes", maxPatchBytes)
	}
	args := []string{"apply", "--cached", "--whitespace=nowarn"}
	if reverse {
		args = append(args, "--reverse")
	}
	args = append(args, "-")
	res, err := runner.RunInput(ctx, r.Root, patch, args...)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		stderr := strings.TrimSpace(string(res.Stderr))
		if strings.Contains(stderr, "does not apply") {
			return ErrPatchDoesNotApply
		}
		return fmt.Errorf("gitx: apply: %s", stderr)
	}
	return nil
}
