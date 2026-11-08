package gitx

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

type editorCountingRunner struct {
	Runner
	calls int
}

func (r *editorCountingRunner) Run(ctx context.Context, root string, args ...string) (Result, error) {
	r.calls++
	return r.Runner.Run(ctx, root, args...)
}

func (r *editorCountingRunner) RunInput(ctx context.Context, root string, input []byte, args ...string) (Result, error) {
	r.calls++
	return r.Runner.RunInput(ctx, root, input, args...)
}

func benchmarkEditorRepo(b *testing.B) Repository {
	b.Helper()
	root := b.TempDir()
	git := func(args ...string) {
		b.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		if output, err := cmd.CombinedOutput(); err != nil {
			b.Fatalf("git: %v: %s", err, output)
		}
	}
	git("init", "-q")
	git("config", "user.name", "Fixture")
	git("config", "user.email", "fixture@example.invalid")
	var text strings.Builder
	for i := range 10000 {
		fmt.Fprintf(&text, "line %05d content\n", i)
	}
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte(text.String()), 0o600); err != nil {
		b.Fatal(err)
	}
	git("add", "file.txt")
	git("commit", "-qm", "fixture")
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte(strings.Replace(text.String(), "line 05000", "line EDITED", 1)), 0o600); err != nil {
		b.Fatal(err)
	}
	return Repository{Root: root, GitDir: filepath.Join(root, ".git")}
}

func BenchmarkEditorReads(b *testing.B) {
	repo := benchmarkEditorRepo(b)
	for _, name := range []string{"diff", "baseline-cold", "baseline-warm", "blame"} {
		b.Run(name, func(b *testing.B) {
			runner := &editorCountingRunner{Runner: &ExecRunner{}}
			var cache IndexBaselineCache
			if _, err := cache.Read(b.Context(), repo, runner, "file.txt"); err != nil {
				b.Fatal(err)
			}
			runner.calls = 0
			for b.Loop() {
				var err error
				if name == "diff" {
					_, err = repo.Diff(b.Context(), runner, protocol.DiffUnstaged, protocol.DiffOptions{Path: "file.txt"})
				} else if name == "baseline-cold" {
					_, err = repo.IndexBaseline(b.Context(), runner, "file.txt")
				} else if name == "baseline-warm" {
					_, err = cache.Read(b.Context(), repo, runner, "file.txt")
				} else {
					_, err = repo.FileBlame(b.Context(), runner, "file.txt")
				}
				if err != nil {
					b.Fatal(err)
				}
			}
			b.ReportMetric(float64(runner.calls)/float64(b.N), "git/op")
		})
	}
}
