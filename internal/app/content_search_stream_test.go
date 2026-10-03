package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
)

func TestContentSearchPublishesBeforeScanEnds(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"a.txt", "b.txt", "c.txt", "d.txt", "e.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("needle\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	adapter := &repoAdapter{ctx: ctx, repo: gitx.Repository{Root: root}, queue: gitx.NewMutationQueue()}
	waitForFolderSearch(t, adapter, "", nil, 100)
	stream, ok := any(adapter).(interface {
		SearchContentStream(context.Context, string, bool, bool, bool, bool, string, string, int, func(protocol.ContentSearchFile) error) (protocol.ContentSearchResults, error)
	})
	if !ok {
		t.Fatal("content search cannot publish results before the scan finishes")
	}
	called := 0
	sentinel := errors.New("consumer stopped")
	_, err := stream.SearchContentStream(ctx, "needle", false, false, false, false, "", "", 100, func(file protocol.ContentSearchFile) error {
		called++
		if file.Path != "a.txt" || len(file.Matches) != 1 {
			t.Fatalf("first result = %#v", file)
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) || called != 1 {
		t.Fatalf("callback drain: calls=%d err=%v", called, err)
	}
}
