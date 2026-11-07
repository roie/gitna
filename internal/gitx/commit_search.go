package gitx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/roie/gitna/internal/protocol"
)

var commitSearchHash = regexp.MustCompile(`^[a-fA-F0-9]{1,64}$`)

var errCommitSearchFull = errors.New("gitx: commit search page full")

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
		prefix := []byte(strings.ToLower(query))
		matches := 0
		visit := func(id []byte) error {
			if !bytes.HasPrefix(id, prefix) {
				return nil
			}
			matches++
			if key := string(id); !seen[key] {
				ids = append(ids, key)
				seen[key] = true
			}
			if matches == count {
				return errCommitSearchFull
			}
			return nil
		}
		// A single history pass; paging with --skip re-walks history and grows quadratically.
		args := []string{"log", "-z", "--format=%H", scope}
		if all {
			args = append(args, "--ignore-missing", "HEAD")
		}
		args = append(args, "--")
		var res Result
		var err error
		if streamer, ok := runner.(nulRecordRunner); ok {
			res, err = streamer.RunNUL(ctx, r.Root, visit, args...)
		} else if res, err = runner.Run(ctx, r.Root, args...); err == nil && res.ExitCode == 0 {
			for id := range bytes.SplitSeq(res.Stdout, []byte{0}) {
				if err = visit(bytes.TrimSpace(id)); err != nil {
					break
				}
			}
		}
		if errors.Is(err, errCommitSearchFull) {
			err, res = nil, Result{}
		}
		if err != nil {
			return protocol.GraphPage{}, err
		}
		if res.ExitCode != 0 {
			return protocol.GraphPage{}, fmt.Errorf("gitx: commit search failed: %s", strings.TrimSpace(string(res.Stderr)))
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
