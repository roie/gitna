package app

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/roie/gitna/internal/folder"
	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/watch"
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

func TestFolderSessionSwitchesAdapterAndStableEventStream(t *testing.T) {
	parent := t.TempDir()
	first := initSessionRepository(t, parent, "first")
	second := initSessionRepository(t, parent, "second")
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	runner := &gitx.ExecRunner{}
	repo, err := gitx.Discover(ctx, runner, first)
	if err != nil {
		t.Fatal(err)
	}
	catalog := folder.Open(filepath.Join(t.TempDir(), "folders.json"), 5)
	session, err := newFolderSession(ctx, runner, repo, catalog)
	if err != nil {
		t.Fatal(err)
	}
	defer session.close()

	root, err := session.openFolder(ctx, second)
	if err != nil {
		t.Fatal(err)
	}
	if root != second || session.adapter.current().Root != second {
		t.Fatalf("root = %q adapter = %q", root, session.adapter.current().Root)
	}
	folders := session.folderCatalog()
	if folders.Current.Path != second || len(folders.Recent) != 2 {
		t.Fatalf("folders = %#v", folders)
	}
	if folders.Recent[0].Path != second || folders.Recent[1].Path != first {
		t.Fatalf("recent folders = %#v", folders.Recent)
	}

	seen := map[watch.InvalidationKind]bool{}
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for len(seen) < 2 {
		select {
		case event := <-session.events:
			seen[event] = true
		case <-timer.C:
			t.Fatalf("events = %#v", seen)
		}
	}
	if !seen[watch.InvalidateSnapshot] || !seen[watch.InvalidateGraph] {
		t.Fatalf("events = %#v", seen)
	}
}
