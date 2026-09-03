package gitx

import (
	"bytes"
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/roie/gitna/internal/protocol"
)

// DefaultHistoryLimit is the initial page size for history requests. Pages are
// bounded so a busy repository cannot ship unbounded output.
const DefaultHistoryLimit = 100

// maxHistoryLimit caps a single history page request.
const maxHistoryLimit = 501

// logFormat is the machine-delimited pretty format used for history. Fields
// are separated by NUL, a byte that cannot appear in any commit field (so a
// subject cannot smuggle a delimiter), and records are newline-separated. The
// decoration field %D carries --decorate=full names.
const logFormat = "%H%x00%P%x00%s%x00%an%x00%aI%x00%D"

// History returns up to limit commits reachable from the current HEAD.
func (r Repository) History(ctx context.Context, runner Runner, skip, limit int) ([]protocol.GraphCommit, error) {
	return r.HistoryAt(ctx, runner, "HEAD", skip, limit)
}

// HistoryAt returns up to limit commits reachable from one immutable tip.
// --max-count bounds the page so the runner's output cap is a backstop rather
// than the primary protection.
func (r Repository) HistoryAt(ctx context.Context, runner Runner, tip string, skip, limit int) ([]protocol.GraphCommit, error) {
	if err := r.validateCommitRevision(ctx, runner, tip); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = DefaultHistoryLimit
	}
	if limit > maxHistoryLimit {
		return nil, fmt.Errorf("gitx: history limit %d exceeds maximum %d", limit, maxHistoryLimit)
	}
	if skip < 0 {
		return nil, fmt.Errorf("gitx: history skip %d must not be negative", skip)
	}
	args := []string{
		"log", "--topo-order", "--decorate=full",
		"--decorate-refs-exclude=refs/remotes/*/HEAD",
		"--pretty=format:" + logFormat,
	}
	if skip > 0 {
		args = append(args, "--skip", strconv.Itoa(skip))
	}
	args = append(args, "--max-count", strconv.Itoa(limit), tip)

	res, err := runner.Run(ctx, r.Root, args...)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, fmt.Errorf("gitx: log failed: %s", strings.TrimSpace(string(res.Stderr)))
	}
	return ParseLog(res.Stdout)
}

// HistoryCount returns the exact number of commits reachable from tip. In a
// shallow clone this is the exact locally reachable history up to its boundary.
func (r Repository) HistoryCount(ctx context.Context, runner Runner, tip string) (int, error) {
	if err := r.validateCommitRevision(ctx, runner, tip); err != nil {
		return 0, err
	}
	res, err := runner.Run(ctx, r.Root, "rev-list", "--count", tip)
	if err != nil {
		return 0, err
	}
	if res.ExitCode != 0 {
		return 0, fmt.Errorf("gitx: history count failed: %s", strings.TrimSpace(string(res.Stderr)))
	}
	total, err := strconv.Atoi(strings.TrimSpace(string(res.Stdout)))
	if err != nil || total < 0 {
		return 0, fmt.Errorf("gitx: malformed history count %q", strings.TrimSpace(string(res.Stdout)))
	}
	return total, nil
}

// ParseLog parses the NUL-delimited git log records emitted by History into
// protocol types. One record per commit; fields are %H %P %s %an %aI %D.
func ParseLog(raw []byte) ([]protocol.GraphCommit, error) {
	commits := make([]protocol.GraphCommit, 0)
	for _, record := range bytes.Split(raw, []byte{'\n'}) {
		if len(record) == 0 {
			continue
		}
		fields := bytes.SplitN(record, []byte{0}, 6)
		if len(fields) != 6 {
			return nil, fmt.Errorf("gitx: malformed log record %q", record)
		}
		parents := make([]string, 0)
		for _, p := range bytes.Fields(fields[1]) {
			parents = append(parents, string(p))
		}
		authorTime, err := time.Parse(time.RFC3339, string(fields[4]))
		if err != nil {
			return nil, fmt.Errorf("gitx: malformed author time %q in record %q", fields[4], record)
		}
		commits = append(commits, protocol.GraphCommit{
			OID:        string(fields[0]),
			Parents:    parents,
			Subject:    string(fields[2]),
			AuthorName: string(fields[3]),
			AuthorTime: authorTime,
			Refs:       parseRefs(string(fields[5])),
		})
	}
	return commits, nil
}

// parseRefs parses a --decorate=full decoration string into typed refs. The
// format is a comma-separated list such as
// "HEAD -> refs/heads/main, tag: refs/tags/v1.0, refs/remotes/origin/main".
// Ref name prefixes are stripped so the browser renders friendly labels.
func parseRefs(decoration string) []protocol.CommitRef {
	refs := make([]protocol.CommitRef, 0)
	for _, part := range strings.Split(decoration, ",") {
		part = strings.TrimSpace(part)
		switch {
		case part == "":
			continue
		case strings.HasPrefix(part, "HEAD -> "):
			refs = append(refs, protocol.CommitRef{Name: refName(strings.TrimPrefix(part, "HEAD -> ")), Kind: protocol.RefKindHead})
		case part == "HEAD":
			refs = append(refs, protocol.CommitRef{Name: "HEAD", Kind: protocol.RefKindHead})
		case strings.HasPrefix(part, "tag: "):
			refs = append(refs, protocol.CommitRef{Name: refName(strings.TrimPrefix(part, "tag: ")), Kind: protocol.RefKindTag})
		case strings.HasPrefix(part, "refs/remotes/"):
			refs = append(refs, protocol.CommitRef{Name: strings.TrimPrefix(part, "refs/remotes/"), Kind: protocol.RefKindRemoteBranch})
		case strings.HasPrefix(part, "refs/heads/"):
			refs = append(refs, protocol.CommitRef{Name: strings.TrimPrefix(part, "refs/heads/"), Kind: protocol.RefKindLocalBranch})
		default:
			refs = append(refs, protocol.CommitRef{Name: part, Kind: protocol.RefKindLocalBranch})
		}
	}
	return refs
}

// refName strips the common ref namespace prefixes so "refs/heads/main"
// becomes "main" and "refs/tags/v1.0" becomes "v1.0".
func refName(s string) string {
	for _, prefix := range []string{"refs/heads/", "refs/remotes/", "refs/tags/"} {
		if strings.HasPrefix(s, prefix) {
			return strings.TrimPrefix(s, prefix)
		}
	}
	return s
}

// ChangedFiles returns the paths changed by the given commit in name-status
// shape with rename detection. A root commit is compared against the empty
// tree; a merge commit is compared against its first parent, matching what the
// browser shows as the merge's change set.
func (r Repository) ChangedFiles(ctx context.Context, runner Runner, oid string) ([]protocol.CommitFile, error) {
	if err := r.validateCommitRevision(ctx, runner, oid); err != nil {
		return nil, err
	}
	parents, err := r.commitParents(ctx, runner, oid)
	if err != nil {
		return nil, err
	}
	args := []string{"diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "--find-renames"}
	if len(parents) == 0 {
		args = append(args, "--root", oid)
	} else {
		args = append(args, parents[0], oid)
	}
	res, err := runner.Run(ctx, r.Root, args...)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, fmt.Errorf("gitx: diff-tree failed for %s: %s", oid, strings.TrimSpace(string(res.Stderr)))
	}
	return ParseDiffTree(res.Stdout)
}

// CompareFiles returns the name-status change set between two refs in the same
// shape as ChangedFiles, so the compare view can reuse the diff pipeline.
func (r Repository) CompareFiles(ctx context.Context, runner Runner, from, to string) ([]protocol.CommitFile, error) {
	if err := r.validateCommitRevision(ctx, runner, from); err != nil {
		return nil, err
	}
	if err := r.validateCommitRevision(ctx, runner, to); err != nil {
		return nil, err
	}
	res, err := runner.Run(ctx, r.Root, "diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "--find-renames", from, to)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, fmt.Errorf("gitx: diff-tree failed for %s..%s: %s", from, to, strings.TrimSpace(string(res.Stderr)))
	}
	return ParseDiffTree(res.Stdout)
}

// commitParents resolves the parent OIDs of a commit. The root commit yields
// an empty slice.
func (r Repository) commitParents(ctx context.Context, runner Runner, oid string) ([]string, error) {
	res, err := runner.Run(ctx, r.Root, "rev-list", "--parents", "-n", "1", oid)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, fmt.Errorf("gitx: unknown commit %s: %s", oid, strings.TrimSpace(string(res.Stderr)))
	}
	fields := strings.Fields(strings.TrimSpace(string(res.Stdout)))
	if len(fields) == 0 {
		return nil, fmt.Errorf("gitx: rev-list returned no commit for %s", oid)
	}
	return fields[1:], nil
}

// ParseDiffTree parses `git diff-tree --name-status -r -z` output into
// protocol types. Tokens are NUL-separated: the status, then the path (or the
// old/new path pair for renames and copies). Status codes map onto the shared
// ChangeKind vocabulary used by the working-tree view.
func ParseDiffTree(raw []byte) ([]protocol.CommitFile, error) {
	files := make([]protocol.CommitFile, 0)
	tokens := bytes.Split(raw, []byte{0})
	for i := 0; i < len(tokens); i++ {
		status := tokens[i]
		if len(status) == 0 {
			continue
		}
		code := status[0]
		switch code {
		case 'R', 'C':
			if i+2 >= len(tokens) {
				return nil, fmt.Errorf("gitx: malformed rename record %q", status)
			}
			oldPath := string(tokens[i+1])
			newPath := string(tokens[i+2])
			if err := validatePath(oldPath); err != nil {
				return nil, err
			}
			if err := validatePath(newPath); err != nil {
				return nil, err
			}
			kind := protocol.KindRenamed
			if code == 'C' {
				kind = protocol.KindAdded
			}
			files = append(files, protocol.CommitFile{Path: newPath, OldPath: oldPath, Kind: kind})
			i += 2
		default:
			if i+1 >= len(tokens) {
				return nil, fmt.Errorf("gitx: malformed status record %q", status)
			}
			path := string(tokens[i+1])
			if err := validatePath(path); err != nil {
				return nil, err
			}
			files = append(files, protocol.CommitFile{Path: path, Kind: kindForCode(code)})
			i++
		}
	}
	return files, nil
}
