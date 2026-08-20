package gitx

import (
	"bytes"
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/roie/gitna/internal/protocol"
)

// ListConflicts reads unmerged entries from the index. Each path yields one
// ConflictEntry with base (stage 1), ours (stage 2), and theirs (stage 3) OIDs
// when present. Missing stages mean that side has no blob (e.g. an added file).
func (r Repository) ListConflicts(ctx context.Context, runner Runner) ([]protocol.ConflictEntry, error) {
	res, err := runner.Run(ctx, r.Root, "ls-files", "-u", "-z")
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, fmt.Errorf("gitx: ls-files -u failed: %s", strings.TrimSpace(string(res.Stderr)))
	}
	return parseLsFilesUnmerged(res.Stdout)
}

func parseLsFilesUnmerged(raw []byte) ([]protocol.ConflictEntry, error) {
	if len(bytes.TrimRight(raw, "\x00")) == 0 {
		return nil, nil
	}
	type entry struct {
		base, ours, theirs string
	}
	byPath := make(map[string]*entry)
	var paths []string

	tokens := bytes.Split(raw, []byte{0})
	for _, tok := range tokens {
		if len(tok) == 0 {
			continue
		}
		// Format: <mode> <oid> <stage>\t<path>
		// Split first two spaces for mode/oid, then tab for stage/path.
		s1 := strings.IndexByte(string(tok), ' ')
		if s1 < 0 {
			return nil, fmt.Errorf("gitx: malformed ls-files -u record %q", tok)
		}
		s2 := strings.IndexByte(string(tok[s1+1:]), ' ')
		if s2 < 0 {
			return nil, fmt.Errorf("gitx: malformed ls-files -u record %q", tok)
		}
		s2 += s1 + 1
		tab := strings.IndexByte(string(tok[s2+1:]), '\t')
		if tab < 0 {
			return nil, fmt.Errorf("gitx: malformed ls-files -u record %q", tok)
		}
		tab += s2 + 1
		stageStr := string(tok[s2+1 : tab])
		path := string(tok[tab+1:])
		stage, err := strconv.Atoi(stageStr)
		if err != nil || stage < 1 || stage > 3 {
			return nil, fmt.Errorf("gitx: unexpected stage %q", stageStr)
		}
		e, ok := byPath[path]
		if !ok {
			e = &entry{}
			byPath[path] = e
			paths = append(paths, path)
		}
		oid := string(tok[s1+1 : s2])
		switch stage {
		case 1:
			e.base = oid
		case 2:
			e.ours = oid
		case 3:
			e.theirs = oid
		}
	}

	out := make([]protocol.ConflictEntry, 0, len(paths))
	for _, p := range paths {
		e := byPath[p]
		out = append(out, protocol.ConflictEntry{
			Path:      p,
			BaseOID:   e.base,
			OursOID:   e.ours,
			TheirsOID: e.theirs,
		})
	}
	return out, nil
}

// ConflictBlob returns the content of one side of a conflicted file. Stage
// numbering follows the index convention: 1 = base, 2 = ours, 3 = theirs.
func (r Repository) ConflictBlob(ctx context.Context, runner Runner, path string, stage int) ([]byte, error) {
	if stage < 1 || stage > 3 {
		return nil, fmt.Errorf("gitx: invalid conflict stage %d", stage)
	}
	if err := validatePath(path); err != nil {
		return nil, err
	}
	stageRef := fmt.Sprintf(":%d:%s", stage, path)
	res, err := runner.Run(ctx, r.Root, "show", stageRef)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, fmt.Errorf("gitx: show %s failed: %s", stageRef, strings.TrimSpace(string(res.Stderr)))
	}
	return res.Stdout, nil
}

// ResolveConflictSide checks out one side of a conflicted file into the
// worktree and stages it, marking the conflict as resolved. The side is
// "ours" (2) or "theirs" (3).
func (r Repository) ResolveConflictSide(ctx context.Context, runner Runner, path string, theirs bool) error {
	if err := validatePath(path); err != nil {
		return err
	}
	side := "ours"
	if theirs {
		side = "theirs"
	}
	// checkout --<side> writes the resolved content to the worktree.
	res, err := runner.Run(ctx, r.Root, "checkout", "--"+side, "--", path)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return opError("resolve conflict "+side, res)
	}
	// Stage the resolved file.
	res, err = runner.Run(ctx, r.Root, "add", "--", path)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return opError("stage resolved file", res)
	}
	return nil
}
