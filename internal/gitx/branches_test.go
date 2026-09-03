package gitx

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

// initRemoteRepo returns a worktree with a bare origin configured and a
// tracked main branch.
func initRemoteRepo(t *testing.T) (root, bare string) {
	t.Helper()
	root = initTestRepo(t)
	bare = filepath.Join(t.TempDir(), "origin.git")
	runGit(t, root, "init", "-q", "--bare", bare)
	// A fresh bare repo's HEAD points at an unborn branch; point it at main so
	// clones check out the branch we actually push.
	runGit(t, bare, "symbolic-ref", "HEAD", "refs/heads/main")
	runGit(t, root, "remote", "add", "origin", bare)
	return root, bare
}

func TestListBranchesLocalAndRemote(t *testing.T) {
	root, _ := initRemoteRepo(t)
	runGit(t, root, "push", "-u", "origin", "main")
	runGit(t, root, "switch", "-c", "feature")
	writeFile(t, filepath.Join(root, "f.txt"), "f\n")
	runGit(t, root, "add", "f.txt")
	runGit(t, root, "commit", "-qm", "feature work")
	runGit(t, root, "switch", "main")

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	branches, err := repo.ListBranches(context.Background(), &ExecRunner{})
	if err != nil {
		t.Fatalf("ListBranches: %v", err)
	}
	if len(branches) != 3 {
		t.Fatalf("ListBranches returned %d branches, want 3: %+v", len(branches), branches)
	}
	if got := branches[0]; got.Name != "feature" || got.Remote || got.Current || got.Upstream != "" {
		t.Fatalf("branches[0] = %+v, want local feature without upstream", got)
	}
	if got := branches[1]; got.Name != "main" || got.Remote || !got.Current || got.Upstream != "origin/main" {
		t.Fatalf("branches[1] = %+v, want current main tracking origin/main", got)
	}
	if got := branches[2]; got.Name != "origin/main" || !got.Remote || got.Upstream != "" {
		t.Fatalf("branches[2] = %+v, want remote origin/main", got)
	}
	for _, b := range branches {
		if b.OID == "" {
			t.Fatalf("branch %q has empty oid", b.Name)
		}
	}
}

func TestListRemotesIncludesConfiguredUnfetchedRemote(t *testing.T) {
	root := initTestRepo(t)
	runGit(t, root, "remote", "add", "upstream", filepath.Join(t.TempDir(), "remote.git"))
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}

	remotes, err := repo.ListRemotes(context.Background(), &ExecRunner{})
	if err != nil {
		t.Fatal(err)
	}
	if len(remotes) != 1 || remotes[0] != "upstream" {
		t.Fatalf("remotes = %v, want [upstream]", remotes)
	}
}

func TestListBranchesOmitsRemoteHeadSymref(t *testing.T) {
	root, _ := initRemoteRepo(t)
	runGit(t, root, "push", "-u", "origin", "main")
	runGit(t, root, "remote", "set-head", "origin", "main")
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}

	branches, err := repo.ListBranches(context.Background(), &ExecRunner{})
	if err != nil {
		t.Fatal(err)
	}
	for _, branch := range branches {
		if branch.Name == "origin/HEAD" {
			t.Fatalf("symbolic remote HEAD included: %+v", branches)
		}
	}
}

func TestListBranchesAheadBehind(t *testing.T) {
	root, bare := initRemoteRepo(t)
	writeFile(t, filepath.Join(root, "a.txt"), "one\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "add a")
	runGit(t, root, "push", "-u", "origin", "main")

	// Local commit pushes main ahead.
	writeFile(t, filepath.Join(root, "a.txt"), "one\ntwo\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "local work")

	// Second clone advances origin so local main is also behind.
	other := filepath.Join(t.TempDir(), "other")
	runGit(t, t.TempDir(), "clone", "-q", bare, other)
	runGit(t, other, "config", "user.email", "test@example.com")
	runGit(t, other, "config", "user.name", "Test")
	writeFile(t, filepath.Join(other, "b.txt"), "remote\n")
	runGit(t, other, "add", "b.txt")
	runGit(t, other, "commit", "-qm", "remote work")
	runGit(t, other, "push", "-q", "origin", "main")

	runGit(t, root, "fetch")
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	branches, err := repo.ListBranches(context.Background(), &ExecRunner{})
	if err != nil {
		t.Fatalf("ListBranches: %v", err)
	}
	for _, b := range branches {
		if b.Name == "main" {
			if b.Ahead != 1 || b.Behind != 1 {
				t.Fatalf("main ahead=%d behind=%d, want 1/1", b.Ahead, b.Behind)
			}
		}
	}
}

func TestListBranchesInitialState(t *testing.T) {
	root := initTestRepo(t)
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	branches, err := repo.ListBranches(context.Background(), &ExecRunner{})
	if err != nil {
		t.Fatalf("ListBranches: %v", err)
	}
	if len(branches) != 1 || branches[0].Name != "main" || !branches[0].Current {
		t.Fatalf("unexpected branches %+v", branches)
	}
}

func TestParseForEachRef(t *testing.T) {
	raw := []byte(
		"refs/heads/main\x00abc\x00*\x00refs/remotes/origin/main\x00[ahead 3]\n" +
			"refs/heads/feature\x00def\x00 \x00refs/remotes/origin/feature\x00[gone]\n" +
			"refs/remotes/origin/main\x00abc\x00 \x00\x00\n",
	)
	branches, err := ParseForEachRef(raw)
	if err != nil {
		t.Fatalf("ParseForEachRef: %v", err)
	}
	if len(branches) != 3 {
		t.Fatalf("got %d branches, want 3: %+v", len(branches), branches)
	}
	main := branches[0]
	if main.Name != "main" || !main.Current || main.Upstream != "origin/main" || main.Ahead != 3 || main.Behind != 0 {
		t.Fatalf("main = %+v", main)
	}
	feat := branches[1]
	if feat.Name != "feature" || feat.Current || feat.Upstream != "origin/feature" || feat.Ahead != 0 || feat.Behind != 0 {
		t.Fatalf("feature = %+v", feat)
	}
	rem := branches[2]
	if rem.Name != "origin/main" || !rem.Remote || rem.Upstream != "" {
		t.Fatalf("remote = %+v", rem)
	}
}

func TestParseForEachRefBehindOnly(t *testing.T) {
	raw := []byte("refs/heads/main\x00abc\x00 \x00refs/remotes/origin/main\x00[behind 2]\n")
	branches, err := ParseForEachRef(raw)
	if err != nil {
		t.Fatalf("ParseForEachRef: %v", err)
	}
	if len(branches) != 1 || branches[0].Ahead != 0 || branches[0].Behind != 2 {
		t.Fatalf("got %+v, want behind 2", branches)
	}
}

func TestParseForEachRefMalformed(t *testing.T) {
	for _, raw := range []string{
		"refs/heads/main\x00abc\n",                          // missing HEAD/upstream fields
		"refs/heads/main\x00abc\x00 \x00\x00[sideways 1]\n", // unknown track direction
		"refs/heads/main\x00abc\x00 \x00\x00[ahead nope]\n", // non-numeric count
		"not-a-ref\x00abc\x00 \x00\x00\n",                   // unknown ref namespace
	} {
		if _, err := ParseForEachRef([]byte(raw)); err == nil {
			t.Fatalf("ParseForEachRef(%q) = nil error, want error", raw)
		}
	}
}

func currentBranch(t *testing.T, root string) string {
	t.Helper()
	return strings.TrimSpace(runGit(t, root, "branch", "--show-current"))
}

func TestSwitchBranch(t *testing.T) {
	root := initTestRepo(t)
	runGit(t, root, "switch", "-c", "feature")
	runGit(t, root, "switch", "main")

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	if err := repo.SwitchBranch(context.Background(), &ExecRunner{}, "feature"); err != nil {
		t.Fatalf("SwitchBranch: %v", err)
	}
	if got := currentBranch(t, root); got != "feature" {
		t.Fatalf("current branch = %q, want feature", got)
	}
}

func TestSwitchBranchRejectsBadName(t *testing.T) {
	root := initTestRepo(t)
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	for _, name := range []string{"", "-x", "has space", "a\x00b"} {
		if err := repo.SwitchBranch(context.Background(), &ExecRunner{}, name); !errors.Is(err, protocol.ErrInvalidRef) {
			t.Fatalf("SwitchBranch(%q) error = %v, want ErrInvalidRef", name, err)
		}
	}
}

func TestSwitchBranchMissing(t *testing.T) {
	root := initTestRepo(t)
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	if err := repo.SwitchBranch(context.Background(), &ExecRunner{}, "nope"); err == nil {
		t.Fatal("SwitchBranch(missing) = nil error, want error")
	}
}

func TestCreateBranch(t *testing.T) {
	root := initTestRepo(t)
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	if err := repo.CreateBranch(context.Background(), &ExecRunner{}, "topic", ""); err != nil {
		t.Fatalf("CreateBranch: %v", err)
	}
	if got := currentBranch(t, root); got != "topic" {
		t.Fatalf("current branch = %q, want topic", got)
	}

	if err := repo.CreateBranch(context.Background(), &ExecRunner{}, "topic2", "main"); err != nil {
		t.Fatalf("CreateBranch from start: %v", err)
	}
	if got := currentBranch(t, root); got != "topic2" {
		t.Fatalf("current branch = %q, want topic2", got)
	}
	// topic2 was created at main, which is the same commit as HEAD initially.
	if a, b := runGit(t, root, "rev-parse", "topic2"), runGit(t, root, "rev-parse", "main"); a != b {
		t.Fatalf("topic2 = %s, main = %s, want equal", a, b)
	}
}

func TestLiteralBranchNamesAcceptAtAndUnicode(t *testing.T) {
	root := initTestRepo(t)
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	runner := &ExecRunner{}
	for _, name := range []string{"release@next", "功能/分支"} {
		if err := repo.CreateBranch(context.Background(), runner, name, "HEAD~0"); err != nil {
			t.Fatalf("CreateBranch(%q): %v", name, err)
		}
		runGit(t, root, "switch", "main")
	}
}

func TestCreateBranchRejectsRevisionSyntaxAsLiteralName(t *testing.T) {
	root := initTestRepo(t)
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	for _, name := range []string{"topic~1", "topic^", "topic@{1}", "@{-1}"} {
		if err := repo.CreateBranch(context.Background(), &ExecRunner{}, name, ""); !errors.Is(err, protocol.ErrInvalidRef) {
			t.Fatalf("CreateBranch(%q) = %v, want ErrInvalidRef", name, err)
		}
	}
}

func TestCreateBranchRejectsBadName(t *testing.T) {
	root := initTestRepo(t)
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	if err := repo.CreateBranch(context.Background(), &ExecRunner{}, "a b", ""); !errors.Is(err, protocol.ErrInvalidRef) {
		t.Fatalf("CreateBranch(bad name) error = %v, want ErrInvalidRef", err)
	}
	if err := repo.CreateBranch(context.Background(), &ExecRunner{}, "topic", "-x"); !errors.Is(err, protocol.ErrInvalidRef) {
		t.Fatalf("CreateBranch(bad start) error = %v, want ErrInvalidRef", err)
	}
	if err := repo.CreateBranch(context.Background(), &ExecRunner{}, "topic..x", ""); !errors.Is(err, protocol.ErrInvalidRef) {
		t.Fatalf("CreateBranch(double dot) error = %v, want ErrInvalidRef", err)
	}
}

func TestDeleteBranchMerged(t *testing.T) {
	root := initTestRepo(t)
	runGit(t, root, "switch", "-c", "topic")
	runGit(t, root, "switch", "main")

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	if err := repo.DeleteBranch(context.Background(), &ExecRunner{}, "topic", false); err != nil {
		t.Fatalf("DeleteBranch merged: %v", err)
	}
	runGitErr(t, root, "rev-parse", "--verify", "refs/heads/topic")
}

func TestDeleteBranchNotMergedRequiresForce(t *testing.T) {
	root := initTestRepo(t)
	runGit(t, root, "switch", "-c", "topic")
	writeFile(t, filepath.Join(root, "t.txt"), "topic\n")
	runGit(t, root, "add", "t.txt")
	runGit(t, root, "commit", "-qm", "topic work")
	runGit(t, root, "switch", "main")

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	if err := repo.DeleteBranch(context.Background(), &ExecRunner{}, "topic", false); !errors.Is(err, ErrBranchNotMerged) {
		t.Fatalf("DeleteBranch unmerged = %v, want ErrBranchNotMerged", err)
	}
	if err := repo.DeleteBranch(context.Background(), &ExecRunner{}, "topic", true); err != nil {
		t.Fatalf("DeleteBranch force: %v", err)
	}
}

func TestDeleteBranchRejectsBadName(t *testing.T) {
	root := initTestRepo(t)
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	if err := repo.DeleteBranch(context.Background(), &ExecRunner{}, "a b", false); !errors.Is(err, protocol.ErrInvalidRef) {
		t.Fatalf("DeleteBranch(bad name) error = %v, want ErrInvalidRef", err)
	}
}
