package gitx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/roie/gitna/internal/protocol"
)

// ErrStashConflict is returned when applying or popping a stash stops on
// unmerged paths. The stash entry is preserved by git so nothing is lost.
var ErrStashConflict = errors.New("gitx: stash does not apply cleanly")

// ErrNoStash is returned when an operation names a stash that no longer exists
// (the list shifted between the read and the action).
var ErrNoStash = errors.New("gitx: no such stash")

// stashListFormat is the machine-readable stash list. %gd is the stash@{n}
// reflog reference, %H the stash commit, and %gs the reflog subject carrying
// the branch and message recorded at save time.
const stashListFormat = "%gd%x00%H%x00%gs"

// ListStashes returns every stash with its current stash@{n} reference. The
// stash list is re-read after each stash mutation so indices stay valid.
func (r Repository) ListStashes(ctx context.Context, runner Runner) ([]protocol.StashEntry, error) {
	res, err := runner.Run(ctx, r.Root, "stash", "list", "--format="+stashListFormat)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, opError("stash list", res)
	}
	return parseStashList(res.Stdout)
}

// parseStashList splits the NUL-separated stash records. Each record is
// stash@{n}, oid, subject and is terminated by a newline.
func parseStashList(raw []byte) ([]protocol.StashEntry, error) {
	var stashes []protocol.StashEntry
	for _, rec := range bytes.Split(raw, []byte{'\n'}) {
		if len(bytes.TrimSpace(rec)) == 0 {
			continue
		}
		fields := bytes.Split(rec, []byte{0})
		if len(fields) != 3 {
			return nil, fmt.Errorf("gitx: malformed stash record %q", rec)
		}
		branch, message := parseStashSubject(string(fields[2]))
		stashes = append(stashes, protocol.StashEntry{
			Ref:     string(fields[0]),
			OID:     string(fields[1]),
			Message: message,
			Branch:  branch,
		})
	}
	return stashes, nil
}

// parseStashSubject extracts the branch and message from a stash reflog
// subject: "WIP on <branch>: <oid> <subject>" or "On <branch>: <message>".
func parseStashSubject(s string) (branch, message string) {
	subject := s
	for _, prefix := range []string{"WIP on ", "On "} {
		if rest, ok := strings.CutPrefix(subject, prefix); ok {
			subject = rest
			break
		}
	}
	if subject == s {
		return "", s
	}
	if b, msg, ok := strings.Cut(subject, ":"); ok {
		return strings.TrimSpace(b), strings.TrimSpace(msg)
	}
	return strings.TrimSpace(subject), ""
}

// StashPush saves the working-tree and index changes. Untracked files are
// included only when includeUntracked is set. With nothing to save, git exits
// zero and creates no stash, which is treated as success.
func (r Repository) StashPush(ctx context.Context, runner Runner, message string, includeUntracked bool) error {
	args := []string{"stash", "push"}
	if includeUntracked {
		args = append(args, "-u")
	}
	if message != "" {
		args = append(args, "-m", message)
	}
	res, err := runner.Run(ctx, r.Root, args...)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return opError("stash push", res)
	}
	return nil
}

// StashApply restores a stash onto the worktree, leaving the entry in place.
func (r Repository) StashApply(ctx context.Context, runner Runner, ref string) error {
	return r.stashOperate(ctx, runner, "stash apply", "apply", ref)
}

// StashPop restores a stash and removes the entry. On conflict the entry is
// kept by git and ErrStashConflict is returned.
func (r Repository) StashPop(ctx context.Context, runner Runner, ref string) error {
	return r.stashOperate(ctx, runner, "stash pop", "pop", ref)
}

// StashDrop removes a stash entry. The stash must already exist; refs that
// point at nothing map to ErrNoStash.
func (r Repository) StashDrop(ctx context.Context, runner Runner, ref string) error {
	return r.stashOperate(ctx, runner, "stash drop", "drop", ref)
}

func (r Repository) stashOperate(ctx context.Context, runner Runner, action, verb, ref string) error {
	if err := validateRevision(ref); err != nil {
		return err
	}
	verified, err := runner.Run(ctx, r.Root, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	if err != nil {
		return err
	}
	if verified.ExitCode != 0 {
		return ErrNoStash
	}
	res, err := runner.Run(ctx, r.Root, "stash", verb, ref)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		if conflicted, conflictErr := r.hasConflicts(ctx, runner); conflictErr == nil && conflicted {
			return ErrStashConflict
		}
		return opError(action, res)
	}
	return nil
}
