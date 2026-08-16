package gitx

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

// splitHunkPatches splits a git diff into one standalone patch per hunk. Each
// patch keeps the file header (---/+++) plus a single hunk, which is the shape
// git apply accepts for partial staging.
func splitHunkPatches(t *testing.T, fullDiff string) []string {
	t.Helper()
	lines := strings.Split(fullDiff, "\n")
	var header []string
	i := 0
	for ; i < len(lines); i++ {
		if strings.HasPrefix(lines[i], "@@") {
			break
		}
		header = append(header, lines[i])
	}
	if i == len(lines) {
		t.Fatalf("diff has no hunks:\n%s", fullDiff)
	}
	var patches []string
	cur := append([]string{}, header...)
	for ; i < len(lines); i++ {
		if strings.HasPrefix(lines[i], "@@") && len(cur) > len(header) {
			patches = append(patches, strings.Join(cur, "\n"))
			cur = append([]string{}, header...)
		}
		cur = append(cur, lines[i])
	}
	patches = append(patches, strings.Join(cur, "\n"))
	for n := range patches {
		if !strings.HasSuffix(patches[n], "\n") {
			patches[n] += "\n"
		}
	}
	return patches
}

func runIndexAssert(t *testing.T, root string, args ...string) string {
	t.Helper()
	return runGit(t, root, args...)
}

func TestStagePreservesWorktree(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "file.txt"), "base\n")
	runGit(t, root, "add", "file.txt")
	runGit(t, root, "commit", "-q", "-m", "add file")

	writeFile(t, filepath.Join(root, "file.txt"), "changed\n")
	repo, err := Discover(context.Background(), &ExecRunner{}, root)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.Stage(context.Background(), &ExecRunner{}, []string{"file.txt"}); err != nil {
		t.Fatalf("Stage: %v", err)
	}
	if got := runIndexAssert(t, root, "status", "--porcelain"); got != "M  file.txt\n" {
		t.Fatalf("status = %q, want staged-only M", got)
	}
	if got, err := os.ReadFile(filepath.Join(root, "file.txt")); err != nil {
		t.Fatalf("read worktree: %v", err)
	} else if string(got) != "changed\n" {
		t.Fatalf("worktree = %q, want unchanged 'changed\\n'", got)
	}
}

func TestUnstagePreservesWorktree(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "file.txt"), "base\n")
	runGit(t, root, "add", "file.txt")
	runGit(t, root, "commit", "-q", "-m", "add file")

	writeFile(t, filepath.Join(root, "file.txt"), "changed\n")
	runGit(t, root, "add", "file.txt")
	repo, err := Discover(context.Background(), &ExecRunner{}, root)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.Unstage(context.Background(), &ExecRunner{}, []string{"file.txt"}); err != nil {
		t.Fatalf("Unstage: %v", err)
	}
	if got := runIndexAssert(t, root, "status", "--porcelain"); got != " M file.txt\n" {
		t.Fatalf("status = %q, want unstaged-only M", got)
	}
	if got, err := os.ReadFile(filepath.Join(root, "file.txt")); err != nil {
		t.Fatalf("read worktree: %v", err)
	} else if string(got) != "changed\n" {
		t.Fatalf("worktree = %q, want unchanged 'changed\\n'", got)
	}
}

func TestDiscardTrackedRestoresIndexVersion(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "file.txt"), "base\n")
	runGit(t, root, "add", "file.txt")
	runGit(t, root, "commit", "-q", "-m", "add file")

	writeFile(t, filepath.Join(root, "file.txt"), "local junk\n")
	repo, err := Discover(context.Background(), &ExecRunner{}, root)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.DiscardTracked(context.Background(), &ExecRunner{}, []string{"file.txt"}); err != nil {
		t.Fatalf("DiscardTracked: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(root, "file.txt")); err != nil {
		t.Fatalf("read worktree: %v", err)
	} else if string(got) != "base\n" {
		t.Fatalf("worktree = %q, want restored 'base\\n'", got)
	}
	if got := runIndexAssert(t, root, "status", "--porcelain"); got != "" {
		t.Fatalf("status = %q, want clean", got)
	}
}

func TestDeleteUntrackedRemovesOnlySelected(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "a.txt"), "a\n")
	writeFile(t, filepath.Join(root, "b.txt"), "b\n")
	repo, err := Discover(context.Background(), &ExecRunner{}, root)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteUntracked(context.Background(), &ExecRunner{}, []string{"a.txt"}); err != nil {
		t.Fatalf("DeleteUntracked: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "a.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a.txt still exists after delete: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "b.txt")); err != nil {
		t.Fatalf("b.txt was removed: %v", err)
	}
}

func TestDeleteUntrackedRefusesDirectories(t *testing.T) {
	root := initTestRepo(t)
	if err := os.Mkdir(filepath.Join(root, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	repo, err := Discover(context.Background(), &ExecRunner{}, root)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteUntracked(context.Background(), &ExecRunner{}, []string{"dir"}); err == nil {
		t.Fatal("DeleteUntracked on a directory = nil error, want error")
	}
	if _, err := os.Stat(filepath.Join(root, "dir")); err != nil {
		t.Fatalf("directory was removed: %v", err)
	}
}

func TestMutationsRejectInvalidPaths(t *testing.T) {
	root := initTestRepo(t)
	repo, err := Discover(context.Background(), &ExecRunner{}, root)
	if err != nil {
		t.Fatal(err)
	}
	for _, paths := range [][]string{{"../escape"}, {"/abs"}, {""}, {"a/../b"}} {
		if err := repo.Stage(context.Background(), &ExecRunner{}, paths); !errors.Is(err, protocol.ErrInvalidPath) {
			t.Fatalf("Stage(%q) error = %v, want protocol.ErrInvalidPath", paths, err)
		}
	}
}

// numberedFileString builds a 40-line file "1\n2\n...\n40\n" with replacements.
func numberedFileString(replacements map[int]string) string {
	var b strings.Builder
	for i := 1; i <= 40; i++ {
		line := strconv.Itoa(i)
		if r, ok := replacements[i]; ok {
			line = r
		}
		b.WriteString(line)
		b.WriteByte('\n')
	}
	return b.String()
}

// numberedFile writes the 40-line numbered file into root/file.txt.
func numberedFile(t *testing.T, root string, replacements map[int]string) string {
	t.Helper()
	content := numberedFileString(replacements)
	writeFile(t, filepath.Join(root, "file.txt"), content)
	return content
}

func TestApplyPatchStagesOneHunkLeavesAnotherUnstaged(t *testing.T) {
	root := initTestRepo(t)
	numberedFile(t, root, nil)
	runGit(t, root, "add", "file.txt")
	runGit(t, root, "commit", "-q", "-m", "base")

	numberedFile(t, root, map[int]string{2: "TWO", 30: "THIRTY"})
	repo, err := Discover(context.Background(), &ExecRunner{}, root)
	if err != nil {
		t.Fatal(err)
	}
	diff := runGit(t, root, "diff", "--", "file.txt")
	hunks := splitHunkPatches(t, diff)
	if len(hunks) < 2 {
		t.Fatalf("expected >=2 hunks, got %d:\n%s", len(hunks), diff)
	}

	if err := repo.ApplyPatch(context.Background(), &ExecRunner{}, []byte(hunks[0]), false); err != nil {
		t.Fatalf("ApplyPatch: %v", err)
	}

	staged := runGit(t, root, "diff", "--cached", "--", "file.txt")
	if !strings.Contains(staged, "+TWO") || strings.Contains(staged, "+THIRTY") {
		t.Fatalf("staged diff has wrong hunks:\n%s", staged)
	}
	unstaged := runGit(t, root, "diff", "--", "file.txt")
	if !strings.Contains(unstaged, "+THIRTY") || strings.Contains(unstaged, "+TWO") {
		t.Fatalf("unstaged diff has wrong hunks:\n%s", unstaged)
	}
	if got := runIndexAssert(t, root, "status", "--porcelain"); got != "MM file.txt\n" {
		t.Fatalf("status = %q, want MM file.txt", got)
	}
}

func TestApplyPatchReverseUnstagesOneHunk(t *testing.T) {
	root := initTestRepo(t)
	numberedFile(t, root, nil)
	runGit(t, root, "add", "file.txt")
	runGit(t, root, "commit", "-q", "-m", "base")

	numberedFile(t, root, map[int]string{2: "TWO", 30: "THIRTY"})
	runGit(t, root, "add", "file.txt")
	repo, err := Discover(context.Background(), &ExecRunner{}, root)
	if err != nil {
		t.Fatal(err)
	}
	staged := runGit(t, root, "diff", "--cached", "--", "file.txt")
	hunks := splitHunkPatches(t, staged)
	if len(hunks) < 2 {
		t.Fatalf("expected >=2 hunks, got %d:\n%s", len(hunks), staged)
	}

	if err := repo.ApplyPatch(context.Background(), &ExecRunner{}, []byte(hunks[0]), true); err != nil {
		t.Fatalf("ApplyPatch reverse: %v", err)
	}

	remaining := runGit(t, root, "diff", "--cached", "--", "file.txt")
	if strings.Contains(remaining, "+TWO") || !strings.Contains(remaining, "+THIRTY") {
		t.Fatalf("remaining staged diff wrong:\n%s", remaining)
	}
	if got, err := os.ReadFile(filepath.Join(root, "file.txt")); err != nil {
		t.Fatalf("read worktree: %v", err)
	} else if string(got) != numberedFileString(map[int]string{2: "TWO", 30: "THIRTY"}) {
		t.Fatalf("worktree changed by unstage: %q", got)
	}
}

func TestApplyPatchRejectsStalePatch(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "file.txt"), "base\n")
	runGit(t, root, "add", "file.txt")
	runGit(t, root, "commit", "-q", "-m", "base")

	writeFile(t, filepath.Join(root, "file.txt"), "changed\n")
	repo, err := Discover(context.Background(), &ExecRunner{}, root)
	if err != nil {
		t.Fatal(err)
	}
	patch := []byte(runGit(t, root, "diff", "--", "file.txt"))
	if err := repo.ApplyPatch(context.Background(), &ExecRunner{}, patch, false); err != nil {
		t.Fatalf("ApplyPatch: %v", err)
	}

	// The index now contains "changed"; returning the worktree to "base" makes
	// the previously valid patch stale against the index.
	writeFile(t, filepath.Join(root, "file.txt"), "base\n")
	if err := repo.ApplyPatch(context.Background(), &ExecRunner{}, patch, false); !errors.Is(err, ErrPatchDoesNotApply) {
		t.Fatalf("stale ApplyPatch error = %v, want ErrPatchDoesNotApply", err)
	}
	// The index must be untouched by the rejected patch.
	if got := runIndexAssert(t, root, "show", ":file.txt"); got != "changed\n" {
		t.Fatalf("index = %q, want unchanged 'changed\\n'", got)
	}
}

func TestApplyPatchRejectsEmpty(t *testing.T) {
	root := initTestRepo(t)
	repo, err := Discover(context.Background(), &ExecRunner{}, root)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.ApplyPatch(context.Background(), &ExecRunner{}, nil, false); !errors.Is(err, protocol.ErrInvalidPath) {
		t.Fatalf("empty ApplyPatch error = %v, want protocol.ErrInvalidPath", err)
	}
}

func TestStageRejectsEmptyPathList(t *testing.T) {
	root := initTestRepo(t)
	repo, err := Discover(context.Background(), &ExecRunner{}, root)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.Stage(context.Background(), &ExecRunner{}, nil); !errors.Is(err, protocol.ErrInvalidPath) {
		t.Fatalf("Stage(nil) error = %v, want protocol.ErrInvalidPath", err)
	}
}
