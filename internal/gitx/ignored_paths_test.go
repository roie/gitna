package gitx

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIgnoredPathsUsesGitRulesAndNULDelimitedPaths(t *testing.T) {
	root := initTestRepo(t)
	if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte("ignored/\n*.log\n!important.log\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "ignored"), 0o755); err != nil {
		t.Fatal(err)
	}
	newlinePath := "ignored/line\nbreak.txt"
	for path, content := range map[string]string{
		newlinePath:     "ignored",
		"tracked.log":   "tracked",
		"important.log": "included",
	} {
		if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(path)), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	runGit(t, root, "add", ".gitignore", "important.log")
	runGit(t, root, "add", "-f", "tracked.log")
	runGit(t, root, "commit", "-qm", "add ignore fixture")

	ignored, err := (Repository{Root: root, GitDir: filepath.Join(root, ".git")}).IgnoredPaths(
		t.Context(),
		&ExecRunner{},
		[]string{"ignored/", newlinePath, "tracked.log", "important.log"},
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"ignored/", newlinePath} {
		if _, ok := ignored[path]; !ok {
			t.Fatalf("ignored paths = %#v, want %q", ignored, path)
		}
	}
	for _, path := range []string{"tracked.log", "important.log"} {
		if _, ok := ignored[path]; ok {
			t.Fatalf("ignored paths = %#v, did not want %q", ignored, path)
		}
	}
}
