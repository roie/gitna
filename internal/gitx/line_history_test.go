package gitx

import (
	"errors"
	"os"
	"path/filepath"
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
