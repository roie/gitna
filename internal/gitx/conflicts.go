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

func (r Repository) hasConflicts(ctx context.Context, runner Runner) (bool, error) {
	conflicts, err := r.ListConflicts(ctx, runner)
	return len(conflicts) > 0, err
}

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
		mode               string
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
		mode := string(tok[:s1])
		oid := string(tok[s1+1 : s2])
		switch stage {
		case 1:
			e.base = oid
		case 2:
			e.ours = oid
			e.mode = mode
		case 3:
			e.theirs = oid
			if e.mode == "" {
				e.mode = mode
			}
		}
	}

	out := make([]protocol.ConflictEntry, 0, len(paths))
	for _, p := range paths {
		e := byPath[p]
		out = append(out, protocol.ConflictEntry{
			Path:           p,
			BaseOID:        e.base,
			OursOID:        e.ours,
			TheirsOID:      e.theirs,
			Mode:           e.mode,
			CanResolveBoth: e.ours != "" && e.theirs != "" && (e.mode == "100644" || e.mode == "100755"),
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

// ResolveConflictBoth uses Git's union merge driver to retain both sides of a
// regular text conflict, writes the merged blob into the index, and checks it
// out to the worktree. Binary files and non-regular index modes deliberately
// fall back to the external-edit-and-stage workflow.
func (r Repository) ResolveConflictBoth(ctx context.Context, runner Runner, path string) error {
	if err := validatePath(path); err != nil {
		return err
	}
	entries, err := r.ListConflicts(ctx, runner)
	if err != nil {
		return err
	}
	var conflict *protocol.ConflictEntry
	for i := range entries {
		if entries[i].Path == path {
			conflict = &entries[i]
			break
		}
	}
	if conflict == nil || !conflict.CanResolveBoth {
		return fmt.Errorf("gitx: conflict cannot safely accept both sides")
	}
	ours, err := r.ConflictBlob(ctx, runner, path, 2)
	if err != nil {
		return err
	}
	theirs, err := r.ConflictBlob(ctx, runner, path, 3)
	if err != nil {
		return err
	}
	var base []byte
	if conflict.BaseOID != "" {
		base, err = r.ConflictBlob(ctx, runner, path, 1)
		if err != nil {
			return err
		}
	}
	if bytes.IndexByte(ours, 0) >= 0 || bytes.IndexByte(theirs, 0) >= 0 || bytes.IndexByte(base, 0) >= 0 {
		return fmt.Errorf("gitx: binary conflict requires external resolution")
	}

	tempDir, err := os.MkdirTemp("", "gitna-conflict-")
	if err != nil {
		return fmt.Errorf("gitx: create conflict workspace: %w", err)
	}
	defer os.RemoveAll(tempDir)
	oursPath := filepath.Join(tempDir, "ours")
	basePath := filepath.Join(tempDir, "base")
	theirsPath := filepath.Join(tempDir, "theirs")
	for name, content := range map[string][]byte{oursPath: ours, basePath: base, theirsPath: theirs} {
		if err := os.WriteFile(name, content, 0o600); err != nil {
			return fmt.Errorf("gitx: write conflict workspace: %w", err)
		}
	}
	merged, err := runner.Run(ctx, r.Root, "merge-file", "--union", "-p", oursPath, basePath, theirsPath)
	if err != nil {
		return err
	}
	if merged.ExitCode != 0 {
		return opError("merge-file --union", merged)
	}
	hashed, err := runner.RunInput(ctx, r.Root, merged.Stdout, "hash-object", "-w", "--stdin")
	if err != nil {
		return err
	}
	if hashed.ExitCode != 0 {
		return opError("hash merged conflict", hashed)
	}
	oid := strings.TrimSpace(string(hashed.Stdout))
	cacheInfo := strings.Join([]string{conflict.Mode, oid, path}, ",")
	updated, err := runner.Run(ctx, r.Root, "update-index", "--add", "--cacheinfo", cacheInfo)
	if err != nil {
		return err
	}
	if updated.ExitCode != 0 {
		return opError("index merged conflict", updated)
	}
	checkedOut, err := runner.Run(ctx, r.Root, "checkout-index", "-f", "--", path)
	if err != nil {
		return err
	}
	if checkedOut.ExitCode != 0 {
		return opError("checkout merged conflict", checkedOut)
	}
	return nil
}
