package gitx

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

func TestLineHistoryReturnsCommittedAndWorkingTreeLines(t *testing.T) {
	root := initTestRepo(t)
	path := filepath.Join(root, "notes.txt")
	if err := os.WriteFile(path, []byte("committed\nsecond\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, root, "add", "--", "notes.txt")
	runGit(t, root, "commit", "-q", "-m", "add notes")
	oid := runGit(t, root, "rev-parse", "HEAD")
	if err := os.WriteFile(path, []byte("committed\nchanged\nnew line\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	runner := &ExecRunner{}
	committed, err := repo.LineHistory(t.Context(), runner, "notes.txt", 1)
	if err != nil {
		t.Fatal(err)
	}
	if committed.Uncommitted || committed.OID != oid[:len(oid)-1] || committed.ShortOID == "" || committed.Author != "Test" || committed.Summary != "add notes" || committed.AuthoredAt == nil {
		t.Fatalf("committed = %#v", committed)
	}
	changed, err := repo.LineHistory(t.Context(), runner, "notes.txt", 2)
	if err != nil {
		t.Fatal(err)
	}
	if !changed.Uncommitted || changed.OID != "" {
		t.Fatalf("changed = %#v", changed)
	}
	added, err := repo.LineHistory(t.Context(), runner, "notes.txt", 3)
	if err != nil {
		t.Fatal(err)
	}
	if !added.Uncommitted {
		t.Fatalf("added = %#v", added)
	}
}

func TestLineHistoryFollowsRenamedFileToAttributedCommitPath(t *testing.T) {
	root := initTestRepo(t)
	oldPath := filepath.Join(root, "old-name.txt")
	if err := os.WriteFile(oldPath, []byte("kept line\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, root, "add", "--", "old-name.txt")
	runGit(t, root, "commit", "-qm", "add original name")
	originalOID := runGit(t, root, "rev-parse", "HEAD")
	runGit(t, root, "mv", "old-name.txt", "new-name.txt")
	runGit(t, root, "commit", "-qm", "rename file")

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	history, err := repo.LineHistory(t.Context(), &ExecRunner{}, "new-name.txt", 1)
	if err != nil {
		t.Fatal(err)
	}
	if history.OID != originalOID[:len(originalOID)-1] || history.Path != "new-name.txt" || history.CommitPath != "old-name.txt" {
		t.Fatalf("history = %#v", history)
	}
}

func TestLineHistoryHandlesUntrackedUnbornAndUnsafeFiles(t *testing.T) {
	root := initTestRepo(t)
	if err := os.WriteFile(filepath.Join(root, "untracked.txt"), []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	runner := &ExecRunner{}
	untracked, err := repo.LineHistory(t.Context(), runner, "untracked.txt", 1)
	if err != nil || !untracked.Uncommitted {
		t.Fatalf("untracked = %#v, err = %v", untracked, err)
	}
	if err := os.WriteFile(filepath.Join(root, "-L"), []byte("safe argument\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, root, "add", "--", "-L")
	runGit(t, root, "commit", "-qm", "dash path")
	if history, err := repo.LineHistory(t.Context(), runner, "-L", 1); err != nil || history.Uncommitted || history.Summary != "dash path" {
		t.Fatalf("dash path = %#v, err = %v", history, err)
	}

	unbornRoot := t.TempDir()
	runGit(t, unbornRoot, "init", "-q")
	if err := os.WriteFile(filepath.Join(unbornRoot, "new.txt"), []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	unbornRepo := Repository{Root: unbornRoot, GitDir: filepath.Join(unbornRoot, ".git")}
	unborn, err := unbornRepo.LineHistory(t.Context(), runner, "new.txt", 1)
	if err != nil || !unborn.Uncommitted {
		t.Fatalf("unborn = %#v, err = %v", unborn, err)
	}

	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "link.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "binary.dat"), []byte{'a', 0, 'b'}, 0o644); err != nil {
		t.Fatal(err)
	}
	for name, path := range map[string]string{"escape": "../secret", "git": ".git/config", "symlink": "link.txt", "binary": "binary.dat"} {
		t.Run(name, func(t *testing.T) {
			_, err := repo.LineHistory(t.Context(), runner, path, 1)
			want := protocol.ErrInvalidPath
			if name == "binary" {
				want = protocol.ErrWorktreeBinary
			}
			if !errors.Is(err, want) {
				t.Fatalf("error = %v, want %v", err, want)
			}
		})
	}
	if _, err := repo.LineHistory(t.Context(), runner, "untracked.txt", 2); !errors.Is(err, protocol.ErrInvalidPath) {
		t.Fatalf("out-of-range error = %v", err)
	}
}

func TestLineHistoryUsesApprovedLargeFileBudget(t *testing.T) {
	root := initTestRepo(t)
	content := strings.Repeat("x\n", DefaultDiffBytes/2+1024)
	if err := os.WriteFile(filepath.Join(root, "large.txt"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, root, "add", "--", "large.txt")
	runGit(t, root, "commit", "-q", "-m", "add large file")
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	runner := &ExecRunner{}
	if _, err := repo.LineHistory(t.Context(), runner, "large.txt", 1); !errors.Is(err, protocol.ErrWorktreeFileTooLarge) {
		t.Fatalf("default budget error = %v", err)
	}
	last := DefaultDiffBytes/2 + 1024
	history, err := repo.LineHistory(t.Context(), runner, "large.txt", last, int64(len(content)))
	if err != nil {
		t.Fatal(err)
	}
	if history.Uncommitted || history.Summary != "add large file" {
		t.Fatalf("history = %+v", history)
	}
}

func TestFileBlameMatchesLineHistoryForEveryLine(t *testing.T) {
	root := initTestRepo(t)
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("old.txt", "one\ntwo\nthree\nfour\n")
	runGit(t, root, "add", "--", "old.txt")
	runGit(t, root, "commit", "-qm", "first")
	runGit(t, root, "mv", "old.txt", "notes.txt")
	write("notes.txt", "one\nTWO\nthree\nfour\nfive\n")
	runGit(t, root, "add", "--", "notes.txt")
	runGit(t, root, "commit", "-qm", "second")
	write("notes.txt", "one\nTWO\nchanged\nfour\nfive\nsix\n")
	write("untracked.txt", "new\n")

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	runner := &ExecRunner{}
	blame, err := repo.FileBlame(t.Context(), runner, "notes.txt")
	if err != nil {
		t.Fatal(err)
	}
	for line := 1; line <= 6; line++ {
		want, err := repo.LineHistory(t.Context(), runner, "notes.txt", line)
		if err != nil {
			t.Fatal(err)
		}
		var got *protocol.BlameRange
		for index := range blame.Ranges {
			r := &blame.Ranges[index]
			if line >= r.Start && line < r.Start+r.Count {
				got = r
			}
		}
		if want.Uncommitted {
			if got != nil {
				t.Fatalf("line %d: want uncommitted, got %+v", line, *got)
			}
			continue
		}
		if got == nil {
			t.Fatalf("line %d: missing range, want %s", line, want.OID)
		}
		commit := blame.Commits[got.OID]
		wantPath := want.CommitPath
		if wantPath == "notes.txt" {
			wantPath = ""
		}
		if got.OID != want.OID || got.CommitPath != wantPath || commit.Author != want.Author || commit.Summary != want.Summary || !commit.AuthoredAt.Equal(*want.AuthoredAt) {
			t.Fatalf("line %d: got %+v %+v, want %+v", line, *got, commit, want)
		}
	}
	if blame.Ranges[0].CommitPath != "old.txt" {
		t.Fatalf("renamed line path = %q", blame.Ranges[0].CommitPath)
	}

	untracked, err := repo.FileBlame(t.Context(), runner, "untracked.txt")
	if err != nil || len(untracked.Ranges) != 0 {
		t.Fatalf("untracked = %+v, %v", untracked, err)
	}
	write("binary.dat", "a\x00b")
	if _, err := repo.FileBlame(t.Context(), runner, "binary.dat"); !errors.Is(err, protocol.ErrWorktreeBinary) {
		t.Fatalf("binary error = %v", err)
	}
	if _, err := repo.FileBlame(t.Context(), runner, "../escape"); !errors.Is(err, protocol.ErrInvalidPath) {
		t.Fatalf("escape error = %v", err)
	}
}
