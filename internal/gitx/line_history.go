package gitx

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/roie/gitna/internal/protocol"
)

// LineHistory returns the commit responsible for exactly one line in a
// bounded regular text worktree file. Unborn repositories, untracked files,
// and working-tree lines Git cannot attribute are reported as uncommitted.
func (r Repository) LineHistory(ctx context.Context, runner Runner, path string, line int, budget ...int64) (protocol.LineHistory, error) {
	if !r.IsGit() {
		return protocol.LineHistory{}, ErrNotRepository
	}
	if line < 1 || int64(line) > worktreeContentLimit(budget) {
		return protocol.LineHistory{}, fmt.Errorf("%w: invalid line %d", protocol.ErrInvalidPath, line)
	}
	file, err := r.ReadWorktreeFile(ctx, path, budget...)
	if err != nil {
		return protocol.LineHistory{}, err
	}
	if line > worktreeLineCount(file.Content) {
		return protocol.LineHistory{}, fmt.Errorf("%w: line %d is outside %q", protocol.ErrInvalidPath, line, path)
	}
	uncommitted := protocol.LineHistory{Path: path, Line: line, Uncommitted: true}

	head, err := runner.Run(ctx, r.Root, "rev-parse", "--verify", "--quiet", "HEAD")
	if err != nil {
		return protocol.LineHistory{}, err
	}
	if head.ExitCode != 0 {
		return uncommitted, nil
	}
	tracked, err := runner.Run(ctx, r.Root, "ls-files", "--error-unmatch", "--", path)
	if err != nil {
		return protocol.LineHistory{}, err
	}
	if tracked.ExitCode != 0 {
		return uncommitted, nil
	}

	lineRange := strconv.Itoa(line) + "," + strconv.Itoa(line)
	result, err := runner.Run(ctx, r.Root, "blame", "--line-porcelain", "-L", lineRange, "--", path)
	if err != nil {
		return protocol.LineHistory{}, err
	}
	if result.ExitCode != 0 {
		return protocol.LineHistory{}, fmt.Errorf("gitx: line history failed: %s", strings.TrimSpace(string(result.Stderr)))
	}
	blame, err := parseLineHistory(path, line, result.Stdout)
	if err != nil {
		return protocol.LineHistory{}, err
	}
	return blame, nil
}

func worktreeLineCount(content string) int {
	if content == "" {
		return 0
	}
	count := strings.Count(content, "\n")
	if !strings.HasSuffix(content, "\n") {
		count++
	}
	return count
}

func parseLineHistory(path string, line int, output []byte) (protocol.LineHistory, error) {
	lines := strings.Split(strings.TrimRight(string(output), "\n"), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) == "" {
		return protocol.LineHistory{}, fmt.Errorf("gitx: empty line history output")
	}
	fields := strings.Fields(lines[0])
	if len(fields) < 3 {
		return protocol.LineHistory{}, fmt.Errorf("gitx: malformed line history header %q", lines[0])
	}
	oid := strings.TrimPrefix(fields[0], "^")
	result := protocol.LineHistory{Path: path, Line: line}
	if strings.Trim(oid, "0") == "" {
		result.Uncommitted = true
		return result, nil
	}
	if len(oid) != 40 && len(oid) != 64 {
		return protocol.LineHistory{}, fmt.Errorf("gitx: malformed line history oid")
	}
	result.OID = oid
	if len(oid) > 7 {
		result.ShortOID = oid[:7]
	} else {
		result.ShortOID = oid
	}
	for _, entry := range lines[1:] {
		key, value, found := strings.Cut(entry, " ")
		if !found {
			continue
		}
		switch key {
		case "author":
			result.Author = value
		case "author-time":
			seconds, err := strconv.ParseInt(value, 10, 64)
			if err != nil {
				return protocol.LineHistory{}, fmt.Errorf("gitx: malformed line history author time")
			}
			authoredAt := time.Unix(seconds, 0).UTC()
			result.AuthoredAt = &authoredAt
		case "summary":
			result.Summary = value
		case "filename":
			commitPath, err := parseLineHistoryPath(value)
			if err != nil {
				return protocol.LineHistory{}, err
			}
			result.CommitPath = commitPath
		}
	}
	if result.Author == "" || result.Summary == "" || result.AuthoredAt == nil {
		return protocol.LineHistory{}, fmt.Errorf("gitx: incomplete line history output")
	}
	return result, nil
}

func parseLineHistoryPath(value string) (string, error) {
	if !strings.HasPrefix(value, `"`) {
		return value, nil
	}
	path, err := strconv.Unquote(value)
	if err != nil {
		return "", fmt.Errorf("gitx: malformed line history filename")
	}
	return path, nil
}

// FileBlame attributes every line of a bounded regular text worktree file in
// one git blame pass, so callers can look lines up without further requests.
func (r Repository) FileBlame(ctx context.Context, runner Runner, path string, budget ...int64) (protocol.FileBlame, error) {
	if !r.IsGit() {
		return protocol.FileBlame{}, ErrNotRepository
	}
	file, err := r.ReadWorktreeFile(ctx, path, budget...)
	if err != nil {
		return protocol.FileBlame{}, err
	}
	blame := protocol.FileBlame{Path: path, ContentHash: file.Hash, Commits: map[string]protocol.BlameCommit{}, Ranges: []protocol.BlameRange{}}
	headOID, present, err := r.blameHead(ctx, runner, path)
	blame.HeadOID = headOID
	if err != nil {
		return protocol.FileBlame{}, err
	}
	if !present || file.Content == "" {
		return blame, nil
	}
	oid, err := r.indexEntryOID(ctx, runner, path)
	if err != nil {
		return protocol.FileBlame{}, err
	}
	if oid == "" {
		return blame, nil
	}
	result, err := runner.RunInput(ctx, r.Root, []byte(file.Content), "blame", "--incremental", "--contents", "-", blame.HeadOID, "--", path)
	if err != nil {
		return protocol.FileBlame{}, err
	}
	if result.ExitCode != 0 {
		return protocol.FileBlame{}, fmt.Errorf("gitx: file blame failed: %s", strings.TrimSpace(string(result.Stderr)))
	}
	if err := parseIncrementalBlame(result.Stdout, &blame); err != nil {
		return protocol.FileBlame{}, err
	}
	return blame, nil
}

func (r Repository) blameHead(ctx context.Context, runner Runner, path string) (string, bool, error) {
	expression := "HEAD:" + path
	result, err := runner.RunInput(ctx, r.Root, []byte("HEAD\x00"+expression+"\x00"), "cat-file", "--batch-check=%(objectname) %(objecttype)", "-z")
	if err != nil {
		return "", false, err
	}
	if result.ExitCode != 0 {
		return "", false, opError("resolve blame HEAD", result)
	}
	head, blob, ok := strings.Cut(string(result.Stdout), "\n")
	if !ok {
		return "", false, fmt.Errorf("gitx: missing blame HEAD metadata")
	}
	if head == "HEAD missing" {
		return "", false, nil
	}
	fields := strings.Fields(head)
	if len(fields) != 2 || fields[1] != "commit" {
		return "", false, fmt.Errorf("gitx: invalid blame HEAD metadata")
	}
	if blob == expression+" missing\n" {
		return fields[0], false, nil
	}
	object := strings.Fields(blob)
	if len(object) != 2 || object[1] != "blob" {
		return "", false, fmt.Errorf("gitx: invalid blame blob metadata")
	}
	return fields[0], true, nil
}

func parseIncrementalBlame(output []byte, blame *protocol.FileBlame) error {
	var current *protocol.BlameRange
	var commit protocol.BlameCommit
	for _, entry := range strings.Split(string(output), "\n") {
		if current == nil {
			if entry == "" {
				continue
			}
			fields := strings.Fields(entry)
			if len(fields) != 4 || (len(fields[0]) != 40 && len(fields[0]) != 64) {
				return fmt.Errorf("gitx: malformed blame header %q", entry)
			}
			start, err := strconv.Atoi(fields[2])
			if err != nil {
				return fmt.Errorf("gitx: malformed blame line %q", entry)
			}
			count, err := strconv.Atoi(fields[3])
			if err != nil {
				return fmt.Errorf("gitx: malformed blame count %q", entry)
			}
			current = &protocol.BlameRange{Start: start, Count: count, OID: fields[0]}
			commit = blame.Commits[current.OID]
			continue
		}
		key, value, _ := strings.Cut(entry, " ")
		switch key {
		case "author":
			commit.Author = value
		case "author-time":
			seconds, err := strconv.ParseInt(value, 10, 64)
			if err != nil {
				return fmt.Errorf("gitx: malformed blame author time")
			}
			authoredAt := time.Unix(seconds, 0).UTC()
			commit.AuthoredAt = &authoredAt
		case "summary":
			commit.Summary = value
		case "filename":
			commitPath, err := parseLineHistoryPath(value)
			if err != nil {
				return err
			}
			if strings.Trim(current.OID, "0") != "" {
				if commitPath != blame.Path {
					current.CommitPath = commitPath
				}
				blame.Commits[current.OID] = commit
				blame.Ranges = append(blame.Ranges, *current)
			}
			current = nil
		}
	}
	if current != nil {
		return fmt.Errorf("gitx: incomplete blame output")
	}
	slices.SortFunc(blame.Ranges, func(a, b protocol.BlameRange) int { return a.Start - b.Start })
	return nil
}
