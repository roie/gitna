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

func TestWorktreeLargeFileRequiresExplicitBudget(t *testing.T) {
	root := t.TempDir()
	repo := Repository{Root: root}
	ctx := context.Background()
	content := strings.Repeat("日本語😀\r\n", 40000)
	path := filepath.Join(root, "large.txt")
	if err := os.WriteFile(path, []byte(content), 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ReadWorktreeFile(ctx, "large.txt"); !errors.Is(err, protocol.ErrWorktreeFileTooLarge) {
		t.Fatalf("default read: %v", err)
	}
	budget := int64(len(content))
	loaded, err := repo.ReadWorktreeFile(ctx, "large.txt", budget)
	if err != nil || loaded.Content != content {
		t.Fatalf("approved read: %v", err)
	}
	edited := content + "end😀"
	if _, err := repo.WriteWorktreeFile(ctx, "large.txt", edited, loaded.Hash); !errors.Is(err, protocol.ErrWorktreeFileTooLarge) {
		t.Fatalf("default write: %v", err)
	}
	saved, err := repo.WriteWorktreeFile(ctx, "large.txt", edited, loaded.Hash, int64(len(edited)))
	if err != nil || saved.Content != edited {
		t.Fatalf("approved write: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != edited {
		t.Fatalf("disk bytes: %v", err)
	}
	if _, err := repo.WriteWorktreeFile(ctx, "large.txt", content, loaded.Hash, int64(len(edited))); !errors.Is(err, protocol.ErrWorktreeConflict) {
		t.Fatalf("stale write: %v", err)
	}
	if _, err := repo.CreateWorktreeFile(ctx, "recovered.txt", edited, int64(len(edited))); err != nil {
		t.Fatalf("recovered create: %v", err)
	}
}

func TestLargeFileBudgetDoesNotBypassValidation(t *testing.T) {
	root := t.TempDir()
	repo := Repository{Root: root}
	ctx := context.Background()
	budget := int64(DefaultDiffBytes + 100)
	for _, test := range []struct {
		name, content string
		want          error
	}{
		{"binary.txt", "\x00" + strings.Repeat("x", DefaultDiffBytes), protocol.ErrWorktreeBinary},
		{"encoding.txt", strings.Repeat("x", DefaultDiffBytes) + "\xff", protocol.ErrWorktreeEncoding},
	} {
		if err := os.WriteFile(filepath.Join(root, test.name), []byte(test.content), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.ReadWorktreeFile(ctx, test.name, budget); !errors.Is(err, test.want) {
			t.Fatalf("%s: %v", test.name, err)
		}
	}
	if _, err := repo.ReadWorktreeFile(ctx, "../secret", budget); !errors.Is(err, protocol.ErrInvalidPath) {
		t.Fatalf("traversal: %v", err)
	}
}
