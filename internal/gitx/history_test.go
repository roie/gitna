package gitx

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/roie/gitna/internal/protocol"
)

// buildHistoryFixture builds a repository with a two-branch topology, a merge
// commit, a tag, and a remote-tracking ref:
//
//	root ── second ── merge (main, HEAD, tag v1.0, origin/main)
//	  └──── feature ─┘
//
// The root commit exists so %D decorations carry real ref names.
func buildHistoryFixture(t *testing.T) string {
	t.Helper()
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "a.txt"), "a\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-q", "-m", "root commit")

	runGit(t, root, "checkout", "-q", "-b", "feature")
	writeFile(t, filepath.Join(root, "f.txt"), "f\n")
	runGit(t, root, "add", "f.txt")
	runGit(t, root, "commit", "-q", "-m", "feature work")

	runGit(t, root, "checkout", "-q", "main")
	writeFile(t, filepath.Join(root, "b.txt"), "b\n")
	runGit(t, root, "add", "b.txt")
	runGit(t, root, "commit", "-q", "-m", "second")

	runGit(t, root, "merge", "-q", "--no-ff", "feature", "-m", "merge feature")
	runGit(t, root, "tag", "v1.0")
	runGit(t, root, "update-ref", "refs/remotes/origin/main", "HEAD")
	return root
}

func historyDiscover(t *testing.T, root string) (Repository, *ExecRunner) {
	t.Helper()
	runner := &ExecRunner{}
	repo, err := Discover(context.Background(), runner, root)
	if err != nil {
		t.Fatal(err)
	}
	return repo, runner
}

func TestHistoryReturnsTopoOrderWithParents(t *testing.T) {
	root := buildHistoryFixture(t)
	repo, runner := historyDiscover(t, root)

	commits, err := repo.History(context.Background(), runner, 0, 0)
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	// The fixture has five commits: the initial empty commit from
	// initTestRepo plus the four built by buildHistoryFixture.
	if len(commits) != 5 {
		t.Fatalf("got %d commits, want 5", len(commits))
	}

	merge, featureWork, second, rootCommit := commits[0], commits[1], commits[2], commits[3]
	if merge.Subject != "merge feature" {
		t.Fatalf("commits[0] subject = %q, want merge feature", merge.Subject)
	}
	if len(merge.Parents) != 2 {
		t.Fatalf("merge parents = %v, want 2", merge.Parents)
	}
	if merge.Parents[0] != second.OID || merge.Parents[1] != featureWork.OID {
		t.Fatalf("merge parents = %v, want [%s %s]", merge.Parents, second.OID, featureWork.OID)
	}
	if featureWork.Subject != "feature work" || second.Subject != "second" {
		t.Fatalf("unexpected order: %q, %q", featureWork.Subject, second.Subject)
	}
	if len(rootCommit.Parents) != 1 {
		t.Fatalf("root parents = %v, want its single parent", rootCommit.Parents)
	}
	if merge.OID == "" || rootCommit.OID == "" {
		t.Fatal("commits missing OIDs")
	}
	if merge.AuthorTime.IsZero() || merge.AuthorName == "" {
		t.Fatalf("merge author = %q at %v, want populated", merge.AuthorName, merge.AuthorTime)
	}
	if _, err := time.Parse(time.RFC3339, merge.AuthorTime.Format(time.RFC3339)); err != nil {
		t.Fatalf("author time does not round-trip RFC3339: %v", err)
	}
}

func TestHistoryParsesRefs(t *testing.T) {
	root := buildHistoryFixture(t)
	repo, runner := historyDiscover(t, root)

	commits, err := repo.History(context.Background(), runner, 0, 0)
	if err != nil {
		t.Fatalf("History: %v", err)
	}

	// The merge commit carries HEAD, the local branch, the tag, and the
	// remote-tracking ref; the feature commit carries the feature branch.
	merge, featureWork := commits[0], commits[1]
	wantMerge := []protocol.CommitRef{
		{Name: "main", Kind: protocol.RefKindHead},
		{Name: "v1.0", Kind: protocol.RefKindTag},
		{Name: "origin/main", Kind: protocol.RefKindRemoteBranch},
	}
	if len(merge.Refs) != len(wantMerge) {
		t.Fatalf("merge refs = %+v, want %+v", merge.Refs, wantMerge)
	}
	for i := range wantMerge {
		if merge.Refs[i] != wantMerge[i] {
			t.Fatalf("merge refs[%d] = %+v, want %+v", i, merge.Refs[i], wantMerge[i])
		}
	}
	if len(featureWork.Refs) != 1 || featureWork.Refs[0] != (protocol.CommitRef{Name: "feature", Kind: protocol.RefKindLocalBranch}) {
		t.Fatalf("feature refs = %+v, want [feature local-branch]", featureWork.Refs)
	}
}

func TestHistorySkipAndLimit(t *testing.T) {
	root := buildHistoryFixture(t)
	repo, runner := historyDiscover(t, root)

	all, err := repo.History(context.Background(), runner, 0, 0)
	if err != nil {
		t.Fatalf("History: %v", err)
	}

	page, err := repo.History(context.Background(), runner, 2, 2)
	if err != nil {
		t.Fatalf("History skip: %v", err)
	}
	if len(page) != 2 {
		t.Fatalf("got %d commits, want 2", len(page))
	}
	if page[0].OID != all[2].OID || page[1].OID != all[3].OID {
		t.Fatalf("skip page = [%s %s], want [%s %s]", page[0].OID, page[1].OID, all[2].OID, all[3].OID)
	}

	pastEnd, err := repo.History(context.Background(), runner, 100, 100)
	if err != nil {
		t.Fatalf("History past end: %v", err)
	}
	if len(pastEnd) != 0 {
		t.Fatalf("past-end page = %d commits, want 0", len(pastEnd))
	}
}

func TestHistoryRejectsInvalidPagination(t *testing.T) {
	root := buildHistoryFixture(t)
	repo, runner := historyDiscover(t, root)

	if _, err := repo.History(context.Background(), runner, -1, 0); err == nil {
		t.Fatal("negative skip accepted")
	}
	if _, err := repo.History(context.Background(), runner, 0, maxHistoryLimit+1); err == nil {
		t.Fatal("oversized limit accepted")
	}
}

func TestHistoryFailsWithoutCommits(t *testing.T) {
	root := t.TempDir()
	runGit(t, root, "init", "-q", root)
	runGit(t, root, "config", "user.email", "test@example.com")
	runGit(t, root, "config", "user.name", "Test")
	repo, runner := historyDiscover(t, root)

	if _, err := repo.History(context.Background(), runner, 0, 0); err == nil {
		t.Fatal("History on an empty repository succeeded, want error")
	}
}

func TestParseDiffTreeStatuses(t *testing.T) {
	raw := []byte("M\x00x.txt\x00R100\x00a.txt\x00b.txt\x00D\x00c.txt\x00A\x00d.txt\x00")
	files, err := ParseDiffTree(raw)
	if err != nil {
		t.Fatalf("ParseDiffTree: %v", err)
	}
	want := []protocol.CommitFile{
		{Path: "x.txt", Kind: protocol.KindModified},
		{Path: "b.txt", OldPath: "a.txt", Kind: protocol.KindRenamed},
		{Path: "c.txt", Kind: protocol.KindDeleted},
		{Path: "d.txt", Kind: protocol.KindAdded},
	}
	if len(files) != len(want) {
		t.Fatalf("got %d files %+v, want %d", len(files), files, len(want))
	}
	for i := range want {
		if files[i] != want[i] {
			t.Fatalf("files[%d] = %+v, want %+v", i, files[i], want[i])
		}
	}
}

func TestParseDiffTreeRejectsBadPaths(t *testing.T) {
	for _, raw := range [][]byte{
		[]byte("M\x00"),
		[]byte("R100\x00a.txt\x00"),
		[]byte("M\x00../escape\x00"),
		[]byte("M\x00/abs/path\x00"),
	} {
		if _, err := ParseDiffTree(raw); err == nil {
			t.Fatalf("ParseDiffTree(%q) succeeded, want error", raw)
		}
	}
}

func TestChangedFilesIncludesRenameDeleteAdd(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "a.txt"), "a\n")
	writeFile(t, filepath.Join(root, "b.txt"), "b\n")
	runGit(t, root, "add", "a.txt", "b.txt")
	runGit(t, root, "commit", "-q", "-m", "base")

	runGit(t, root, "mv", "a.txt", "c.txt")
	runGit(t, root, "rm", "b.txt")
	writeFile(t, filepath.Join(root, "d.txt"), "d\n")
	runGit(t, root, "add", "d.txt")
	runGit(t, root, "commit", "-q", "-m", "rename delete add")
	oid := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD"))

	repo, runner := historyDiscover(t, root)
	files, err := repo.ChangedFiles(context.Background(), runner, oid)
	if err != nil {
		t.Fatalf("ChangedFiles: %v", err)
	}
	got := make(map[protocol.CommitFile]bool)
	for _, f := range files {
		got[f] = true
	}
	for _, want := range []protocol.CommitFile{
		{Path: "c.txt", OldPath: "a.txt", Kind: protocol.KindRenamed},
		{Path: "b.txt", Kind: protocol.KindDeleted},
		{Path: "d.txt", Kind: protocol.KindAdded},
	} {
		if !got[want] {
			t.Fatalf("files = %+v, missing %+v", files, want)
		}
	}
}

func TestChangedFilesOnRootCommit(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "only.txt"), "only\n")
	runGit(t, root, "add", "only.txt")
	runGit(t, root, "commit", "-q", "-m", "only file")
	oid := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD"))

	repo, runner := historyDiscover(t, root)
	files, err := repo.ChangedFiles(context.Background(), runner, oid)
	if err != nil {
		t.Fatalf("ChangedFiles: %v", err)
	}
	if len(files) != 1 || files[0].Path != "only.txt" || files[0].Kind != protocol.KindAdded {
		t.Fatalf("files = %+v, want [only.txt added]", files)
	}
}

func TestChangedFilesOnMergeVsFirstParent(t *testing.T) {
	root := buildHistoryFixture(t)
	repo, runner := historyDiscover(t, root)

	oid := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD"))
	files, err := repo.ChangedFiles(context.Background(), runner, oid)
	if err != nil {
		t.Fatalf("ChangedFiles: %v", err)
	}
	// The merge brings feature's f.txt into main; compared against the first
	// parent (second, which added b.txt) that is the only change.
	if len(files) != 1 || files[0].Path != "f.txt" || files[0].Kind != protocol.KindAdded {
		t.Fatalf("merge files = %+v, want [f.txt added]", files)
	}
}

func TestChangedFilesRejectsBadOID(t *testing.T) {
	root := buildHistoryFixture(t)
	repo, runner := historyDiscover(t, root)

	if _, err := repo.ChangedFiles(context.Background(), runner, "-oops"); err == nil {
		t.Fatal("ChangedFiles accepted a leading-dash ref")
	}
	if _, err := repo.ChangedFiles(context.Background(), runner, "not a ref!"); err == nil {
		t.Fatal("ChangedFiles accepted a ref with invalid characters")
	}
}
