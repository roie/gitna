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

func searchIndexPath(a *repoAdapter) string {
	a.search.mu.RLock()
	defer a.search.mu.RUnlock()
	return a.search.path
}

func sessionSearchEvents(t *testing.T, s *folderSession) map[watch.InvalidationKind]bool {
	t.Helper()
	seen := map[watch.InvalidationKind]bool{}
	select {
	case event := <-s.events:
		seen[event] = true
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for session event")
	}
	timer := time.NewTimer(350 * time.Millisecond)
	defer timer.Stop()
	for {
		select {
		case event := <-s.events:
			seen[event] = true
		case <-timer.C:
			return seen
		}
	}
}

func newSearchTestSession(t *testing.T, root string) *folderSession {
	t.Helper()
	runner := &gitx.ExecRunner{}
	repo, err := gitx.OpenFolder(t.Context(), runner, root)
	if err != nil {
		t.Fatal(err)
	}
	s, err := newFolderSession(t.Context(), runner, repo,
		folder.Open(filepath.Join(t.TempDir(), "folders.json"), 5),
		func(ctx context.Context, repo gitx.Repository, runner gitx.Runner, opts watch.Options) (watch.Watcher, error) {
			opts.Debounce = 250 * time.Millisecond
			// Exercise delivered events independently of conservative fallback recovery.
			opts.FallbackInterval = -1
			return watch.New(ctx, repo, runner, opts)
		})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.close() })
	seen := sessionSearchEvents(t, s)
	if !seen[watch.InvalidateFiles] || !seen[watch.InvalidateGraph] {
		t.Fatalf("startup events = %v", seen)
	}
	return s
}

func TestFolderSessionSearchReusesIndexesForContentAndRefs(t *testing.T) {
	for _, repository := range []bool{false, true} {
		name := "ordinary"
		root := t.TempDir()
		if repository {
			name = "repository"
			root = initSessionRepository(t, root, "repo")
		}
		t.Run(name, func(t *testing.T) {
			file := filepath.Join(root, "file.txt")
			if err := os.WriteFile(file, []byte("before"), 0o600); err != nil {
				t.Fatal(err)
			}
			s := newSearchTestSession(t, root)
			waitForFolderSearch(t, s.adapter, "file", nil, 100)
			indexPath := searchIndexPath(s.adapter)
			if _, err := s.adapter.DirectoryEntries(t.Context(), "", "", 100); err != nil {
				t.Fatal(err)
			}
			s.adapter.directories.mu.Lock()
			cacheID := s.adapter.directories.cacheID
			s.adapter.directories.mu.Unlock()

			actions := []struct {
				name string
				run  func()
			}{
				{"text edit", func() {
					if err := os.WriteFile(file, []byte("after"), 0o600); err != nil {
						t.Fatal(err)
					}
				}},
				{"atomic replacement", func() {
					temporary := filepath.Join(root, ".file.txt.save")
					if err := os.WriteFile(temporary, []byte("replacement"), 0o600); err != nil {
						t.Fatal(err)
					}
					if err := os.Rename(temporary, file); err != nil {
						if err := os.Remove(file); err != nil {
							t.Fatal(err)
						}
						if err := os.Rename(temporary, file); err != nil {
							t.Fatal(err)
						}
					}
				}},
			}
			if repository {
				actions = append(actions, struct {
					name string
					run  func()
				}{"refs", func() {
					// An unborn symbolic HEAD update changes refs without touching the index.
					if output, err := exec.Command("git", "-C", root, "symbolic-ref", "HEAD", "refs/heads/other").CombinedOutput(); err != nil {
						t.Fatalf("symbolic-ref: %v: %s", err, output)
					}
				}})
			}
			for _, action := range actions {
				t.Run(action.name, func(t *testing.T) {
					action.run()
					seen := sessionSearchEvents(t, s)
					if !seen[watch.InvalidateSnapshot] || seen[watch.InvalidateFiles] {
						t.Fatalf("events = %v", seen)
					}
					if action.name == "refs" && !seen[watch.InvalidateGraph] {
						t.Fatalf("missing graph invalidation: %v", seen)
					}
					waitForFolderSearch(t, s.adapter, "file", nil, 100)
					if got := searchIndexPath(s.adapter); got != indexPath {
						t.Errorf("index rebuilt: %q -> %q", indexPath, got)
					}
					s.adapter.directories.mu.Lock()
					defer s.adapter.directories.mu.Unlock()
					if s.adapter.directories.cacheID != cacheID {
						t.Error("directory cache invalidated for unrelated change")
					}
				})
			}
		})
	}
}

func TestFolderSessionSearchInvalidatesSamePathDirectoryReplacement(t *testing.T) {
	for _, repository := range []bool{false, true} {
		name := "ordinary"
		if repository {
			name = "repository"
		}
		t.Run(name, func(t *testing.T) {
			parent := t.TempDir()
			root := filepath.Join(parent, "root")
			if repository {
				root = initSessionRepository(t, parent, "root")
			}
			sub := filepath.Join(root, "sub")
			replacement := filepath.Join(parent, "replacement")
			for directory, filename := range map[string]string{sub: "old.txt", replacement: "new.txt"} {
				if err := os.MkdirAll(directory, 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(directory, filename), []byte("content"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			s := newSearchTestSession(t, root)
			results := waitForFolderSearch(t, s.adapter, ".txt", nil, 100)
			if len(results.Results) != 1 || results.Results[0].Path != "sub/old.txt" {
				t.Fatalf("initial search = %+v", results)
			}
			previous := searchIndexPath(s.adapter)

			// Both renames stay on the same filesystem and within one debounce
			// window: the root's immediate child names and types are unchanged.
			if err := os.Rename(sub, filepath.Join(parent, "retired")); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(replacement, sub); err != nil {
				t.Fatal(err)
			}
			seen := sessionSearchEvents(t, s)
			results = waitForFolderSearch(t, s.adapter, ".txt", nil, 100)
			if len(results.Results) != 1 || results.Results[0].Path != "sub/new.txt" {
				t.Fatalf("search after replacement = %+v; events = %v", results, seen)
			}
			if !seen[watch.InvalidateFiles] || searchIndexPath(s.adapter) == previous {
				t.Fatalf("replacement retained index; events = %v", seen)
			}
		})
	}
}

func TestFolderSessionSearchInvalidatesMembershipAndIgnoreMetadata(t *testing.T) {
	root := initSessionRepository(t, t.TempDir(), "repo")
	write := func(path, content string) {
		t.Helper()
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	git := func(args ...string) {
		t.Helper()
		if output, err := exec.Command("git", append([]string{"-C", root}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, output)
		}
	}
	write("nested/file.txt", "content")
	write(".gitignore", "# initial\n")
	write("nested/.gitignore", "# initial\n")
	s := newSearchTestSession(t, root)
	for _, step := range []struct {
		name string
		run  func()
		want int
	}{
		{"root ignore edit", func() { write(".gitignore", "*.txt\n") }, 0},
		{"root ignore removal", func() { write(".gitignore", "# cleared\n") }, 1},
		{"nested ignore edit", func() { write("nested/.gitignore", "*.txt\n") }, 0},
		{"track ignored file", func() { git("add", "-f", "nested/file.txt") }, 1},
		{"untrack ignored file", func() { git("rm", "--cached", "-f", "nested/file.txt") }, 0},
		{"nested ignore removal", func() { write("nested/.gitignore", "# cleared\n") }, 1},
		{"add", func() { write("nested/second.txt", "new") }, 2},
		{"rename", func() {
			if err := os.Rename(filepath.Join(root, "nested/second.txt"), filepath.Join(root, "nested/renamed.txt")); err != nil {
				t.Fatal(err)
			}
		}, 2},
		{"remove", func() {
			if err := os.Remove(filepath.Join(root, "nested/renamed.txt")); err != nil {
				t.Fatal(err)
			}
		}, 1},
	} {
		t.Run(step.name, func(t *testing.T) {
			waitForFolderSearch(t, s.adapter, ".txt", nil, 100)
			previous := searchIndexPath(s.adapter)
			step.run()
			if seen := sessionSearchEvents(t, s); !seen[watch.InvalidateFiles] {
				t.Fatalf("events = %v, want files invalidation", seen)
			}
			waitForFolderSearch(t, s.adapter, ".txt", nil, 100)
			if searchIndexPath(s.adapter) == previous {
				t.Fatal("stale index retained")
			}
			results, err := s.adapter.SearchFiles(t.Context(), ".txt", nil, false, false, 100)
			if err != nil || len(results.Results) != step.want {
				t.Fatalf("search = %+v, %v; want %d visible files", results, err, step.want)
			}
		})
	}
}

func TestFolderSessionSearchOrdinaryMembershipAndExplicitRefresh(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "unobserved"), 0o755); err != nil {
		t.Fatal(err)
	}
	s := newSearchTestSession(t, root)
	waitForFolderSearch(t, s.adapter, "txt", nil, 100)
	if _, err := s.adapter.DirectoryEntries(t.Context(), "", "", 100); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	if seen := sessionSearchEvents(t, s); !seen[watch.InvalidateFiles] {
		t.Fatalf("events = %v", seen)
	}
	if results := waitForFolderSearch(t, s.adapter, "txt", nil, 100); len(results.Results) != 1 {
		t.Fatalf("search = %+v", results)
	}
	entries, err := s.adapter.DirectoryEntries(t.Context(), "", "", 100)
	if err != nil || len(entries.Entries) != 2 {
		t.Fatalf("directory cache retained stale membership: %+v, %v", entries, err)
	}
	previous := searchIndexPath(s.adapter)
	if err := os.WriteFile(filepath.Join(root, "unobserved", "hidden.txt"), []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Root-only observation deliberately cannot detect unloaded descendant edits.
	select {
	case event := <-s.events:
		t.Fatalf("unexpected event for unobserved descendant: %v", event)
	case <-time.After(150 * time.Millisecond):
	}
	if results := waitForFolderSearch(t, s.adapter, "txt", nil, 100); len(results.Results) != 1 {
		t.Fatalf("unobserved change unexpectedly refreshed search: %+v", results)
	}
	if _, err := s.adapter.SearchFiles(t.Context(), "txt", nil, true, true, 100); err != nil {
		t.Fatal(err)
	}
	if results := waitForFolderSearch(t, s.adapter, "txt", nil, 100); len(results.Results) != 2 || searchIndexPath(s.adapter) == previous {
		t.Fatalf("explicit refresh did not rebuild search: %+v", results)
	}
	s.adapter.directories.mu.Lock()
	defer s.adapter.directories.mu.Unlock()
	if len(s.adapter.directories.entries) != 0 {
		t.Fatal("explicit refresh retained directory cache")
	}
}

// Save itself does not retire caches. A real watcher may still detect temporary
// membership when a slow fsync spans the debounce window; that is intentionally
// separate from the fast atomic-replacement case above.
func TestFolderSessionSearchAdapterSaveHasNoDirectInvalidation(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("before"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := newFolderSession(t.Context(), &gitx.ExecRunner{}, gitx.Repository{Root: root},
		folder.Open(filepath.Join(t.TempDir(), "folders.json"), 5),
		func(context.Context, gitx.Repository, gitx.Runner, watch.Options) (watch.Watcher, error) {
			return &testWatcher{events: make(chan watch.InvalidationKind)}, nil
		})
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	sessionSearchEvents(t, s)
	waitForFolderSearch(t, s.adapter, "file", nil, 100)
	previous := searchIndexPath(s.adapter)
	if _, err := s.adapter.DirectoryEntries(t.Context(), "", "", 100); err != nil {
		t.Fatal(err)
	}
	current, err := s.adapter.ReadWorktreeFile(t.Context(), "file.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.adapter.WriteWorktreeFile(t.Context(), "file.txt", "saved", current.Hash); err != nil {
		t.Fatal(err)
	}
	if searchIndexPath(s.adapter) != previous {
		t.Fatal("adapter save directly invalidated filename index")
	}
	s.adapter.directories.mu.Lock()
	defer s.adapter.directories.mu.Unlock()
	if len(s.adapter.directories.entries) != 1 {
		t.Fatal("adapter save directly invalidated directory cache")
	}
}

func TestFolderSessionSearchInvalidationRetiresActiveReader(t *testing.T) {
	root := t.TempDir()
	s := newSearchTestSession(t, root)
	waitForFolderSearch(t, s.adapter, "file", nil, 100)
	previous := searchIndexPath(s.adapter)
	reader, err := os.Open(previous)
	if err != nil {
		t.Fatal(err)
	}
	s.adapter.search.mu.Lock()
	s.adapter.search.readers++
	s.adapter.search.mu.Unlock()
	released := false
	defer func() {
		if !released {
			_ = reader.Close()
			s.adapter.releaseFileSearchReader()
		}
	}()
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	if seen := sessionSearchEvents(t, s); !seen[watch.InvalidateFiles] {
		t.Fatalf("events = %v", seen)
	}
	if _, err := os.Stat(previous); err != nil {
		t.Fatalf("index removed before reader release: %v", err)
	}
	if results := waitForFolderSearch(t, s.adapter, "file", nil, 100); len(results.Results) != 1 || searchIndexPath(s.adapter) == previous {
		t.Fatalf("replacement index = %+v", results)
	}
	_ = reader.Close()
	s.adapter.releaseFileSearchReader()
	released = true
	if _, err := os.Stat(previous); !os.IsNotExist(err) {
		t.Fatalf("retired index retained after reader release: %v", err)
	}
}
