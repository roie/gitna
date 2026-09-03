package gitx

import (
	"context"
	"fmt"
)

// Rebase starts rebasing the current branch onto upstream. On success the
// rebase is clean. Conflicts leave the repository in a rebase-in-progress
// state so the client can resolve and continue.
func (r Repository) Rebase(ctx context.Context, runner Runner, upstream string) error {
	if err := r.validateCommitRevision(ctx, runner, upstream); err != nil {
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
		if conflicted, conflictErr := r.hasConflicts(ctx, runner); conflictErr == nil && conflicted {
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
	// A conflict continuation may create a commit and invoke the ordinary
	// commit-message editor. Preserve all runner settings while forcing a
	// non-interactive editor that accepts Git's prepared message.
	var run Runner = runner
	if er, ok := runner.(*ExecRunner); ok {
		clone := *er
		clone.Env = append(append([]string{}, er.Env...), "GIT_EDITOR=true")
		run = &clone
	}
	res, err := run.Run(ctx, r.Root, "rebase", "--continue")
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		if conflicted, conflictErr := r.hasConflicts(ctx, runner); conflictErr == nil && conflicted {
			return ErrConflict
		}
		return opError("rebase --continue", res)
	}
	return nil
}
