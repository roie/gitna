package gitx

import (
	"context"
	"fmt"
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
