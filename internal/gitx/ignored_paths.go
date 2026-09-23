package gitx

import (
	"bytes"
	"context"
	"fmt"
	"strings"
)

// IgnoredPaths asks Git to classify worktree-relative paths using Git's own
// layered ignore rules. Git lists tracked and non-ignored untracked paths in
// one pass; requested paths absent from that manifest are ignored. NUL-
// delimited output handles every valid path except NUL itself.
func (r Repository) IgnoredPaths(ctx context.Context, runner Runner, paths []string) (map[string]struct{}, error) {
	ignored := make(map[string]struct{})
	if !r.IsGit() || len(paths) == 0 {
		return ignored, nil
	}

	requested := make(map[string]struct{}, len(paths))
	for _, path := range paths {
		if path != "" && strings.IndexByte(path, 0) < 0 {
			requested[path] = struct{}{}
		}
	}
	if len(requested) == 0 {
		return ignored, nil
	}

	result, err := runner.Run(ctx, r.Root, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
	if err != nil {
		return nil, err
	}
	if result.ExitCode != 0 {
		return nil, fmt.Errorf("gitx: list non-ignored paths: %s", strings.TrimSpace(string(result.Stderr)))
	}
	for path := range bytes.SplitSeq(result.Stdout, []byte{0}) {
		if _, ok := requested[string(path)]; ok {
			delete(requested, string(path))
		}
	}
	for path := range requested {
		ignored[path] = struct{}{}
	}
	return ignored, nil
}
