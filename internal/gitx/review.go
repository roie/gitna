package gitx

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/roie/gitna/internal/protocol"
)

const (
	maxReviewPageBytes = 8 << 20
	maxReviewPageFiles = 25
)

type reviewChange struct {
	Path    string
	OldPath string
	Kind    protocol.ChangeKind
}

// Review returns one bounded, deterministic page of a repository review. Each
// changed file appears on exactly one page; binary and oversized files advance
// the cursor as bounded placeholders instead of failing the whole review.
func (r Repository) Review(ctx context.Context, runner Runner, scope protocol.DiffScope, opts protocol.DiffOptions, after string) (protocol.ReviewPage, error) {
	identity := protocol.ReviewIdentity{
		Scope:       scope,
		Commit:      opts.Commit,
		CompareFrom: opts.CompareFrom,
		CompareTo:   opts.CompareTo,
	}
	changes, err := r.reviewChanges(ctx, runner, scope, opts)
	if err != nil {
		return protocol.ReviewPage{}, err
	}
	changes, hasMore, err := nextReviewChanges(ctx, changes, after, maxReviewPageFiles)
	if err != nil {
		return protocol.ReviewPage{}, err
	}

	response := protocol.ReviewResponse{
		Identity:    identity,
		Patch:       "",
		Supplements: make([]protocol.ReviewSupplement, 0, len(changes)),
	}
	pageBytes := 0
	nextIndex := 0
	for nextIndex < len(changes) {
		if err := ctx.Err(); err != nil {
			return protocol.ReviewPage{}, err
		}
		change := changes[nextIndex]
		diffOpts := opts
		diffOpts.Path = change.Path
		diffOpts.OldPath = change.OldPath
		diff, err := r.reviewDiff(ctx, runner, scope, diffOpts)
		if err != nil {
			return protocol.ReviewPage{}, err
		}
		supplement := protocol.ReviewSupplement{Path: change.Path, Kind: change.Kind, Diff: diff}
		size, err := reviewSupplementSize(supplement)
		if err != nil {
			return protocol.ReviewPage{}, err
		}
		if pageBytes+size > maxReviewPageBytes {
			if len(response.Supplements) > 0 {
				break
			}
			supplement.Diff.Before.Content = ""
			supplement.Diff.After.Content = ""
			supplement.Diff.Before.Image = nil
			supplement.Diff.After.Image = nil
			supplement.Diff.TooLarge = true
			size, err = reviewSupplementSize(supplement)
			if err != nil {
				return protocol.ReviewPage{}, err
			}
		}
		response.Supplements = append(response.Supplements, supplement)
		pageBytes += size
		nextIndex++
	}

	page := protocol.ReviewPage{Response: response}
	if (nextIndex < len(changes) || hasMore) && len(response.Supplements) > 0 {
		page.NextAfter = reviewChangeKey(changes[nextIndex-1])
	}
	return page, nil
}

// nextReviewChanges keeps only the smallest bounded keyset after the cursor.
// This avoids sorting the complete manifest and checks cancellation while
// scanning it. Production runner output is independently capped by Runner.
func nextReviewChanges(ctx context.Context, changes []reviewChange, after string, limit int) ([]reviewChange, bool, error) {
	selected := make([]reviewChange, 0, min(limit, len(changes)))
	eligible := 0
	for _, change := range changes {
		if err := ctx.Err(); err != nil {
			return nil, false, err
		}
		key := reviewChangeKey(change)
		if key <= after {
			continue
		}
		eligible++
		index := sort.Search(len(selected), func(index int) bool {
			return reviewChangeKey(selected[index]) >= key
		})
		if index >= limit {
			continue
		}
		if len(selected) < limit {
			selected = append(selected, reviewChange{})
		}
		copy(selected[index+1:], selected[index:])
		selected[index] = change
	}
	return selected, eligible > len(selected), nil
}

func (r Repository) reviewChanges(ctx context.Context, runner Runner, scope protocol.DiffScope, opts protocol.DiffOptions) ([]reviewChange, error) {
	var changes []reviewChange
	switch scope {
	case protocol.DiffUnstaged, protocol.DiffStaged:
		status, err := r.Status(ctx, runner)
		if err != nil {
			return nil, err
		}
		selected := status.Unstaged
		if scope == protocol.DiffStaged {
			selected = status.Staged
		}
		changes = make([]reviewChange, 0, len(selected))
		for _, change := range selected {
			changes = append(changes, reviewChange{Path: change.Path, OldPath: change.OldPath, Kind: change.Kind})
		}
	case protocol.DiffCommit:
		files, err := r.ChangedFiles(ctx, runner, opts.Commit)
		if err != nil {
			return nil, err
		}
		changes = commitReviewChanges(files)
	case protocol.DiffCompare:
		files, err := r.CompareFiles(ctx, runner, opts.CompareFrom, opts.CompareTo)
		if err != nil {
			return nil, err
		}
		changes = commitReviewChanges(files)
	default:
		return nil, fmt.Errorf("gitx: unknown review scope %q", scope)
	}
	return changes, nil
}

func commitReviewChanges(files []protocol.CommitFile) []reviewChange {
	changes := make([]reviewChange, 0, len(files))
	for _, file := range files {
		changes = append(changes, reviewChange{Path: file.Path, OldPath: file.OldPath, Kind: file.Kind})
	}
	return changes
}

func reviewChangeKey(change reviewChange) string {
	return change.Path + "\x00" + change.OldPath
}

func reviewSupplementSize(supplement protocol.ReviewSupplement) (int, error) {
	encoded, err := json.Marshal(supplement)
	if err != nil {
		return 0, fmt.Errorf("gitx: encode review supplement: %w", err)
	}
	return len(encoded), nil
}
