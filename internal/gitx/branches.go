package gitx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/roie/gitna/internal/protocol"
)

// ErrBranchNotMerged is returned by DeleteBranch when git branch -d refuses
// because the branch is not fully merged and force was not requested. The
// caller can then ask for explicit confirmation before retrying with force.
var ErrBranchNotMerged = errors.New("gitx: branch is not fully merged")

// branchListFormat emits one record per ref with NUL-separated fields and a
// newline terminator. HEAD is a literal asterisk for the checked-out branch;
// upstream:track is empty when the branch has no upstream or is in sync.
const branchListFormat = "%(refname)%00%(objectname)%00%(HEAD)%00%(upstream)%00%(upstream:track)"

// ListBranches returns the local and remote branches known to the repository,
// each with its upstream relationship. The output of git for-each-ref is parsed
// as machine records; git branch presentation output is never used.
func (r Repository) ListBranches(ctx context.Context, runner Runner) ([]protocol.Branch, error) {
	res, err := runner.Run(ctx, r.Root,
		"for-each-ref", "--format="+branchListFormat, "refs/heads", "refs/remotes",
	)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, opError("for-each-ref", res)
	}
	return ParseForEachRef(res.Stdout)
}

// ParseForEachRef parses the NUL-separated records emitted by
// `git for-each-ref --format="refname\0objectname\0HEAD\0upstream\0track"`.
// Empty trailing fields are omitted by git, so each record has four or five
// fields; the record terminator is a newline.
func ParseForEachRef(raw []byte) ([]protocol.Branch, error) {
	var branches []protocol.Branch
	for _, rec := range bytes.Split(raw, []byte{'\n'}) {
		if len(bytes.TrimSpace(rec)) == 0 {
			continue
		}
		fields := bytes.Split(rec, []byte{0})
		if len(fields) < 4 {
			return nil, fmt.Errorf("gitx: malformed for-each-ref record %q", rec)
		}
		name, remote, err := splitRef(string(fields[0]))
		if err != nil {
			return nil, err
		}
		upstream := string(fields[3])
		up := ""
		if !remote && upstream != "" {
			up = strings.TrimPrefix(upstream, "refs/remotes/")
		}
		var track string
		if len(fields) > 4 {
			track = string(fields[4])
		}
		ahead, behind, err := parseTrack(track)
		if err != nil {
			return nil, err
		}
		branches = append(branches, protocol.Branch{
			Name:     name,
			OID:      string(fields[1]),
			Current:  string(fields[2]) == "*",
			Remote:   remote,
			Upstream: up,
			Ahead:    ahead,
			Behind:   behind,
		})
	}
	return branches, nil
}

// splitRef maps a ref name to its display name and whether it is a remote
// tracking ref.
func splitRef(refname string) (name string, remote bool, err error) {
	switch {
	case strings.HasPrefix(refname, "refs/heads/"):
		return strings.TrimPrefix(refname, "refs/heads/"), false, nil
	case strings.HasPrefix(refname, "refs/remotes/"):
		return strings.TrimPrefix(refname, "refs/remotes/"), true, nil
	default:
		return "", false, fmt.Errorf("gitx: unexpected ref name %q", refname)
	}
}

// parseTrack parses `%(upstream:track)` values: "[ahead 3]", "[behind 2]",
// "[ahead 1, behind 2]", "[gone]", or empty.
func parseTrack(s string) (ahead, behind int, err error) {
	if s == "" || s == "[gone]" {
		return 0, 0, nil
	}
	inner := strings.TrimSuffix(strings.TrimPrefix(s, "["), "]")
	for _, part := range strings.Split(inner, ",") {
		fields := strings.Fields(part)
		if len(fields) != 2 {
			return 0, 0, fmt.Errorf("gitx: malformed upstream track %q", s)
		}
		n, err := strconv.Atoi(fields[1])
		if err != nil || n < 0 {
			return 0, 0, fmt.Errorf("gitx: malformed upstream track %q", s)
		}
		switch fields[0] {
		case "ahead":
			ahead = n
		case "behind":
			behind = n
		default:
			return 0, 0, fmt.Errorf("gitx: malformed upstream track %q", s)
		}
	}
	return ahead, behind, nil
}

// SwitchBranch moves the worktree to the given branch. Uncommitted changes are
// carried along by git switch unless they conflict with the target.
func (r Repository) SwitchBranch(ctx context.Context, runner Runner, name string) error {
	if err := validateRef(name); err != nil {
		return err
	}
	res, err := runner.Run(ctx, r.Root, "switch", name)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return opError("switch", res)
	}
	return nil
}

// CreateBranch creates a new branch at start (HEAD when empty) and switches to
// it. The name must be a valid ref name and start a valid ref or oid.
func (r Repository) CreateBranch(ctx context.Context, runner Runner, name, start string) error {
	if err := validateRef(name); err != nil {
		return err
	}
	args := []string{"switch", "-c", name}
	if start != "" {
		if err := validateRef(start); err != nil {
			return err
		}
		args = append(args, start)
	}
	res, err := runner.Run(ctx, r.Root, args...)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return opError("create branch", res)
	}
	return nil
}

// DeleteBranch deletes the branch name. Without force, git branch -d refuses a
// branch that is not fully merged and ErrBranchNotMerged is returned so the
// caller can ask for explicit confirmation. Force maps to git branch -D and
// must only be requested by the user after that confirmation.
func (r Repository) DeleteBranch(ctx context.Context, runner Runner, name string, force bool) error {
	if err := validateRef(name); err != nil {
		return err
	}
	flag := "-d"
	if force {
		flag = "-D"
	}
	res, err := runner.Run(ctx, r.Root, "branch", flag, name)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		if strings.Contains(string(res.Stderr), "not fully merged") {
			return ErrBranchNotMerged
		}
		return opError("delete branch", res)
	}
	return nil
}
