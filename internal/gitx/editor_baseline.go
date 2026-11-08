package gitx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/roie/gitna/internal/protocol"
)

type IndexBaselineCache struct {
	mu       sync.Mutex
	entries  map[string]indexBaselineEntry
	revision uint64
	gitDir   string
	index    os.FileInfo
}

func (c *IndexBaselineCache) Revision(repo Repository) (uint64, error) {
	index, err := os.Stat(filepath.Join(repo.GitDir, "index"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return 0, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.revision == 0 || c.gitDir != repo.GitDir || !sameIndex(c.index, index) {
		c.revision++
		c.gitDir = repo.GitDir
		c.index = index
	}
	return c.revision, nil
}

type indexBaselineEntry struct {
	index    os.FileInfo
	baseline protocol.EditorBaseline
}

func (c *IndexBaselineCache) Read(ctx context.Context, repo Repository, runner Runner, path string, budget ...int64) (protocol.EditorBaseline, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return protocol.EditorBaseline{}, err
	}
	index, err := os.Stat(filepath.Join(repo.GitDir, "index"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return protocol.EditorBaseline{}, err
	}
	key := repo.GitDir + "\x00" + path + "\x00" + strconv.FormatInt(worktreeContentLimit(budget), 10)
	entry, found := c.entries[key]
	if found && sameIndex(entry.index, index) {
		return entry.baseline, nil
	}
	oid, err := repo.indexEntryOID(ctx, runner, path)
	if err != nil {
		return protocol.EditorBaseline{}, err
	}
	baseline := entry.baseline
	if !found || baseline.OID != oid {
		baseline, err = repo.indexBaselineBlob(ctx, runner, path, oid, worktreeContentLimit(budget))
		if err != nil {
			return protocol.EditorBaseline{}, err
		}
	}
	if len(c.entries) >= 8 {
		clear(c.entries)
	}
	if c.entries == nil {
		c.entries = make(map[string]indexBaselineEntry)
	}
	c.entries[key] = indexBaselineEntry{index: index, baseline: baseline}
	return baseline, nil
}

func sameIndex(a, b os.FileInfo) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return os.SameFile(a, b) && a.Size() == b.Size() && a.ModTime() == b.ModTime()
}

func (r Repository) IndexBaseline(ctx context.Context, runner Runner, path string, budget ...int64) (protocol.EditorBaseline, error) {
	oid, err := r.indexEntryOID(ctx, runner, path)
	if err != nil {
		return protocol.EditorBaseline{}, err
	}
	return r.indexBaselineBlob(ctx, runner, path, oid, worktreeContentLimit(budget))
}

func (r Repository) indexEntryOID(ctx context.Context, runner Runner, path string) (string, error) {
	if err := validatePath(path); err != nil {
		return "", err
	}
	if !r.IsGit() {
		return "", ErrNotRepository
	}
	result, err := runner.Run(ctx, r.Root, "--literal-pathspecs", "ls-files", "--stage", "-z", "--", path)
	if err != nil {
		return "", err
	}
	if result.ExitCode != 0 {
		return "", opError("index baseline", result)
	}
	for record := range bytes.SplitSeq(result.Stdout, []byte{0}) {
		header, name, ok := bytes.Cut(record, []byte{'\t'})
		if !ok || string(name) != path {
			continue
		}
		fields := strings.Fields(string(header))
		if len(fields) != 3 {
			return "", fmt.Errorf("gitx: malformed index entry")
		}
		if fields[2] == "0" && (fields[0] == "100644" || fields[0] == "100755") {
			return fields[1], nil
		}
	}
	return "", nil
}

func (r Repository) indexBaselineBlob(ctx context.Context, runner Runner, path, oid string, limit int64) (protocol.EditorBaseline, error) {
	baseline := protocol.EditorBaseline{Path: path, OID: oid}
	if oid == "" {
		return baseline, nil
	}
	size, present, err := r.blobInfo(ctx, runner, oid)
	if err != nil {
		return baseline, err
	}
	if !present {
		return baseline, fmt.Errorf("gitx: missing indexed blob %s", oid)
	}
	baseline.Present = true
	if size > limit {
		baseline.TooLarge = true
		return baseline, nil
	}
	result, err := runner.Run(ctx, r.Root, "cat-file", "blob", oid)
	if err != nil {
		return baseline, err
	}
	if result.ExitCode != 0 {
		return baseline, opError("read index baseline", result)
	}
	if int64(len(result.Stdout)) != size {
		return baseline, fmt.Errorf("gitx: incomplete index blob")
	}
	baseline.Binary = isBinary(result.Stdout)
	if !baseline.Binary {
		baseline.Content = string(result.Stdout)
	}
	return baseline, nil
}

func (r Repository) blobInfo(ctx context.Context, runner Runner, expression string) (int64, bool, error) {
	result, err := runner.RunInput(ctx, r.Root, append([]byte(expression), 0), "cat-file", "--batch-check", "-z")
	if err != nil {
		return 0, false, err
	}
	if result.ExitCode != 0 {
		return 0, false, opError("inspect blob", result)
	}
	if bytes.Equal(result.Stdout, []byte(expression+" missing\n")) {
		return 0, false, nil
	}
	fields := strings.Fields(string(result.Stdout))
	if len(fields) != 3 || fields[1] != "blob" {
		return 0, false, fmt.Errorf("gitx: invalid blob metadata %q", result.Stdout)
	}
	size, err := strconv.ParseInt(fields[2], 10, 64)
	if err != nil || size < 0 {
		return 0, false, fmt.Errorf("gitx: invalid blob size")
	}
	return size, true, nil
}
