package gitx

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

func TestCommitSearch(t *testing.T) {
	root := buildHistoryFixture(t)
	repo, runner := historyDiscover(t, root)
	ctx := context.Background()
	for _, tc := range []struct {
		query string
		count int
	}{{"FEATURE", 2}, {"root commit", 1}, {"[", 0}, {"--all", 0}, {"", 5}} {
		t.Run(tc.query, func(t *testing.T) {
			page, err := repo.SearchCommits(ctx, runner, tc.query, false, 0)
			if err != nil {
				t.Fatal(err)
			}
			if len(page.Commits) != tc.count {
				t.Fatalf("%q: got %d want %d", tc.query, len(page.Commits), tc.count)
			}
		})
	}
	recent, err := repo.SearchCommits(ctx, runner, "", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	author, err := repo.SearchCommits(ctx, runner, recent.Commits[0].AuthorName, false, 0)
	if err != nil || len(author.Commits) != 5 {
		t.Fatalf("author: %#v %v", author, err)
	}
	hash := recent.Commits[0].OID
	page, err := repo.SearchCommits(ctx, runner, strings.ToUpper(hash[:8]), false, 0)
	if err != nil || len(page.Commits) != 1 || page.Commits[0].OID != hash {
		t.Fatalf("hash: %#v %v", page, err)
	}
	for _, prefix := range []string{hash[:1], hash[:2], hash[:3], strings.ToUpper(hash[:3]), hash} {
		short, err := repo.SearchCommits(ctx, runner, prefix, false, 0)
		if err != nil {
			t.Fatal(err)
		}
		if !slices.ContainsFunc(short.Commits, func(commit protocol.GraphCommit) bool { return commit.OID == hash }) {
			t.Fatalf("hash prefix %q did not match %s: %+v", prefix, hash, short.Commits)
		}
	}
	runGit(t, root, "checkout", "-q", "-b", "other")
	runGit(t, root, "commit", "--allow-empty", "-q", "-m", "only on other")
	other := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD"))
	runGit(t, root, "checkout", "-q", "main")
	for _, query := range []string{"only on other", other[:8]} {
		current, err := repo.SearchCommits(ctx, runner, query, false, 0)
		if err != nil || len(current.Commits) != 0 {
			t.Fatalf("current: %#v %v", current, err)
		}
		all, err := repo.SearchCommits(ctx, runner, query, true, 0)
		if err != nil || len(all.Commits) != 1 {
			t.Fatalf("all: %#v %v", all, err)
		}
		if !slices.Equal(all.Commits[0].Branches, []string{"other"}) {
			t.Fatalf("branch membership: %v", all.Commits[0].Branches)
		}
	}
	for _, all := range []bool{false, true} {
		page, err := repo.SearchCommits(ctx, runner, other[:3], all, 0)
		if err != nil {
			t.Fatal(err)
		}
		found := slices.ContainsFunc(page.Commits, func(commit protocol.GraphCommit) bool { return commit.OID == other })
		if found != all {
			t.Fatalf("short hash scope all=%t: %+v", all, page.Commits)
		}
	}
	runGit(t, root, "update-ref", "refs/remotes/origin/main", hash)
	runGit(t, root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
	shared, err := repo.SearchCommits(ctx, runner, "root commit", true, 0)
	if err != nil || len(shared.Commits) != 1 {
		t.Fatalf("shared: %+v %v", shared, err)
	}
	for _, branch := range []string{"main", "other", "origin/main"} {
		if !slices.Contains(shared.Commits[0].Branches, branch) {
			t.Fatalf("shared commit missing %s: %v", branch, shared.Commits[0].Branches)
		}
	}
	if slices.Contains(shared.Commits[0].Branches, "origin/HEAD") {
		t.Fatalf("symbolic HEAD listed as branch: %v", shared.Commits[0].Branches)
	}
}

func TestCommitSearchAmbiguousPrefix(t *testing.T) {
	root := initTestRepo(t)
	tree := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD^{tree}"))
	byPrefix := map[string][]string{}
	for i := range 17 {
		id := strings.TrimSpace(runGit(t, root, "commit-tree", tree, "-p", "HEAD", "-m", fmt.Sprintf("zz %d", i)))
		runGit(t, root, "update-ref", "HEAD", id)
		byPrefix[id[:1]] = append(byPrefix[id[:1]], id)
	}
	repo, runner := historyDiscover(t, root)
	for prefix, ids := range byPrefix {
		if len(ids) < 2 {
			continue
		}
		page, err := repo.SearchCommits(t.Context(), runner, prefix, false, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, id := range ids {
			if !slices.ContainsFunc(page.Commits, func(commit protocol.GraphCommit) bool { return commit.OID == id }) {
				t.Fatalf("ambiguous prefix %q did not match %s: %+v", prefix, id, page.Commits)
			}
		}
		return
	}
	t.Fatal("expected a shared prefix among 17 commit hashes")
}

func TestCommitSearchDetachedAndUnborn(t *testing.T) {
	root := t.TempDir()
	runGit(t, root, "init", "-q")
	runGit(t, root, "config", "user.name", "Test")
	runGit(t, root, "config", "user.email", "test@example.com")
	repo, runner := historyDiscover(t, root)
	ctx := context.Background()
	page, err := repo.SearchCommits(ctx, runner, "", false, 0)
	if err != nil || len(page.Commits) != 0 {
		t.Fatalf("unborn: %+v %v", page, err)
	}
	runGit(t, root, "commit", "--allow-empty", "-q", "-m", "root")
	runGit(t, root, "checkout", "--detach", "-q")
	runGit(t, root, "commit", "--allow-empty", "-q", "-m", "detached subject", "-m", "unique body phrase")
	hash := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD"))
	for _, query := range []string{hash[:3], hash[:8], "unique body phrase"} {
		for _, all := range []bool{false, true} {
			page, err := repo.SearchCommits(ctx, runner, query, all, 0)
			if err != nil || !slices.ContainsFunc(page.Commits, func(commit protocol.GraphCommit) bool { return commit.OID == hash }) {
				t.Fatalf("detached %q all=%t: %+v %v", query, all, page, err)
			}
		}
	}
}

func TestCommitSearchPagination(t *testing.T) {
	root := initTestRepo(t)
	for i := range 110 {
		runGit(t, root, "commit", "-q", "--allow-empty", "-m", fmt.Sprintf("needle %03d", i))
	}
	repo, runner := historyDiscover(t, root)
	first, err := repo.SearchCommits(context.Background(), runner, "needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	second, err := repo.SearchCommits(context.Background(), runner, "needle", false, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Commits) != 100 || !first.HasMore || len(second.Commits) != 10 || second.HasMore {
		t.Fatalf("pages: %d/%t %d/%t", len(first.Commits), first.HasMore, len(second.Commits), second.HasMore)
	}
	seen := map[string]bool{}
	for _, commit := range append(first.Commits, second.Commits...) {
		if seen[commit.OID] {
			t.Fatalf("duplicate %s", commit.OID)
		}
		seen[commit.OID] = true
	}
}
