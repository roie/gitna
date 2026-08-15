package gitx

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func initTestRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	runGit(t, root, "init", "-q", root)
	runGit(t, root, "config", "user.email", "test@example.com")
	runGit(t, root, "config", "user.name", "Test")
	runGit(t, root, "commit", "-q", "--allow-empty", "-m", "initial")
	return root
}

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return string(out)
}

func TestDiscoverFromRepoRoot(t *testing.T) {
	root := initTestRepo(t)
	r := &ExecRunner{}

	repo, err := Discover(context.Background(), r, root)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if repo.Root != filepath.Clean(root) {
		t.Fatalf("Root = %q, want %q", repo.Root, root)
	}
	if repo.GitDir == "" {
		t.Fatal("GitDir is empty")
	}
	if repo.GitDir != filepath.Join(root, ".git") {
		t.Fatalf("GitDir = %q, want %q", repo.GitDir, filepath.Join(root, ".git"))
	}
}

func TestDiscoverFromNestedDir(t *testing.T) {
	root := initTestRepo(t)
	nested := filepath.Join(root, "a", "b")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	r := &ExecRunner{}

	repo, err := Discover(context.Background(), r, nested)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if repo.Root != filepath.Clean(root) {
		t.Fatalf("Root = %q, want %q", repo.Root, root)
	}
}

func TestDiscoverOutsideRepository(t *testing.T) {
	dir := t.TempDir()
	r := &ExecRunner{}

	if _, err := Discover(context.Background(), r, dir); err == nil {
		t.Fatal("Discover outside a repository = nil error, want error")
	}
}

func TestDiscoverNonexistentPath(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "missing")
	r := &ExecRunner{}

	if _, err := Discover(context.Background(), r, dir); err == nil {
		t.Fatal("Discover on missing path = nil error, want error")
	}
}
