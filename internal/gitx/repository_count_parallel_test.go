package gitx

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type countRecordRunner func(context.Context, string, func([]byte) error, ...string) (Result, error)

func (run countRecordRunner) RunNUL(ctx context.Context, root string, visit func([]byte) error, args ...string) (Result, error) {
	return run(ctx, root, visit, args...)
}

func countRecords(total int) countRecordRunner {
	return func(ctx context.Context, _ string, visit func([]byte) error, args ...string) (Result, error) {
		if strings.Contains(strings.Join(args, " "), "--ignored") {
			total = 2
		}
		buffer := make([]byte, 32)
		for index := range total {
			if err := ctx.Err(); err != nil {
				return Result{}, err
			}
			path := fmt.Sprintf("file-%03d", index)
			copy(buffer, path)
			if err := visit(buffer[:len(path)]); err != nil {
				return Result{}, err
			}
		}
		return Result{}, nil
	}
}

func TestStreamRepositoryCountBoundsWorkersAndCopiesRecords(t *testing.T) {
	var active, maximum atomic.Int32
	var mu sync.Mutex
	seen := make(map[string]int)
	stat := func(path string) (os.FileInfo, error) {
		current := active.Add(1)
		defer active.Add(-1)
		for previous := maximum.Load(); current > previous; previous = maximum.Load() {
			if maximum.CompareAndSwap(previous, current) {
				break
			}
		}
		time.Sleep(time.Millisecond)
		name := filepath.Base(path)
		mu.Lock()
		seen[name]++
		mu.Unlock()
		if name == "file-065" {
			return nil, os.ErrNotExist
		}
		return nil, nil
	}
	total, err := (Repository{Root: t.TempDir()}).streamRepositoryFileCount(t.Context(), countRecords(530), stat)
	if err != nil || total != 531 {
		t.Fatalf("count = %d, error = %v; want 531", total, err)
	}
	if maximum.Load() > 4 || active.Load() != 0 {
		t.Fatalf("maximum workers = %d, active after return = %d", maximum.Load(), active.Load())
	}
	for index := range 530 {
		name := fmt.Sprintf("file-%03d", index)
		if seen[name] != 1 {
			t.Fatalf("%s checked %d times", name, seen[name])
		}
	}
}

func TestStreamRepositoryCountReturnsFirstRecordError(t *testing.T) {
	first, later := errors.New("first record error"), errors.New("later record error")
	total, err := (Repository{Root: t.TempDir()}).streamRepositoryFileCount(t.Context(), countRecords(130), func(path string) (os.FileInfo, error) {
		switch filepath.Base(path) {
		case "file-000":
			time.Sleep(time.Millisecond)
			return nil, first
		case "file-020":
			return nil, later
		default:
			return nil, nil
		}
	})
	if total != 0 || !errors.Is(err, first) {
		t.Fatalf("count = %d, error = %v; want first error and no partial count", total, err)
	}
}

func TestStreamRepositoryCountJoinsWorkersOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	var active atomic.Int32
	total, err := (Repository{Root: t.TempDir()}).streamRepositoryFileCount(ctx, countRecords(130), func(string) (os.FileInfo, error) {
		active.Add(1)
		defer active.Add(-1)
		cancel()
		return nil, nil
	})
	if total != 0 || !errors.Is(err, context.Canceled) || active.Load() != 0 {
		t.Fatalf("count = %d, error = %v, active = %d", total, err, active.Load())
	}
}

func TestRepositoryFileCountIncludesSymlinkEntries(t *testing.T) {
	root := initTestRepo(t)
	external := t.TempDir()
	if err := os.WriteFile(filepath.Join(external, "outside.txt"), []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	for name, target := range map[string]string{"directory-link": external, "broken-link": filepath.Join(external, "missing")} {
		if err := os.Symlink(target, filepath.Join(root, name)); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
	}
	total, err := (Repository{Root: root, GitDir: filepath.Join(root, ".git")}).RepositoryFileCount(t.Context(), &ExecRunner{})
	if err != nil || total != 2 {
		t.Fatalf("count = %d, error = %v; want two links without traversing them", total, err)
	}
}

func TestStreamRepositoryCountRejectsFailedGit(t *testing.T) {
	runner := countRecordRunner(func(context.Context, string, func([]byte) error, ...string) (Result, error) {
		return Result{ExitCode: 1, Stderr: []byte("Git failed")}, nil
	})
	total, err := (Repository{Root: t.TempDir()}).streamRepositoryFileCount(t.Context(), runner, os.Lstat)
	if total != 0 || err == nil || !strings.Contains(err.Error(), "Git failed") {
		t.Fatalf("count = %d, error = %v", total, err)
	}
}
