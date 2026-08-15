package gitx

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/roie/gitna/internal/protocol"
)

// StatusResult holds the parsed parts of a porcelain v2 status run.
type StatusResult struct {
	HeadOID    string
	HeadBranch string
	Upstream   string
	Ahead      int
	Behind     int
	Staged     []protocol.FileChange
	Unstaged   []protocol.FileChange
}

// Status reads the repository's source-control state through porcelain v2
// with NUL termination and normalizes it into protocol types.
func (r Repository) Status(ctx context.Context, runner Runner) (protocol.RepoSnapshot, error) {
	res, err := runner.Run(ctx, r.Root,
		"status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--find-renames",
	)
	if err != nil {
		return protocol.RepoSnapshot{}, err
	}
	if res.ExitCode != 0 {
		return protocol.RepoSnapshot{}, fmt.Errorf("gitx: status failed: %s", strings.TrimSpace(string(res.Stderr)))
	}

	sr, err := ParseStatus(res.Stdout)
	if err != nil {
		return protocol.RepoSnapshot{}, err
	}

	return protocol.RepoSnapshot{
		Root:       r.Root,
		HeadOID:    sr.HeadOID,
		HeadBranch: sr.HeadBranch,
		Upstream:   sr.Upstream,
		Ahead:      sr.Ahead,
		Behind:     sr.Behind,
		Operation:  DetectOperation(r),
		Staged:     sr.Staged,
		Unstaged:   sr.Unstaged,
	}, nil
}

// ParseStatus parses `git status --porcelain=v2 -z --branch
// --untracked-files=all` output. Records are NUL-terminated; rename records
// carry path and original path as two NUL-separated fields.
func ParseStatus(raw []byte) (StatusResult, error) {
	var sr StatusResult
	tokens := bytes.Split(raw, []byte{0})

	for i := 0; i < len(tokens); i++ {
		tok := tokens[i]
		if len(tok) == 0 {
			continue
		}
		switch tok[0] {
		case '#':
			parseHeader(&sr, tok)
			continue
		case '1':
			f, err := parseRegularRecord(tok)
			if err != nil {
				return sr, err
			}
			appendChange(&sr, f...)
		case '2':
			var oldPath string
			if i+1 < len(tokens) {
				oldPath = string(tokens[i+1])
				i++
			}
			f, err := parseRenameRecord(tok, oldPath)
			if err != nil {
				return sr, err
			}
			appendChange(&sr, f...)
		case 'u':
			// Unmerged records: u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
			fields := strings.Split(string(tok), " ")
			if len(fields) < 10 {
				return sr, fmt.Errorf("gitx: malformed unmerged record %q", tok)
			}
			xy := fields[1]
			path := strings.Join(fields[10:], " ")
			appendChange(&sr, changeFromXY(xy, path, "")...)
		case '?':
			path := strings.TrimPrefix(string(tok), "? ")
			appendChange(&sr, protocol.FileChange{
				Path:   path,
				Kind:   protocol.KindUntracked,
				Scope:  protocol.ScopeUnstaged,
				Staged: false,
			})
		case '!':
			// Ignored files are only reported when explicitly requested;
			// record them so callers that opt in can see them.
			path := strings.TrimPrefix(string(tok), "! ")
			appendChange(&sr, protocol.FileChange{
				Path:   path,
				Kind:   protocol.KindIgnored,
				Scope:  protocol.ScopeUnstaged,
				Staged: false,
			})
		}
	}
	return sr, nil
}

func appendChange(sr *StatusResult, changes ...protocol.FileChange) {
	for _, c := range changes {
		if c.Scope == protocol.ScopeStaged {
			sr.Staged = append(sr.Staged, c)
		} else {
			sr.Unstaged = append(sr.Unstaged, c)
		}
	}
}// parseRegularRecord handles type "1" records:
// 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
func parseRegularRecord(tok []byte) ([]protocol.FileChange, error) {
	fields := strings.Split(string(tok), " ")
	if len(fields) < 8 {
		return nil, fmt.Errorf("gitx: malformed status record %q", tok)
	}
	xy := fields[1]
	path := strings.Join(fields[8:], " ")
	return changeFromXY(xy, path, ""), nil
}

// parseRenameRecord handles type "2" records:
// 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
func parseRenameRecord(tok []byte, oldPath string) ([]protocol.FileChange, error) {
	fields := strings.Split(string(tok), " ")
	if len(fields) < 9 {
		return nil, fmt.Errorf("gitx: malformed rename record %q", tok)
	}
	xy := fields[1]
	path := strings.Join(fields[9:], " ")
	return changeFromXY(xy, path, oldPath), nil
}

// changeFromXY converts an index/worktree XY code pair into normalized change
// entries. A file with both index and worktree modifications yields one entry
// per scope.
func changeFromXY(xy, path, oldPath string) []protocol.FileChange {
	x, y := xy[0], xy[1]

	if x == 'U' || y == 'U' || (isAorD(x) && isAorD(y)) {
		return []protocol.FileChange{{
			Path:       path,
			Kind:       protocol.KindConflicted,
			Scope:      protocol.ScopeUnstaged,
			Conflicted: true,
		}}
	}

	var changes []protocol.FileChange
	if x != '.' {
		changes = append(changes, protocol.FileChange{
			Path:    path,
			OldPath: oldPath,
			Kind:    kindForCode(x),
			Scope:   protocol.ScopeStaged,
			Staged:  true,
		})
	}
	if y != '.' {
		changes = append(changes, protocol.FileChange{
			Path:   path,
			Kind:   kindForCode(y),
			Scope:  protocol.ScopeUnstaged,
			Staged: false,
		})
	}
	return changes
}

func isAorD(c byte) bool { return c == 'A' || c == 'D' }

func kindForCode(code byte) protocol.ChangeKind {
	switch code {
	case 'M', 'T':
		return protocol.KindModified
	case 'A':
		return protocol.KindAdded
	case 'D':
		return protocol.KindDeleted
	case 'R':
		return protocol.KindRenamed
	case 'C':
		return protocol.KindAdded
	case 'U':
		return protocol.KindConflicted
	default:
		return protocol.KindModified
	}
}

func parseHeader(sr *StatusResult, tok []byte) {
	fields := strings.Fields(string(tok))
	if len(fields) < 2 {
		return
	}
	switch fields[1] {
	case "branch.oid":
		if len(fields) > 2 && fields[2] != "(initial)" {
			sr.HeadOID = fields[2]
		}
	case "branch.head":
		if len(fields) > 2 && fields[2] != "(detached)" {
			sr.HeadBranch = fields[2]
		}
	case "branch.upstream":
		if len(fields) > 2 {
			sr.Upstream = fields[2]
		}
	case "branch.ab":
		if len(fields) > 3 {
			sr.Ahead = parseSigned(fields[2])
			sr.Behind = parseSigned(fields[3])
		}
	}
}

func parseSigned(s string) int {
	n, err := strconv.Atoi(strings.TrimLeft(s, "+-"))
	if err != nil {
		return 0
	}
	return n
}

// DetectOperation reports an in-progress merge, rebase, cherry-pick, or revert
// based on Git metadata in the repository's git dir.
func DetectOperation(repo Repository) string {
	gitDir := repo.GitDir
	markers := []struct {
		rel string
		op  string
	}{
		{"MERGE_HEAD", protocol.OperationMerge},
		{"CHERRY_PICK_HEAD", protocol.OperationCherryPick},
		{"REVERT_HEAD", protocol.OperationRevert},
	}
	for _, m := range markers {
		if _, err := os.Stat(filepath.Join(gitDir, m.rel)); err == nil {
			return m.op
		}
	}
	for _, d := range []string{"rebase-merge", "rebase-apply"} {
		if _, err := os.Stat(filepath.Join(gitDir, d)); err == nil {
			return protocol.OperationRebase
		}
	}
	return protocol.OperationNone
}
