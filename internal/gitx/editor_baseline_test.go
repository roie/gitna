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

func TestIndexBaselineGitStates(t *testing.T) {
	for _, name := range []string{"clean", "modified", "empty", "staged-new", "intent-to-add", "untracked", "ignored", "tracked-ignored", "deleted-recreated"} {
		t.Run(name, func(t *testing.T) {
			repo, runner := diffRepo(t)
			path, want, present := "a.txt", "one\n", true
			switch name {
			case "modified":
				writeFile(t, filepath.Join(repo.Root, path), "edited\n")
			case "empty":
				writeFile(t, filepath.Join(repo.Root, path), "")
				runGit(t, repo.Root, "add", "--", path)
				runGit(t, repo.Root, "commit", "-qm", "empty")
				want = ""
				writeFile(t, filepath.Join(repo.Root, path), "new\n")
			case "staged-new", "intent-to-add", "untracked", "ignored":
				path = "new.txt"
				writeFile(t, filepath.Join(repo.Root, path), "new\n")
				want = ""
				present = false
				if name == "staged-new" {
					runGit(t, repo.Root, "add", "--", path)
					want = "new\n"
					present = true
					writeFile(t, filepath.Join(repo.Root, path), "edited\n")
				}
				if name == "intent-to-add" {
					runGit(t, repo.Root, "add", "-N", "--", path)
					present = true
				}
				if name == "ignored" {
					writeFile(t, filepath.Join(repo.GitDir, "info", "exclude"), "new.txt\n")
				}
			case "tracked-ignored":
				writeFile(t, filepath.Join(repo.GitDir, "info", "exclude"), "a.txt\n")
				writeFile(t, filepath.Join(repo.Root, path), "edited\n")
			case "deleted-recreated":
				runGit(t, repo.Root, "rm", "--", path)
				writeFile(t, filepath.Join(repo.Root, path), "recreated\n")
				want = ""
				present = false
			}
			baseline, err := repo.IndexBaseline(t.Context(), runner, path)
			if err != nil || baseline.Present != present || baseline.Content != want {
				t.Fatalf("baseline=%+v err=%v want present=%v content=%q", baseline, err, present, want)
			}
			blame, err := repo.FileBlame(t.Context(), runner, path)
			if err != nil || blame.ContentHash == "" {
				t.Fatalf("blame=%+v err=%v", blame, err)
			}
			if (!present || name == "staged-new" || name == "intent-to-add") && len(blame.Ranges) != 0 {
				t.Fatalf("new or untracked file attributed: %+v", blame)
			}
			if name == "untracked" || name == "ignored" || name == "intent-to-add" {
				diff, err := repo.Diff(t.Context(), runner, protocol.DiffUnstaged, protocol.DiffOptions{Path: path})
				if err != nil || diff.Before.Content != "" || diff.After.Content != "new\n" {
					t.Fatalf("new-file review lost additions: %+v %v", diff, err)
				}
			}
		})
	}
}

func TestIndexBaselineCacheInvalidation(t *testing.T) {
	repo, runner := diffRepo(t)
	counted := &editorCountingRunner{Runner: runner}
	var cache IndexBaselineCache
	read := func(want string, wantCalls int) {
		t.Helper()
		counted.calls = 0
		baseline, err := cache.Read(t.Context(), repo, counted, "a.txt")
		if err != nil || baseline.Content != want || counted.calls != wantCalls {
			t.Fatalf("baseline=%+v err=%v calls=%d want=%d", baseline, err, counted.calls, wantCalls)
		}
	}
	read("one\n", 3)
	read("one\n", 0)
	writeFile(t, filepath.Join(repo.Root, "unrelated.txt"), "other\n")
	read("one\n", 0)
	runGit(t, repo.Root, "add", "--", "unrelated.txt")
	read("one\n", 1)
	writeFile(t, filepath.Join(repo.Root, "a.txt"), "staged\n")
	runGit(t, repo.Root, "add", "--", "a.txt")
	read("staged\n", 3)
	runGit(t, repo.Root, "reset", "-q", "HEAD", "--", "a.txt")
	read("one\n", 3)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := cache.Read(ctx, repo, counted, "a.txt"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cache ignored cancellation: %v", err)
	}
	other, _ := diffRepo(t)
	writeFile(t, filepath.Join(other.Root, "a.txt"), "other repo\n")
	runGit(t, other.Root, "add", "a.txt")
	baseline, err := cache.Read(t.Context(), other, runner, "a.txt")
	if err != nil || baseline.Content != "other repo\n" {
		t.Fatalf("cross-repository cache: %+v %v", baseline, err)
	}
}

func TestIndexBaselineBoundsAndLiteralPaths(t *testing.T) {
	repo, runner := diffRepo(t)
	for _, path := range []string{"[a].txt", ":(glob)*", "with\nnewline.txt"} {
		writeFile(t, filepath.Join(repo.Root, path), "literal\n")
		runGit(t, repo.Root, "--literal-pathspecs", "add", "--", path)
		baseline, err := repo.IndexBaseline(t.Context(), runner, path)
		if err != nil || !baseline.Present || baseline.Content != "literal\n" {
			t.Fatalf("literal %q: %+v %v", path, baseline, err)
		}
	}
	writeFile(t, filepath.Join(repo.Root, "large.txt"), strings.Repeat("x", DefaultDiffBytes+1))
	runGit(t, repo.Root, "add", "large.txt")
	counted := &editorCountingRunner{Runner: runner}
	baseline, err := repo.IndexBaseline(t.Context(), counted, "large.txt")
	if err != nil || !baseline.Present || !baseline.TooLarge || baseline.Content != "" || counted.calls != 2 {
		t.Fatalf("unbounded read: %+v %v calls=%d", baseline, err, counted.calls)
	}
	baseline, err = repo.IndexBaseline(t.Context(), runner, "large.txt", DefaultDiffBytes+1)
	if err != nil || baseline.TooLarge || len(baseline.Content) != DefaultDiffBytes+1 {
		t.Fatalf("approved baseline: %+v %v", baseline, err)
	}
	writeFile(t, filepath.Join(repo.Root, "binary.txt"), "a\x00b")
	runGit(t, repo.Root, "add", "binary.txt")
	baseline, err = repo.IndexBaseline(t.Context(), runner, "binary.txt")
	if err != nil || !baseline.Binary || baseline.Content != "" {
		t.Fatalf("binary baseline: %+v %v", baseline, err)
	}
	if _, err := repo.IndexBaseline(t.Context(), runner, "../a.txt"); !errors.Is(err, protocol.ErrInvalidPath) {
		t.Fatalf("unsafe path: %v", err)
	}
}

func TestIndexRevisionIgnoresWorktreeChanges(t *testing.T) {
	repo, _ := diffRepo(t)
	var cache IndexBaselineCache
	first, err := cache.Revision(repo)
	if err != nil || first == 0 {
		t.Fatalf("revision=%d err=%v", first, err)
	}
	writeFile(t, filepath.Join(repo.Root, "a.txt"), "edited\n")
	if next, err := cache.Revision(repo); err != nil || next != first {
		t.Fatalf("worktree invalidated index: %d %v", next, err)
	}
	runGit(t, repo.Root, "add", "a.txt")
	if next, err := cache.Revision(repo); err != nil || next <= first {
		t.Fatalf("index change missed: %d %v", next, err)
	}
	other, _ := diffRepo(t)
	before, _ := cache.Revision(repo)
	if next, err := cache.Revision(other); err != nil || next <= before {
		t.Fatalf("repository change missed: %d %v", next, err)
	}
}

type editorSnapshotRunner struct {
	Runner
	beforeBlame func()
}

func (r editorSnapshotRunner) RunInput(ctx context.Context, root string, input []byte, args ...string) (Result, error) {
	if args[0] == "blame" {
		r.beforeBlame()
	}
	return r.Runner.RunInput(ctx, root, input, args...)
}

func TestFileBlamePinsContentAndHead(t *testing.T) {
	repo, runner := diffRepo(t)
	head := strings.TrimSpace(runGit(t, repo.Root, "rev-parse", "HEAD"))
	writeFile(t, filepath.Join(repo.Root, "a.txt"), "two\n")
	runGit(t, repo.Root, "add", "a.txt")
	runGit(t, repo.Root, "commit", "-qm", "second")
	next := strings.TrimSpace(runGit(t, repo.Root, "rev-parse", "HEAD"))
	runGit(t, repo.Root, "update-ref", "HEAD", head)
	writeFile(t, filepath.Join(repo.Root, "a.txt"), "one\n")
	file, err := repo.ReadWorktreeFile(t.Context(), "a.txt")
	if err != nil {
		t.Fatal(err)
	}
	blame, err := repo.FileBlame(t.Context(), editorSnapshotRunner{Runner: runner, beforeBlame: func() {
		writeFile(t, filepath.Join(repo.Root, "a.txt"), "two\n")
		runGit(t, repo.Root, "update-ref", "HEAD", next)
	}}, "a.txt")
	if err != nil || blame.ContentHash != file.Hash || blame.HeadOID != head || len(blame.Ranges) != 1 || blame.Ranges[0].OID != head {
		t.Fatalf("raced blame: %+v %v", blame, err)
	}
	if _, err := repo.FileBlame(t.Context(), editorFailureRunner{Runner: runner, failure: Result{ExitCode: 128, Stderr: []byte("repository unreadable")}}, "a.txt"); err == nil {
		t.Fatal("Git failure treated as uncommitted")
	}
}

type editorFailureRunner struct {
	Runner
	failure Result
	err     error
}

func (r editorFailureRunner) RunInput(context.Context, string, []byte, ...string) (Result, error) {
	return r.failure, r.err
}

func TestBlobMissingIsNotGitFailure(t *testing.T) {
	repo, runner := diffRepo(t)
	if _, present, err := repo.readBlob(t.Context(), runner, "HEAD:not-there"); err != nil || present {
		t.Fatalf("missing blob: %v %v", present, err)
	}
	for _, result := range []Result{{ExitCode: 128, Stderr: []byte("repository unreadable")}, {Stdout: []byte("garbage\n")}} {
		if _, _, err := repo.readBlob(t.Context(), editorFailureRunner{Runner: runner, failure: result}, "HEAD:a.txt"); err == nil {
			t.Fatal("Git failure treated as absent")
		}
	}
	oid := strings.TrimSpace(runGit(t, repo.Root, "rev-parse", ":a.txt"))
	if err := os.Remove(filepath.Join(repo.GitDir, "objects", oid[:2], oid[2:])); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.IndexBaseline(t.Context(), runner, "a.txt"); err == nil {
		t.Fatal("missing indexed object treated as untracked")
	}
}
