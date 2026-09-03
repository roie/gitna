package gitx

import (
	"bytes"
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/roie/gitna/internal/protocol"
)

// CommitDetails returns the changed paths and first-parent line statistics used
// by the Graph's lazy commit disclosure and hover card.
func (r Repository) CommitDetails(ctx context.Context, runner Runner, oid string) (protocol.CommitFiles, error) {
	files, err := r.ChangedFiles(ctx, runner, oid)
	if err != nil {
		return protocol.CommitFiles{}, err
	}
	stats, err := r.commitStats(ctx, runner, oid)
	if err != nil {
		return protocol.CommitFiles{}, err
	}
	return protocol.CommitFiles{Files: files, Stats: stats}, nil
}

func (r Repository) commitStats(ctx context.Context, runner Runner, oid string) (protocol.CommitStats, error) {
	if err := r.validateCommitRevision(ctx, runner, oid); err != nil {
		return protocol.CommitStats{}, err
	}
	parents, err := r.commitParents(ctx, runner, oid)
	if err != nil {
		return protocol.CommitStats{}, err
	}
	args := []string{"diff", "--numstat", "-z", "--find-renames"}
	if len(parents) == 0 {
		args = []string{"diff-tree", "--root", "--no-commit-id", "--numstat", "-r", "-z", "--find-renames", oid, "--"}
	} else {
		args = append(args, parents[0], oid, "--")
	}
	res, err := runner.Run(ctx, r.Root, args...)
	if err != nil {
		return protocol.CommitStats{}, err
	}
	if res.ExitCode != 0 {
		return protocol.CommitStats{}, fmt.Errorf("gitx: commit stats failed for %s: %s", oid, strings.TrimSpace(string(res.Stderr)))
	}
	return ParseNumstat(res.Stdout)
}

// ParseNumstat parses `git diff --numstat -z` output, including the extra old
// and new path fields emitted for rename records.
func ParseNumstat(raw []byte) (protocol.CommitStats, error) {
	var stats protocol.CommitStats
	for len(raw) > 0 {
		end := bytes.IndexByte(raw, 0)
		if end < 0 {
			return protocol.CommitStats{}, fmt.Errorf("gitx: malformed numstat record")
		}
		record := raw[:end]
		raw = raw[end+1:]
		parts := bytes.SplitN(record, []byte{'\t'}, 3)
		if len(parts) != 3 {
			return protocol.CommitStats{}, fmt.Errorf("gitx: malformed numstat fields")
		}
		stats.Files++
		if string(parts[0]) == "-" || string(parts[1]) == "-" {
			stats.BinaryFiles++
		} else {
			additions, err := strconv.Atoi(string(parts[0]))
			if err != nil {
				return protocol.CommitStats{}, fmt.Errorf("gitx: invalid addition count: %w", err)
			}
			deletions, err := strconv.Atoi(string(parts[1]))
			if err != nil {
				return protocol.CommitStats{}, fmt.Errorf("gitx: invalid deletion count: %w", err)
			}
			stats.Additions += additions
			stats.Deletions += deletions
		}

		if len(parts[2]) == 0 {
			for range 2 {
				end = bytes.IndexByte(raw, 0)
				if end < 0 {
					return protocol.CommitStats{}, fmt.Errorf("gitx: malformed rename numstat record")
				}
				raw = raw[end+1:]
			}
		}
	}
	return stats, nil
}
