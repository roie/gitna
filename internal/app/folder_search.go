package app

import (
	"container/heap"
	"context"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/roie/gitna/internal/folder"
	"github.com/roie/gitna/internal/protocol"
)

type indexedFolderFile struct {
	path       string
	name       string
	parent     string
	normalized string
}

type folderSearchIndex struct {
	mu       sync.RWMutex
	rootKey  string
	entries  []indexedFolderFile
	names    map[string]int
	complete bool
	building bool
	err      error
	cancel   context.CancelFunc
}

func (a *repoAdapter) invalidateFileSearch() {
	a.search.mu.Lock()
	if a.search.cancel != nil {
		a.search.cancel()
	}
	a.search.rootKey = ""
	a.search.entries = nil
	a.search.names = nil
	a.search.complete = false
	a.search.building = false
	a.search.err = nil
	a.search.cancel = nil
	a.search.mu.Unlock()
}

func (a *repoAdapter) startFileSearchIndex() {
	repo := a.current()
	if repo.IsGit() {
		return
	}
	rootKey := folder.PathKey(repo.Root)
	a.search.mu.Lock()
	if a.search.rootKey == rootKey && (a.search.building || a.search.complete) {
		a.search.mu.Unlock()
		return
	}
	if a.search.cancel != nil {
		a.search.cancel()
	}
	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	buildCtx, cancel := context.WithCancel(ctx)
	a.search.rootKey = rootKey
	a.search.entries = nil
	a.search.names = make(map[string]int)
	a.search.complete = false
	a.search.building = true
	a.search.err = nil
	a.search.cancel = cancel
	a.search.mu.Unlock()

	go func() {
		entries := make([]indexedFolderFile, 0, 4096)
		publish := func(final bool) {
			if len(entries) == 0 && !final {
				return
			}
			a.search.mu.Lock()
			defer a.search.mu.Unlock()
			if a.search.rootKey != rootKey || buildCtx.Err() != nil {
				return
			}
			for _, entry := range entries {
				a.search.entries = append(a.search.entries, entry)
				a.search.names[strings.ToLower(entry.name)]++
			}
			entries = entries[:0]
			if final {
				sort.Slice(a.search.entries, func(left, right int) bool {
					return a.search.entries[left].path < a.search.entries[right].path
				})
				a.search.complete = true
				a.search.building = false
				a.search.cancel = nil
			}
		}
		err := filepath.WalkDir(repo.Root, func(path string, entry fs.DirEntry, walkErr error) error {
			if err := buildCtx.Err(); err != nil {
				return err
			}
			if walkErr != nil {
				return walkErr
			}
			if path == repo.Root {
				return nil
			}
			if entry.Name() == ".git" && entry.IsDir() {
				return filepath.SkipDir
			}
			if entry.IsDir() {
				return nil
			}
			relative, err := filepath.Rel(repo.Root, path)
			if err != nil {
				return nil
			}
			relative = filepath.ToSlash(relative)
			name := entry.Name()
			parent := strings.TrimSuffix(relative, "/"+name)
			entries = append(entries, indexedFolderFile{
				path: relative, name: name, parent: parent, normalized: strings.ToLower(relative),
			})
			if len(entries) >= 4096 {
				publish(false)
			}
			return nil
		})
		if err == nil && buildCtx.Err() == nil {
			publish(true)
			return
		}
		a.search.mu.Lock()
		if a.search.rootKey == rootKey {
			a.search.building = false
			a.search.err = err
			a.search.cancel = nil
		}
		a.search.mu.Unlock()
	}()
}

func (a *repoAdapter) searchFiles(ctx context.Context, query string, limit int) (protocol.FileSearchResults, error) {
	if limit <= 0 {
		return protocol.FileSearchResults{Results: make([]protocol.FileSearchResult, 0)}, nil
	}
	a.startFileSearchIndex()
	normalizedQuery := strings.ToLower(strings.TrimSpace(query))
	a.search.mu.RLock()
	defer a.search.mu.RUnlock()
	if a.search.err != nil {
		return protocol.FileSearchResults{}, a.search.err
	}
	matches := make(folderSearchHeap, 0, limit)
	heap.Init(&matches)
	for index, entry := range a.search.entries {
		if index%1024 == 0 {
			if err := ctx.Err(); err != nil {
				return protocol.FileSearchResults{}, err
			}
		}
		score, ok := folderPathScore(entry.normalized, strings.ToLower(entry.name), normalizedQuery)
		if !ok {
			continue
		}
		candidate := scoredFolderFile{entry: entry, score: score}
		if matches.Len() < limit {
			heap.Push(&matches, candidate)
		} else if candidate.betterThan(matches[0]) {
			matches[0] = candidate
			heap.Fix(&matches, 0)
		}
	}
	ordered := make([]scoredFolderFile, len(matches))
	copy(ordered, matches)
	sort.Slice(ordered, func(left, right int) bool { return ordered[left].betterThan(ordered[right]) })
	results := make([]protocol.FileSearchResult, 0, len(ordered))
	for _, match := range ordered {
		results = append(results, protocol.FileSearchResult{
			Path: match.entry.path, Name: match.entry.name, Parent: match.entry.parent,
			DuplicateName: a.search.names[strings.ToLower(match.entry.name)] > 1,
		})
	}
	return protocol.FileSearchResults{Results: results, Complete: a.search.complete}, nil
}

type scoredFolderFile struct {
	entry indexedFolderFile
	score int
}

func (file scoredFolderFile) betterThan(other scoredFolderFile) bool {
	return file.score < other.score || (file.score == other.score && file.entry.path < other.entry.path)
}

type folderSearchHeap []scoredFolderFile

func (values folderSearchHeap) Len() int { return len(values) }
func (values folderSearchHeap) Less(left, right int) bool {
	return values[right].betterThan(values[left])
}
func (values folderSearchHeap) Swap(left, right int) {
	values[left], values[right] = values[right], values[left]
}
func (values *folderSearchHeap) Push(value any) { *values = append(*values, value.(scoredFolderFile)) }
func (values *folderSearchHeap) Pop() any {
	items := *values
	last := len(items) - 1
	value := items[last]
	*values = items[:last]
	return value
}

func folderPathScore(path, name, query string) (int, bool) {
	if query == "" {
		return 400, true
	}
	terms := strings.Fields(query)
	if len(terms) > 1 {
		total := 90
		for _, term := range terms {
			score, ok := folderPathScore(path, name, term)
			if !ok {
				return 0, false
			}
			total += score
		}
		return total, true
	}
	if name == query {
		return 0, true
	}
	if path == query {
		return 1, true
	}
	if strings.HasPrefix(name, query) {
		return 20 + len(name) - len(query), true
	}
	if strings.HasPrefix(path, query) {
		return 40 + len(path) - len(query), true
	}
	if index := strings.Index(name, query); index >= 0 {
		return 60 + index, true
	}
	if index := strings.Index(path, query); index >= 0 {
		return 80 + index, true
	}
	score, ok := folderFuzzyScore(path, query)
	if !ok {
		return 0, false
	}
	return 120 + score, true
}

func folderFuzzyScore(value, query string) (int, bool) {
	position, gap, run, bestRun := -1, 0, 0, 0
	for _, character := range query {
		nextRelative := strings.IndexRune(value[position+1:], character)
		if nextRelative < 0 {
			return 0, false
		}
		next := position + 1 + nextRelative
		if next == position+1 {
			run++
		} else {
			gap += next - position - 1
			run = 1
		}
		if run > bestRun {
			bestRun = run
		}
		position = next
	}
	return gap + position - bestRun*2, true
}
