package app

import (
	"bufio"
	"container/heap"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/roie/gitna/internal/folder"
	"github.com/roie/gitna/internal/protocol"
)

type indexedFolderFile struct {
	path   string
	name   string
	parent string
}

type folderSearchIndex struct {
	mu            sync.RWMutex
	rootKey       string
	path          string
	publishedSize int64
	complete      bool
	building      bool
	err           error
	cancel        context.CancelFunc
	readers       int
	retiredPaths  []string
}

func (a *repoAdapter) invalidateFileSearch() {
	a.directories.invalidate()
	a.search.mu.Lock()
	if a.search.cancel != nil {
		a.search.cancel()
	}
	indexPath := a.search.path
	building := a.search.building
	removeNow := indexPath != "" && !building && a.search.readers == 0
	if indexPath != "" && !building && a.search.readers != 0 {
		a.search.retiredPaths = append(a.search.retiredPaths, indexPath)
	}
	a.search.rootKey = ""
	a.search.path = ""
	a.search.publishedSize = 0
	a.search.complete = false
	a.search.building = false
	a.search.err = nil
	a.search.cancel = nil
	a.search.mu.Unlock()
	if removeNow {
		_ = os.Remove(indexPath)
	}
}

func (a *repoAdapter) releaseFileSearchReader() {
	a.search.mu.Lock()
	if a.search.readers > 0 {
		a.search.readers--
	}
	var retired []string
	if a.search.readers == 0 && len(a.search.retiredPaths) > 0 {
		retired = a.search.retiredPaths
		a.search.retiredPaths = nil
	}
	a.search.mu.Unlock()
	for _, path := range retired {
		_ = os.Remove(path)
	}
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
	file, err := os.CreateTemp("", "gitna-folder-search-*")
	if err != nil {
		a.search.rootKey = rootKey
		a.search.path = ""
		a.search.complete = false
		a.search.building = false
		a.search.err = err
		a.search.cancel = nil
		a.search.mu.Unlock()
		return
	}
	indexPath := file.Name()
	a.search.rootKey = rootKey
	a.search.path = indexPath
	a.search.publishedSize = 0
	a.search.complete = false
	a.search.building = true
	a.search.err = nil
	a.search.cancel = cancel
	a.search.mu.Unlock()

	go func() {
		writer := bufio.NewWriterSize(file, 256*1024)
		encoder := json.NewEncoder(writer)
		pending := 0
		publish := func() error {
			if err := writer.Flush(); err != nil {
				return err
			}
			offset, err := file.Seek(0, io.SeekCurrent)
			if err != nil {
				return err
			}
			a.search.mu.Lock()
			if a.search.rootKey == rootKey && a.search.path == indexPath && buildCtx.Err() == nil {
				a.search.publishedSize = offset
			}
			a.search.mu.Unlock()
			pending = 0
			return nil
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
			if err := encoder.Encode(filepath.ToSlash(relative)); err != nil {
				return err
			}
			pending++
			if pending >= 4096 {
				return publish()
			}
			return nil
		})
		if err == nil && buildCtx.Err() == nil && pending > 0 {
			err = publish()
		}
		closeErr := file.Close()
		if err == nil {
			err = closeErr
		}
		a.search.mu.Lock()
		stale := a.search.rootKey != rootKey || a.search.path != indexPath
		if !stale {
			a.search.building = false
			a.search.cancel = nil
			if err == nil && buildCtx.Err() == nil {
				a.search.complete = true
			} else {
				a.search.err = err
			}
		}
		a.search.mu.Unlock()
		if stale || buildCtx.Err() != nil {
			_ = os.Remove(indexPath)
		}
	}()
}

func (a *repoAdapter) searchFiles(
	ctx context.Context,
	query string,
	recentPaths []string,
	limit int,
) (protocol.FileSearchResults, error) {
	if limit <= 0 {
		return protocol.FileSearchResults{Results: make([]protocol.FileSearchResult, 0)}, nil
	}
	a.startFileSearchIndex()
	normalizedQuery := strings.ToLower(strings.TrimSpace(query))
	a.search.mu.Lock()
	if a.search.err != nil {
		err := a.search.err
		a.search.mu.Unlock()
		return protocol.FileSearchResults{}, err
	}
	indexPath := a.search.path
	publishedSize := a.search.publishedSize
	complete := a.search.complete
	a.search.readers++
	a.search.mu.Unlock()
	defer a.releaseFileSearchReader()
	if indexPath == "" || publishedSize == 0 {
		return protocol.FileSearchResults{Results: make([]protocol.FileSearchResult, 0), Complete: complete}, nil
	}
	recency := make(map[string]int, len(recentPaths))
	for index, path := range recentPaths {
		recency[path] = index + 1
	}
	matches := make(folderSearchHeap, 0, limit)
	heap.Init(&matches)
	err := scanFolderSearchIndex(ctx, indexPath, publishedSize, func(filePath string) {
		name := filepath.Base(filepath.FromSlash(filePath))
		score, ok := folderPathScore(strings.ToLower(filePath), strings.ToLower(name), normalizedQuery)
		if !ok {
			return
		}
		parent := strings.TrimSuffix(filePath, "/"+name)
		candidate := scoredFolderFile{
			entry: indexedFolderFile{path: filePath, name: name, parent: parent},
			score: score - min(recency[filePath], 10),
		}
		if matches.Len() < limit {
			heap.Push(&matches, candidate)
		} else if candidate.betterThan(matches[0]) {
			matches[0] = candidate
			heap.Fix(&matches, 0)
		}
	})
	if err != nil {
		return protocol.FileSearchResults{}, err
	}
	ordered := make([]scoredFolderFile, len(matches))
	copy(ordered, matches)
	sort.Slice(ordered, func(left, right int) bool { return ordered[left].betterThan(ordered[right]) })
	candidateNames := make(map[string]int, len(ordered))
	for _, match := range ordered {
		candidateNames[strings.ToLower(match.entry.name)] = 0
	}
	if len(candidateNames) > 0 {
		if err := scanFolderSearchIndex(ctx, indexPath, publishedSize, func(filePath string) {
			name := strings.ToLower(filepath.Base(filepath.FromSlash(filePath)))
			if _, ok := candidateNames[name]; ok {
				candidateNames[name]++
			}
		}); err != nil {
			return protocol.FileSearchResults{}, err
		}
	}
	results := make([]protocol.FileSearchResult, 0, len(ordered))
	for _, match := range ordered {
		results = append(results, protocol.FileSearchResult{
			Path: match.entry.path, Name: match.entry.name, Parent: match.entry.parent,
			DuplicateName: candidateNames[strings.ToLower(match.entry.name)] > 1,
		})
	}
	return protocol.FileSearchResults{Results: results, Complete: complete}, nil
}

func scanFolderSearchIndex(
	ctx context.Context,
	indexPath string,
	publishedSize int64,
	visit func(string),
) error {
	file, err := os.Open(indexPath)
	if err != nil {
		return err
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, publishedSize))
	for index := 0; ; index++ {
		if index%1024 == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		var filePath string
		if err := decoder.Decode(&filePath); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		visit(filePath)
	}
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
