package gitx

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func initTestRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	runGit(t, root, "init", "-q", root)
	runGit(t, root, "config", "user.email", "test@example.com")
	runGit(t, root, "config", "user.name", "Test")
	runGit(t, root, "branch", "-M", "main")
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

func runGitErr(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("git %v unexpectedly succeeded: %s", args, out)
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

func TestOpenFolderReportsLocalDiscoveryPhases(t *testing.T) {
	root := t.TempDir()
	phases := map[string]time.Duration{}
	ctx := WithOpenFolderTrace(t.Context(), func(phase string, duration time.Duration) {
		phases[phase] = duration
	})
	if _, err := OpenFolder(ctx, &ExecRunner{}, root); err != nil {
		t.Fatal(err)
	}
	for _, phase := range []string{"folder-resolve-symlink", "folder-resolve-git"} {
		if _, exists := phases[phase]; !exists {
			t.Fatalf("missing phase %q: %v", phase, phases)
		}
	}
}

func TestOpenFolderAcceptsOrdinaryDirectoryAndPreservesGitRoot(t *testing.T) {
	runner := &ExecRunner{}
	folder := t.TempDir()
	opened, err := OpenFolder(t.Context(), runner, folder)
	if err != nil || opened.Root != folder || opened.IsGit() {
		t.Fatalf("folder = %#v, err = %v", opened, err)
	}

	repoRoot := initTestRepo(t)
	nested := filepath.Join(repoRoot, "nested")
	if err := os.Mkdir(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	opened, err = OpenFolder(t.Context(), runner, nested)
	if err != nil || opened.Root != repoRoot || !opened.IsGit() {
		t.Fatalf("repo = %#v, err = %v", opened, err)
	}
}

func TestOpenFolderRejectsFileAndMissingPath(t *testing.T) {
	runner := &ExecRunner{}
	root := t.TempDir()
	file := filepath.Join(root, "file.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{file, filepath.Join(root, "missing")} {
		if _, err := OpenFolder(t.Context(), runner, path); err == nil {
			t.Fatalf("OpenFolder(%q) succeeded", path)
		}
	}
}
