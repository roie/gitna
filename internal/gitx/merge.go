package gitx

import (
	"context"
	"fmt"
)

// Merge starts a merge of branch into the current HEAD. On success the merge
// is committed (--no-edit uses the default message). Conflicts leave the
// repository in a merge-in-progress state; the snapshot's Operation field
// reflects this and the client can then resolve and continue.
func (r Repository) Merge(ctx context.Context, runner Runner, branch string) error {
	if err := r.validateCommitRevision(ctx, runner, branch); err != nil {
		return err
	}
	if op := DetectOperation(r); op != "none" {
		return fmt.Errorf("%w: %s in progress", ErrAlreadyInProgress, op)
	}
	res, err := runner.Run(ctx, r.Root, "merge", "--no-edit", branch)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		if conflicted, conflictErr := r.hasConflicts(ctx, runner); conflictErr == nil && conflicted {
			return nil // conflict started successfully — caller checks snapshot
		}
		return opError("merge", res)
	}
	return nil
}

// MergeAbort aborts an in-progress merge, restoring HEAD and the index.
func (r Repository) MergeAbort(ctx context.Context, runner Runner) error {
	res, err := runner.Run(ctx, r.Root, "merge", "--abort")
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return opError("merge --abort", res)
	}
	return nil
}

// MergeContinue resumes a merge after conflicts have been resolved and staged.
func (r Repository) MergeContinue(ctx context.Context, runner Runner) error {
	if op := DetectOperation(r); op != "merge" {
		return fmt.Errorf("gitx: no merge in progress (operation=%s)", op)
	}
	// Merge --continue creates a merge commit; suppress the editor.
	var run Runner = runner
	if er, ok := runner.(*ExecRunner); ok {
		clone := *er
		clone.Env = append(append([]string{}, er.Env...), "GIT_EDITOR=true")
		run = &clone
	}
	res, err := run.Run(ctx, r.Root, "merge", "--continue")
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		if conflicted, conflictErr := r.hasConflicts(ctx, runner); conflictErr == nil && conflicted {
			return ErrConflict
		}
		return opError("merge --continue", res)
	}
	return nil
}
