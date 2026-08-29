package app

import (
	"bufio"
	"container/heap"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"sort"
	"strings"
	"sync"

	"github.com/roie/gitna/internal/folder"
	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
)

const (
	directoryIndexChunkSize  = 8_192
	directoryIndexSparseStep = 256
	directoryIndexCacheLimit = 64
)

type directoryIndexRecord struct {
	Name      string `json:"n"`
	Directory bool   `json:"d,omitempty"`
}

type directoryIndexSparseEntry struct {
	name   string
	offset int64
}

type cachedDirectoryIndex struct {
	ready       chan struct{}
	path        string
	sparse      []directoryIndexSparseEntry
	err         error
	lastUsed    uint64
	cacheID     uint64
	directory   string
	readers     int
	invalidated bool
}

type folderDirectoryIndexCache struct {
	mu      sync.Mutex
	entries map[string]*cachedDirectoryIndex
	clock   uint64
	cacheID uint64
}

func (cache *folderDirectoryIndexCache) invalidate() {
	cache.mu.Lock()
	cache.cacheID++
	entries := cache.entries
	cache.entries = nil
	for _, entry := range entries {
		if entry.path == "" {
			continue
		}
		if entry.readers == 0 {
			_ = os.Remove(entry.path)
		} else {
			entry.invalidated = true
		}
	}
	cache.mu.Unlock()
}

func (cache *folderDirectoryIndexCache) page(
	ctx context.Context,
	repo gitx.Repository,
	directory string,
	after string,
	limit int,
) (protocol.DirectoryEntries, error) {
	key := folder.PathKey(repo.Root) + "\x00" + strings.TrimSuffix(directory, "/")
	cache.mu.Lock()
	if cache.entries == nil {
		cache.entries = make(map[string]*cachedDirectoryIndex)
	}
	cache.clock++
	entry := cache.entries[key]
	if entry == nil {
		entry = &cachedDirectoryIndex{
			ready:     make(chan struct{}),
			lastUsed:  cache.clock,
			cacheID:   cache.cacheID,
			directory: strings.TrimSuffix(directory, "/"),
		}
		cache.entries[key] = entry
		go cache.build(ctx, repo, key, entry)
	} else {
		entry.lastUsed = cache.clock
	}
	cache.mu.Unlock()

	select {
	case <-ctx.Done():
		return protocol.DirectoryEntries{}, ctx.Err()
	case <-entry.ready:
	}
	cache.mu.Lock()
	if cache.entries[key] != entry {
		cache.mu.Unlock()
		return protocol.DirectoryEntries{}, context.Canceled
	}
	if entry.err != nil {
		err := entry.err
		delete(cache.entries, key)
		if entry.path != "" {
			_ = os.Remove(entry.path)
		}
		cache.mu.Unlock()
		return protocol.DirectoryEntries{}, err
	}
	entry.readers++
	cache.mu.Unlock()
	result, err := readDirectoryIndexPage(entry, after, limit)
	cache.mu.Lock()
	entry.readers--
	if entry.invalidated && entry.readers == 0 {
		_ = os.Remove(entry.path)
	}
	cache.evictLocked(nil)
	cache.mu.Unlock()
	return result, err
}

func (cache *folderDirectoryIndexCache) build(
	ctx context.Context,
	repo gitx.Repository,
	key string,
	entry *cachedDirectoryIndex,
) {
	path, sparse, err := buildDirectoryIndex(ctx, repo, entry.directory)
	cache.mu.Lock()
	if cache.cacheID != entry.cacheID || cache.entries[key] != entry {
		cache.mu.Unlock()
		if path != "" {
			_ = os.Remove(path)
		}
		entry.err = context.Canceled
		close(entry.ready)
		return
	}
	entry.path = path
	entry.sparse = sparse
	entry.err = err
	close(entry.ready)
	cache.evictLocked(entry)
	cache.mu.Unlock()
}

func (cache *folderDirectoryIndexCache) evictLocked(current *cachedDirectoryIndex) {
	for len(cache.entries) > directoryIndexCacheLimit {
		var oldestKey string
		var oldest *cachedDirectoryIndex
		for key, candidate := range cache.entries {
			if candidate == current || candidate.path == "" || candidate.readers != 0 {
				continue
			}
			if oldest == nil || candidate.lastUsed < oldest.lastUsed {
				oldestKey, oldest = key, candidate
			}
		}
		if oldest == nil {
			return
		}
		delete(cache.entries, oldestKey)
		_ = os.Remove(oldest.path)
	}
}

func buildDirectoryIndex(
	ctx context.Context,
	repo gitx.Repository,
	directory string,
) (string, []directoryIndexSparseEntry, error) {
	return buildDirectoryIndexFromScan(ctx, directory, func(visit func(string, bool) error) error {
		return repo.ScanDirectoryEntries(ctx, directory, visit)
	})
}

func buildDirectoryIndexFromScan(
	ctx context.Context,
	directory string,
	scan func(func(string, bool) error) error,
) (string, []directoryIndexSparseEntry, error) {
	chunks := make([]string, 0)
	pending := make([]directoryIndexRecord, 0, directoryIndexChunkSize)
	cleanup := func() {
		for _, chunk := range chunks {
			_ = os.Remove(chunk)
		}
	}
	defer cleanup()
	flush := func() error {
		if len(pending) == 0 {
			return nil
		}
		sort.Slice(pending, func(left, right int) bool { return pending[left].Name < pending[right].Name })
		file, err := os.CreateTemp("", "gitna-directory-chunk-*")
		if err != nil {
			return err
		}
		encoder := json.NewEncoder(file)
		for _, record := range pending {
			if err := encoder.Encode(record); err != nil {
				file.Close()
				_ = os.Remove(file.Name())
				return err
			}
		}
		if err := file.Close(); err != nil {
			_ = os.Remove(file.Name())
			return err
		}
		chunks = append(chunks, file.Name())
		pending = pending[:0]
		return nil
	}
	err := scan(func(name string, directory bool) error {
		pending = append(pending, directoryIndexRecord{Name: name, Directory: directory})
		if len(pending) == directoryIndexChunkSize {
			return flush()
		}
		return nil
	})
	if err == nil {
		err = flush()
	}
	if err != nil {
		return "", nil, err
	}

	output, err := os.CreateTemp("", "gitna-directory-index-*")
	if err != nil {
		return "", nil, err
	}
	outputPath := output.Name()
	writer := bufio.NewWriter(output)
	readers := make([]*directoryChunkReader, 0, len(chunks))
	values := make(directoryMergeHeap, 0, len(chunks))
	for _, chunk := range chunks {
		reader, openErr := openDirectoryChunk(chunk)
		if openErr != nil {
			err = openErr
			break
		}
		readers = append(readers, reader)
		if reader.next() {
			heap.Push(&values, reader)
		} else if reader.err != nil {
			err = reader.err
			break
		}
	}
	sparse := make([]directoryIndexSparseEntry, 0)
	var offset int64
	count := 0
	for err == nil && values.Len() > 0 {
		if err = ctx.Err(); err != nil {
			break
		}
		reader := heap.Pop(&values).(*directoryChunkReader)
		line, marshalErr := json.Marshal(reader.record)
		if marshalErr != nil {
			err = marshalErr
			break
		}
		line = append(line, '\n')
		if count%directoryIndexSparseStep == 0 {
			sparse = append(sparse, directoryIndexSparseEntry{name: reader.record.Name, offset: offset})
		}
		if _, err = writer.Write(line); err != nil {
			break
		}
		offset += int64(len(line))
		count++
		if reader.next() {
			heap.Push(&values, reader)
		} else if reader.err != nil {
			err = reader.err
		}
	}
	for _, reader := range readers {
		_ = reader.close()
	}
	if flushErr := writer.Flush(); err == nil {
		err = flushErr
	}
	if closeErr := output.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(outputPath)
		return "", nil, err
	}
	return outputPath, sparse, nil
}

type directoryChunkReader struct {
	file    *os.File
	decoder *json.Decoder
	record  directoryIndexRecord
	err     error
}

func openDirectoryChunk(path string) (*directoryChunkReader, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	return &directoryChunkReader{file: file, decoder: json.NewDecoder(file)}, nil
}

func (reader *directoryChunkReader) next() bool {
	reader.record = directoryIndexRecord{}
	reader.err = reader.decoder.Decode(&reader.record)
	if errors.Is(reader.err, io.EOF) {
		reader.err = nil
		return false
	}
	return reader.err == nil
}

func (reader *directoryChunkReader) close() error { return reader.file.Close() }

type directoryMergeHeap []*directoryChunkReader

func (values directoryMergeHeap) Len() int { return len(values) }
func (values directoryMergeHeap) Less(left, right int) bool {
	return values[left].record.Name < values[right].record.Name
}
func (values directoryMergeHeap) Swap(left, right int) {
	values[left], values[right] = values[right], values[left]
}
func (values *directoryMergeHeap) Push(value any) {
	*values = append(*values, value.(*directoryChunkReader))
}
func (values *directoryMergeHeap) Pop() any {
	items := *values
	last := len(items) - 1
	value := items[last]
	*values = items[:last]
	return value
}

func readDirectoryIndexPage(
	index *cachedDirectoryIndex,
	after string,
	limit int,
) (protocol.DirectoryEntries, error) {
	result := protocol.DirectoryEntries{
		Directory: index.directory,
		Entries:   make([]protocol.DirectoryEntry, 0, min(limit, 64)),
	}
	file, err := os.Open(index.path)
	if err != nil {
		return protocol.DirectoryEntries{}, err
	}
	defer file.Close()
	if after != "" && len(index.sparse) > 0 {
		position := sort.Search(len(index.sparse), func(candidate int) bool {
			return index.sparse[candidate].name > after
		})
		if position > 0 {
			position--
		}
		if _, err := file.Seek(index.sparse[position].offset, io.SeekStart); err != nil {
			return protocol.DirectoryEntries{}, err
		}
	}
	decoder := json.NewDecoder(file)
	for len(result.Entries) <= limit {
		var record directoryIndexRecord
		if err := decoder.Decode(&record); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return protocol.DirectoryEntries{}, err
		}
		if record.Name <= after {
			continue
		}
		kind := protocol.DirectoryEntryFile
		entryPath := record.Name
		if index.directory != "" {
			entryPath = index.directory + "/" + record.Name
		}
		if record.Directory {
			kind = protocol.DirectoryEntryDirectory
			entryPath += "/"
		}
		result.Entries = append(result.Entries, protocol.DirectoryEntry{
			Name: record.Name,
			Path: entryPath,
			Kind: kind,
		})
	}
	if len(result.Entries) > limit {
		result.Entries = result.Entries[:limit]
		result.Truncated = true
		result.NextCursor = result.Entries[len(result.Entries)-1].Name
	}
	return result, nil
}
