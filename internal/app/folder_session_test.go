package app

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/roie/gitna/internal/folder"
	"github.com/roie/gitna/internal/gitx"
)

func initSessionRepository(t *testing.T, parent, name string) string {
	t.Helper()
	root := filepath.Join(parent, name)
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("git", "-C", root, "init", "-q", "-b", "main")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, output)
	}
	return root
}

func TestFolderSessionOwnsOneFolder(t *testing.T) {
	root := initSessionRepository(t, t.TempDir(), "first")
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	runner := &gitx.ExecRunner{}
	repo, err := gitx.Discover(ctx, runner, root)
	if err != nil {
		t.Fatal(err)
	}
	catalog := folder.Open(filepath.Join(t.TempDir(), "folders.json"), 5)
	session, err := newFolderSession(ctx, runner, repo, catalog)
	if err != nil {
		t.Fatal(err)
	}
	defer session.close()

	if session.adapter.current().Root != root {
		t.Fatalf("adapter root = %q, want %q", session.adapter.current().Root, root)
	}
	folders := session.folderCatalog()
	if folders.Current.Path != root || len(folders.Recent) != 1 {
		t.Fatalf("folders = %#v", folders)
	}
	if err := session.close(); err != nil {
		t.Fatal(err)
	}
}
