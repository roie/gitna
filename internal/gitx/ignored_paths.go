package gitx

import (
	"bytes"
	"context"
	"fmt"
	"strings"
)

// IgnoredPaths asks Git to classify worktree-relative paths using Git's own
// layered ignore rules. Input and output are NUL-delimited so every valid path
// except NUL itself is handled without escaping.
func (r Repository) IgnoredPaths(ctx context.Context, runner Runner, paths []string) (map[string]struct{}, error) {
	ignored := make(map[string]struct{})
	if !r.IsGit() || len(paths) == 0 {
		return ignored, nil
	}

	input := make([]byte, 0)
	for _, path := range paths {
		if path == "" || strings.IndexByte(path, 0) >= 0 {
			continue
		}
		input = append(input, path...)
		input = append(input, 0)
	}
	if len(input) == 0 {
		return ignored, nil
	}

	result, err := runner.RunInput(ctx, r.Root, input, "check-ignore", "--stdin", "-z")
	if err != nil {
		return nil, err
	}
	if result.ExitCode != 0 && result.ExitCode != 1 {
		return nil, fmt.Errorf("gitx: check ignored paths: %s", strings.TrimSpace(string(result.Stderr)))
	}
	for path := range bytes.SplitSeq(result.Stdout, []byte{0}) {
		if len(path) > 0 {
			ignored[string(path)] = struct{}{}
		}
	}
	return ignored, nil
}
