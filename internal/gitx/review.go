package gitx

import (
	"context"
	"fmt"

	"github.com/roie/gitna/internal/protocol"
)

const (
	maxReviewPatchBytes  = 20 << 20
	maxReviewSupplements = 1000
)

// Review returns one bounded tracked patch for a repository surface plus the
// untracked worktree files that Git does not include in a normal diff. Every
// Git invocation disables external diff drivers, textconv, paging, and color.
func (r Repository) Review(ctx context.Context, runner Runner, scope protocol.DiffScope, opts protocol.DiffOptions) (protocol.ReviewResponse, error) {
	identity := protocol.ReviewIdentity{
		Scope:       scope,
		Commit:      opts.Commit,
		CompareFrom: opts.CompareFrom,
		CompareTo:   opts.CompareTo,
	}
	args, err := r.reviewArgs(ctx, runner, scope, opts)
	if err != nil {
		return protocol.ReviewResponse{}, err
	}
	res, err := runner.Run(ctx, r.Root, args...)
	if err != nil {
		return protocol.ReviewResponse{}, err
	}
	if res.ExitCode != 0 {
		return protocol.ReviewResponse{}, opError("load review", res)
	}
	if len(res.Stdout) > maxReviewPatchBytes {
		return protocol.ReviewResponse{}, protocol.ErrReviewTooLarge
	}

	review := protocol.ReviewResponse{
		Identity:    identity,
		Patch:       string(res.Stdout),
		Supplements: []protocol.ReviewSupplement{},
	}
	if scope != protocol.DiffUnstaged {
		return review, nil
	}

	snapshot, err := r.Status(ctx, runner)
	if err != nil {
		return protocol.ReviewResponse{}, err
	}
	for _, change := range snapshot.Unstaged {
		if change.Kind != protocol.KindUntracked {
			continue
		}
		if len(review.Supplements) >= maxReviewSupplements {
			return protocol.ReviewResponse{}, protocol.ErrReviewTooLarge
		}
		if err := ctx.Err(); err != nil {
			return protocol.ReviewResponse{}, err
		}
		content, tooLarge, present, err := r.readWorktree(change.Path, DefaultDiffBytes)
		if err != nil {
			return protocol.ReviewResponse{}, err
		}
		if !present {
			continue
		}
		diff := protocol.FileDiff{
			Before:   protocol.FileVersion{Path: change.Path, Language: languageFor(change.Path)},
			After:    protocol.FileVersion{Path: change.Path, Language: languageFor(change.Path)},
			TooLarge: tooLarge,
		}
		if !tooLarge {
			diff.Binary = isBinary(content)
			if !diff.Binary {
				diff.After.Content = string(content)
			}
		}
		review.Supplements = append(review.Supplements, protocol.ReviewSupplement{
			Path: change.Path,
			Kind: protocol.KindUntracked,
			Diff: diff,
		})
	}
	return review, nil
}

func (r Repository) reviewArgs(ctx context.Context, runner Runner, scope protocol.DiffScope, opts protocol.DiffOptions) ([]string, error) {
	prefix := []string{"-c", "diff.color=never", "-c", "core.pager=cat"}
	flags := []string{"--no-ext-diff", "--no-textconv", "--find-renames", "--patch"}
	switch scope {
	case protocol.DiffUnstaged:
		return append(append(prefix, "diff"), append(flags, "--")...), nil
	case protocol.DiffStaged:
		args := append(append(prefix, "diff"), flags...)
		return append(args, "--cached", "--"), nil
	case protocol.DiffCommit:
		if err := validateRef(opts.Commit); err != nil {
			return nil, err
		}
		parents, err := r.commitParents(ctx, runner, opts.Commit)
		if err != nil {
			return nil, err
		}
		if len(parents) == 0 {
			args := append(append(prefix, "show"), flags...)
			return append(args, "--format=", opts.Commit, "--"), nil
		}
		args := append(append(prefix, "diff"), flags...)
		return append(args, parents[0], opts.Commit, "--"), nil
	case protocol.DiffCompare:
		if err := validateRef(opts.CompareFrom); err != nil {
			return nil, err
		}
		if err := validateRef(opts.CompareTo); err != nil {
			return nil, err
		}
		args := append(append(prefix, "diff"), flags...)
		return append(args, opts.CompareFrom, opts.CompareTo, "--"), nil
	default:
		return nil, fmt.Errorf("gitx: unknown review scope %q", scope)
	}
}
