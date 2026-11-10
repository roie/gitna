package gitx

import (
	"bytes"
	"context"
	"fmt"
	"strings"
)

// IgnoredPaths asks Git to classify worktree-relative paths using Git's own
// layered ignore rules. Git collapses wholly ignored directories to "dir/", so
// a path is ignored when it or any ancestor directory is listed. NUL-delimited
// output handles every valid path except NUL itself.
func (r Repository) IgnoredPaths(ctx context.Context, runner Runner, paths []string) (map[string]struct{}, error) {
	ignored := make(map[string]struct{})
	if !r.IsGit() || len(paths) == 0 {
		return ignored, nil
	}

	result, err := runner.Run(ctx, r.Root, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z")
	if err != nil {
		return nil, err
	}
	if result.ExitCode != 0 {
		return nil, fmt.Errorf("gitx: list ignored paths: %s", strings.TrimSpace(string(result.Stderr)))
	}
	listed := make(map[string]struct{})
	for path := range bytes.SplitSeq(result.Stdout, []byte{0}) {
		if len(path) > 0 {
			listed[string(path)] = struct{}{}
		}
	}
	for _, path := range paths {
		if path == "" || strings.IndexByte(path, 0) >= 0 {
			continue
		}
		for index := range len(path) {
			if (index == len(path)-1 || path[index] == '/') && hasKey(listed, path[:index+1]) {
				ignored[path] = struct{}{}
				break
			}
		}
	}
	return ignored, nil
}

func hasKey(set map[string]struct{}, key string) bool {
	_, ok := set[key]
	return ok
}
