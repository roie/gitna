package gitx

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

func TestReadCommitFileUsesCommittedContent(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "notes.txt"), "committed\n")
	runGit(t, root, "add", "notes.txt")
	runGit(t, root, "commit", "-qm", "notes")
	oid := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD"))
	writeFile(t, filepath.Join(root, "notes.txt"), "worktree\n")

	repo, err := Discover(context.Background(), &ExecRunner{}, root)
	if err != nil {
		t.Fatal(err)
	}
	file, err := repo.ReadCommitFile(context.Background(), &ExecRunner{}, oid, "notes.txt", false)
	if err != nil {
		t.Fatal(err)
	}
	if file.After.Content != "committed\n" || file.Binary || file.TooLarge {
		t.Fatalf("file = %#v", file)
	}
}

func TestReadCommitFileReadsDeletedContentFromFirstParent(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "deleted.txt"), "before deletion\n")
	runGit(t, root, "add", "deleted.txt")
	runGit(t, root, "commit", "-qm", "add deleted file")
	if err := os.Remove(filepath.Join(root, "deleted.txt")); err != nil {
		t.Fatal(err)
	}
	runGit(t, root, "add", "deleted.txt")
	runGit(t, root, "commit", "-qm", "delete file")
	oid := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD"))
	repo, err := Discover(context.Background(), &ExecRunner{}, root)
	if err != nil {
		t.Fatal(err)
	}

	file, err := repo.ReadCommitFile(context.Background(), &ExecRunner{}, oid, "deleted.txt", true)
	if err != nil {
		t.Fatal(err)
	}
	if file.After.Content != "before deletion\n" {
		t.Fatalf("content = %q", file.After.Content)
	}
}

func TestReadCommitFileClassifiesBinaryAndOversizedContent(t *testing.T) {
	root := initTestRepo(t)
	if err := os.WriteFile(filepath.Join(root, "binary.dat"), []byte{'a', 0, 'b'}, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(root, "preview.png"),
		[]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'},
		0o644,
	); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(root, "large.txt"), strings.Repeat("x", DefaultDiffBytes+1))
	runGit(t, root, "add", "binary.dat", "preview.png", "large.txt")
	runGit(t, root, "commit", "-qm", "bounded files")
	oid := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD"))
	repo, err := Discover(context.Background(), &ExecRunner{}, root)
	if err != nil {
		t.Fatal(err)
	}

	binary, err := repo.ReadCommitFile(context.Background(), &ExecRunner{}, oid, "binary.dat", false)
	if err != nil {
		t.Fatal(err)
	}
	if !binary.Binary || binary.TooLarge || binary.After.Content != "" {
		t.Fatalf("binary = %#v", binary)
	}
	image, err := repo.ReadCommitFile(context.Background(), &ExecRunner{}, oid, "preview.png", false)
	if err != nil {
		t.Fatal(err)
	}
	if !image.Binary || image.After.Image == nil || image.After.Image.MIME != "image/png" {
		t.Fatalf("image = %#v", image)
	}
	large, err := repo.ReadCommitFile(context.Background(), &ExecRunner{}, oid, "large.txt", false)
	if err != nil {
		t.Fatal(err)
	}
	if !large.TooLarge || large.After.Content != "" {
		t.Fatalf("large = %#v", large)
	}
}

func TestReadCommitFileRejectsInvalidAndMissingObjects(t *testing.T) {
	repo, runner := diffRepo(t)
	for _, test := range []struct {
		oid  string
		path string
		want error
	}{
		{oid: "-oops", path: "a.txt", want: protocol.ErrInvalidRef},
		{oid: "HEAD", path: "../escape", want: protocol.ErrInvalidPath},
		{oid: "HEAD", path: "missing.txt", want: os.ErrNotExist},
	} {
		_, err := repo.ReadCommitFile(context.Background(), runner, test.oid, test.path, false)
		if !errors.Is(err, test.want) {
			t.Fatalf("ReadCommitFile(%q, %q) error = %v, want %v", test.oid, test.path, err, test.want)
		}
	}
}
