package app

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/roie/gitna/internal/filesearch"
	"github.com/roie/gitna/internal/folder"
	"github.com/roie/gitna/internal/protocol"
)

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
	catalog       filesearch.Snapshot
	memoryLimit   int64
}

// retirePathLocked defers removal while any index reader may still have the
// file open. Readers are tracked conservatively across index generations so
// replacement remains safe on platforms that cannot unlink open files.
func (index *folderSearchIndex) retirePathLocked(path string) string {
	if path == "" {
		return ""
	}
	for _, retired := range index.retiredPaths {
		if retired == path {
			return ""
		}
	}
	if index.readers > 0 {
		index.retiredPaths = append(index.retiredPaths, path)
		return ""
	}
	return path
}

func folderSearchWalkError(root, path string, walkErr error) error {
	if walkErr == nil {
		return nil
	}
	if filepath.Clean(path) == filepath.Clean(root) {
		return walkErr
	}
	// A descendant can disappear or become unreadable between directory reads.
	// Skip that entry while retaining the rest of the progressively built index.
	return nil
}

func walkFolderSearchPaths(
	ctx context.Context,
	root string,
	visit func(string) error,
	publishRoot func() error,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	projectRoots := make([]string, 0, len(entries))
	dependencyRoots := make([]string, 0, 1)
	emit := func(path string) error {
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		return visit(filepath.ToSlash(relative))
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.Name() == ".git" {
			continue
		}
		entryPath := filepath.Join(root, entry.Name())
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if !info.IsDir() {
			if err := emit(entryPath); err != nil {
				return err
			}
			continue
		}
		if strings.EqualFold(entry.Name(), "node_modules") {
			dependencyRoots = append(dependencyRoots, entryPath)
		} else {
			projectRoots = append(projectRoots, entryPath)
		}
	}
	if err := publishRoot(); err != nil {
		return err
	}

	for _, projectRoot := range projectRoots {
		err := filepath.WalkDir(projectRoot, func(path string, entry fs.DirEntry, walkErr error) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := folderSearchWalkError(root, path, walkErr); err != nil {
				return err
			}
			if walkErr != nil {
				return nil
			}
			if path == projectRoot {
				return nil
			}
			if entry.IsDir() {
				if entry.Name() == ".git" {
					return filepath.SkipDir
				}
				if strings.EqualFold(entry.Name(), "node_modules") {
					dependencyRoots = append(dependencyRoots, path)
					return filepath.SkipDir
				}
				return nil
			}
			return emit(path)
		})
		if err != nil {
			return err
		}
	}

	for _, dependencyRoot := range dependencyRoots {
		err := filepath.WalkDir(dependencyRoot, func(path string, entry fs.DirEntry, walkErr error) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := folderSearchWalkError(root, path, walkErr); err != nil {
				return err
			}
			if walkErr != nil || path == dependencyRoot {
				return nil
			}
			if entry.Name() == ".git" {
				if entry.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if entry.IsDir() {
				return nil
			}
			return emit(path)
		})
		if err != nil {
			return err
		}
	}
	return nil
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
	a.search.catalog = filesearch.Snapshot{}
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
	rootKey := folder.PathKey(repo.Root)
	a.search.mu.Lock()
	if a.search.rootKey == rootKey && (a.search.building || a.search.complete) {
		a.search.mu.Unlock()
		return
	}
	if a.search.cancel != nil {
		a.search.cancel()
	}
	file, err := os.CreateTemp("", "gitna-folder-search-*")
	if err != nil {
		removePath := a.search.retirePathLocked(a.search.path)
		a.search.rootKey = rootKey
		a.search.path = ""
		a.search.complete = false
		a.search.building = false
		a.search.err = err
		a.search.cancel = nil
		a.search.catalog = filesearch.Snapshot{}
		a.search.mu.Unlock()
		if removePath != "" {
			_ = os.Remove(removePath)
		}
		return
	}
	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	buildCtx, cancel := context.WithCancel(ctx)
	indexPath := file.Name()
	removePath := a.search.retirePathLocked(a.search.path)
	a.search.rootKey = rootKey
	a.search.path = indexPath
	a.search.publishedSize = 0
	a.search.complete = false
	a.search.building = true
	a.search.err = nil
	a.search.cancel = cancel
	a.search.catalog = filesearch.Snapshot{}
	memoryLimit := a.search.memoryLimit
	a.search.mu.Unlock()
	if removePath != "" {
		_ = os.Remove(removePath)
	}

	go func() {
		defer cancel()
		writer := bufio.NewWriterSize(file, 256*1024)
		encoder := json.NewEncoder(writer)
		catalog := filesearch.NewBuilder(memoryLimit)
		pending := 0
		publish := func() error {
			if err := writer.Flush(); err != nil {
				return err
			}
			offset, err := file.Seek(0, io.SeekCurrent)
			if err != nil {
				return err
			}
			snapshot := catalog.Snapshot(false)
			a.search.mu.Lock()
			if a.search.rootKey == rootKey && a.search.path == indexPath && buildCtx.Err() == nil {
				a.search.publishedSize = offset
				a.search.catalog = snapshot
			}
			a.search.mu.Unlock()
			pending = 0
			return nil
		}
		err := walkFolderSearchPaths(buildCtx, repo.Root, func(relativePath string) error {
			if err := encoder.Encode(relativePath); err != nil {
				return err
			}
			catalog.Add(relativePath)
			pending++
			if pending >= 4096 {
				return publish()
			}
			return nil
		}, func() error {
			if pending == 0 {
				return nil
			}
			return publish()
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
		removePath := ""
		if !stale {
			a.search.building = false
			a.search.cancel = nil
			if err == nil && buildCtx.Err() == nil {
				a.search.complete = true
				a.search.catalog = catalog.Snapshot(true)
			} else {
				a.search.err = err
			}
		}
		if stale || buildCtx.Err() != nil {
			removePath = a.search.retirePathLocked(indexPath)
		}
		a.search.mu.Unlock()
		if removePath != "" {
			_ = os.Remove(removePath)
		}
	}()
}

func validRecentSearchPaths(rootPath string, recentPaths []string, limit int) []string {
	if limit <= 0 || len(recentPaths) == 0 {
		return nil
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return nil
	}
	defer root.Close()

	valid := make([]string, 0, min(limit, len(recentPaths)))
	seen := make(map[string]struct{}, cap(valid))
	for index, checked := len(recentPaths)-1, 0; index >= 0 && checked < limit; index, checked = index-1, checked+1 {
		normalized, ok := filesearch.NormalizeRecentPath(recentPaths[index])
		if !ok {
			continue
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		localPath, err := filepath.Localize(normalized)
		if err != nil {
			continue
		}
		info, err := root.Stat(localPath)
		if err != nil || info.IsDir() {
			continue
		}
		seen[normalized] = struct{}{}
		valid = append(valid, normalized)
	}
	for left, right := 0, len(valid)-1; left < right; left, right = left+1, right-1 {
		valid[left], valid[right] = valid[right], valid[left]
	}
	return valid
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
	repo := a.current()
	a.startFileSearchIndex()
	a.search.mu.Lock()
	if a.search.err != nil {
		err := a.search.err
		a.search.mu.Unlock()
		return protocol.FileSearchResults{}, err
	}
	indexPath := a.search.path
	publishedSize := a.search.publishedSize
	complete := a.search.complete
	catalog := a.search.catalog
	a.search.readers++
	a.search.mu.Unlock()
	defer a.releaseFileSearchReader()
	emptyQuery := strings.TrimSpace(query) == ""
	if emptyQuery {
		recentPaths = validRecentSearchPaths(repo.Root, recentPaths, limit)
	}
	if emptyQuery || (catalog.Len() > 0 && !catalog.Overflow()) {
		matches, err := catalog.Search(ctx, query, recentPaths, limit)
		if err != nil {
			return protocol.FileSearchResults{}, err
		}
		results := make([]protocol.FileSearchResult, len(matches))
		for index, match := range matches {
			results[index] = protocol.FileSearchResult{
				Path: match.Path, Name: match.Name, Parent: match.Parent,
				DuplicateName: match.DuplicateName,
			}
		}
		return protocol.FileSearchResults{Results: results, Complete: complete}, nil
	}
	if indexPath == "" || publishedSize == 0 {
		return protocol.FileSearchResults{Results: make([]protocol.FileSearchResult, 0), Complete: complete}, nil
	}
	matches, err := filesearch.RankPaths(ctx, query, recentPaths, limit, func(visit func(string) error) error {
		return scanFolderSearchIndex(ctx, indexPath, publishedSize, visit)
	})
	if err != nil {
		return protocol.FileSearchResults{}, err
	}
	results := make([]protocol.FileSearchResult, len(matches))
	for index, match := range matches {
		results[index] = protocol.FileSearchResult{
			Path: match.Path, Name: match.Name, Parent: match.Parent,
			DuplicateName: match.DuplicateName,
		}
	}
	return protocol.FileSearchResults{Results: results, Complete: complete}, nil
}

func scanFolderSearchIndex(
	ctx context.Context,
	indexPath string,
	publishedSize int64,
	visit func(string) error,
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
		if err := visit(filePath); err != nil {
			return err
		}
	}
}
