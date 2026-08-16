package gitx

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// ErrConflict is returned when a history mutation (cherry-pick, revert, or
// stash pop/apply) stops on unmerged paths. The operation stays in progress so
// the user can resolve; the UI surfaces the conflict and its resolution path.
var ErrConflict = errors.New("gitx: operation leaves unmerged conflicts")

// CherryPick applies the changes introduced by commit oid onto the current
// HEAD. On conflict git leaves a sequencer state behind and ErrConflict is
// returned so the UI can direct the user to resolve and continue.
func (r Repository) CherryPick(ctx context.Context, runner Runner, oid string) error {
	return r.replayCommit(ctx, runner, "cherry-pick", oid)
}

// Revert applies the inverse of commit oid onto the current HEAD. --no-edit
// keeps the operation non-interactive; conflicts surface as ErrConflict.
func (r Repository) Revert(ctx context.Context, runner Runner, oid string) error {
	return r.replayCommit(ctx, runner, "revert", oid)
}

func (r Repository) replayCommit(ctx context.Context, runner Runner, action, oid string) error {
	if err := validateRef(oid); err != nil {
		return err
	}
	res, err := runner.Run(ctx, r.Root, action, "--no-edit", oid)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		// The CONFLICT marker is written to stdout while the sequencer error
		// and hints go to stderr; check both to classify the failure.
		combined := string(res.Stdout) + "\n" + string(res.Stderr)
		if strings.Contains(combined, "CONFLICT") {
			return ErrConflict
		}
		return opError(action, res)
	}
	return nil
}

// ResetModes lists the git reset modes this workbench supports.
var ResetModes = []string{"soft", "mixed", "hard"}

// ErrInvalidResetMode reports a reset mode outside ResetModes.
var ErrInvalidResetMode = errors.New("gitx: unsupported reset mode")

// Reset moves the current branch to target. The mode selects how the index and
// worktree follow: soft keeps both, mixed unstages (default), and hard discards
// tracked changes. Hard is destructive and must only be issued after an
// explicit confirmation that names the target.
func (r Repository) Reset(ctx context.Context, runner Runner, target, mode string) error {
	switch mode {
	case "soft", "mixed", "hard":
	default:
		return fmt.Errorf("%w %q", ErrInvalidResetMode, mode)
	}
	if err := validateRef(target); err != nil {
		return err
	}
	res, err := runner.Run(ctx, r.Root, "reset", "--"+mode, target)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return opError("reset", res)
	}
	return nil
}
