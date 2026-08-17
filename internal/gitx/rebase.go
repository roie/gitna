package gitx

import (
	"context"
	"fmt"
	"strings"
)

// Rebase starts rebasing the current branch onto upstream. On success the
// rebase is clean. Conflicts leave the repository in a rebase-in-progress
// state so the client can resolve and continue.
func (r Repository) Rebase(ctx context.Context, runner Runner, upstream string) error {
	if err := validateRef(upstream); err != nil {
		return err
	}
	if op := DetectOperation(r); op != "none" {
		return fmt.Errorf("%w: %s in progress", ErrAlreadyInProgress, op)
	}
	res, err := runner.Run(ctx, r.Root, "rebase", upstream)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		combined := string(res.Stdout) + "\n" + string(res.Stderr)
		if strings.Contains(combined, "CONFLICT") {
			return ErrConflict
		}
		return opError("rebase", res)
	}
	return nil
}

// RebaseAbort aborts an in-progress rebase.
func (r Repository) RebaseAbort(ctx context.Context, runner Runner) error {
	res, err := runner.Run(ctx, r.Root, "rebase", "--abort")
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return opError("rebase --abort", res)
	}
	return nil
}

// RebaseContinue resumes a rebase after conflicts have been resolved and staged.
func (r Repository) RebaseContinue(ctx context.Context, runner Runner) error {
	if op := DetectOperation(r); op != "rebase" {
		return fmt.Errorf("gitx: no rebase in progress (operation=%s)", op)
	}
	res, err := runner.Run(ctx, r.Root, "rebase", "--continue")
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		combined := string(res.Stdout) + "\n" + string(res.Stderr)
		if strings.Contains(combined, "CONFLICT") {
			return ErrConflict
		}
		return opError("rebase --continue", res)
	}
	return nil
}
