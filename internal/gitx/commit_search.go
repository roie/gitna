package gitx

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/roie/gitna/internal/protocol"
)

var commitSearchHash = regexp.MustCompile(`^[a-fA-F0-9]{1,64}$`)

func (r Repository) SearchCommits(ctx context.Context, runner Runner, query string, all bool, skip int) (protocol.GraphPage, error) {
	const pageSize = 100
	if len(query) > 1024 || skip < 0 || skip > 10000 {
		return protocol.GraphPage{}, fmt.Errorf("gitx: invalid commit search")
	}
	scope := "HEAD"
	if all {
		scope = "--all"
	} else {
		snapshot, err := r.Status(ctx, runner)
		if err != nil {
			return protocol.GraphPage{}, err
		}
		if snapshot.HeadOID == "" {
			return protocol.GraphPage{Commits: []protocol.GraphCommit{}}, nil
		}
		scope = snapshot.HeadOID
	}
	count := skip + pageSize + 1
	base := []string{"log", "--format=%H", "--max-count=" + strconv.Itoa(count), "--regexp-ignore-case", "--fixed-strings"}
	filters := []string{""}
	if query != "" {
		filters = []string{"--grep=" + query, "--author=" + query}
	}
	ids := []string{}
	seen := map[string]bool{}
	for _, filter := range filters {
		args := append([]string{}, base...)
		if filter != "" {
			args = append(args, filter)
		}
		args = append(args, scope, "--")
		res, err := runner.Run(ctx, r.Root, args...)
		if err != nil {
			return protocol.GraphPage{}, err
		}
		if res.ExitCode != 0 {
			return protocol.GraphPage{}, fmt.Errorf("gitx: commit search failed: %s", strings.TrimSpace(string(res.Stderr)))
		}
		for _, id := range strings.Fields(string(res.Stdout)) {
			if !seen[id] {
				ids = append(ids, id)
				seen[id] = true
			}
		}
	}
	if commitSearchHash.MatchString(query) {
		const batchSize = 10000
		prefix := strings.ToLower(query)
		matches := 0
		for offset := 0; matches < count; offset += batchSize {
			args := []string{"log", "--format=%H", "--max-count=" + strconv.Itoa(batchSize), "--skip=" + strconv.Itoa(offset), scope}
			if all {
				args = append(args, "--ignore-missing", "HEAD")
			}
			args = append(args, "--")
			res, err := runner.Run(ctx, r.Root, args...)
			if err != nil {
				return protocol.GraphPage{}, err
			}
			if res.ExitCode != 0 {
				return protocol.GraphPage{}, fmt.Errorf("gitx: commit search failed: %s", strings.TrimSpace(string(res.Stderr)))
			}
			batch := strings.Fields(string(res.Stdout))
			for _, id := range batch {
				if strings.HasPrefix(id, prefix) {
					matches++
					if !seen[id] {
						ids = append(ids, id)
						seen[id] = true
					}
					if matches == count {
						break
					}
				}
			}
			if len(batch) < batchSize {
				break
			}
		}
	}
	if len(ids) == 0 {
		return protocol.GraphPage{Commits: []protocol.GraphCommit{}}, nil
	}
	// --max-count enables walking, so --no-walk must come after it.
	args := []string{"log", "--decorate=full", "--pretty=format:" + logFormat, "--skip=" + strconv.Itoa(skip), "--max-count=" + strconv.Itoa(pageSize+1), "--no-walk=sorted"}
	args = append(args, ids...)
	args = append(args, "--")
	res, err := runner.Run(ctx, r.Root, args...)
	if err != nil {
		return protocol.GraphPage{}, err
	}
	if res.ExitCode != 0 {
		return protocol.GraphPage{}, fmt.Errorf("gitx: commit search failed: %s", strings.TrimSpace(string(res.Stderr)))
	}
	commits, err := ParseLog(res.Stdout)
	if err != nil {
		return protocol.GraphPage{}, err
	}
	more := len(commits) > pageSize
	if more {
		commits = commits[:pageSize]
	}
	if all {
		for i := range commits {
			result, err := runner.Run(ctx, r.Root, "for-each-ref", "--contains="+commits[i].OID, "--format=%(refname)", "refs/heads/", "refs/remotes/")
			if err != nil {
				return protocol.GraphPage{}, err
			}
			if result.ExitCode != 0 {
				return protocol.GraphPage{}, fmt.Errorf("gitx: commit branches failed: %s", strings.TrimSpace(string(result.Stderr)))
			}
			for _, ref := range strings.Fields(string(result.Stdout)) {
				if strings.HasPrefix(ref, "refs/remotes/") && strings.HasSuffix(ref, "/HEAD") {
					continue
				}
				commits[i].Branches = append(commits[i].Branches, refName(ref))
			}
		}
	}
	return protocol.GraphPage{Commits: commits, HasMore: more}, nil
}
