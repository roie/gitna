package app

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

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

func TestRepositorySessionSwitchesAdapterAndStableEventStream(t *testing.T) {
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
	session, err := newRepositorySession(ctx, runner, repo)
	if err != nil {
		t.Fatal(err)
	}
	defer session.close()

	root, err := session.switchRepository(ctx, second)
	if err != nil {
		t.Fatal(err)
	}
	if root != second || session.adapter.current().Root != second {
		t.Fatalf("root = %q adapter = %q", root, session.adapter.current().Root)
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
