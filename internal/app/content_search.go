package app

import (
	"bufio"
	"context"
	"errors"
	"os"
	pathpkg "path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"github.com/roie/gitna/internal/protocol"
)

const (
	contentSearchFileLimit    = 512 << 10
	contentSearchLineLimit    = 64 << 10
	contentSearchMatchLimit   = 2000
	contentSearchExcerptLimit = 512
)

func (a *repoAdapter) SearchContent(ctx context.Context, query string, caseSensitive, includeIgnored, useRegex, wholeWord bool, include, exclude string, limit int) (protocol.ContentSearchResults, error) {
	return a.searchContent(ctx, query, caseSensitive, includeIgnored, useRegex, wholeWord, include, exclude, limit, nil)
}

func (a *repoAdapter) SearchContentStream(ctx context.Context, query string, caseSensitive, includeIgnored, useRegex, wholeWord bool, include, exclude string, limit int, emit func(protocol.ContentSearchFile) error) (protocol.ContentSearchResults, error) {
	return a.searchContent(ctx, query, caseSensitive, includeIgnored, useRegex, wholeWord, include, exclude, limit, emit)
}

func (a *repoAdapter) searchContent(ctx context.Context, query string, caseSensitive, includeIgnored, useRegex, wholeWord bool, include, exclude string, limit int, emit func(protocol.ContentSearchFile) error) (protocol.ContentSearchResults, error) {
	if query == "" {
		return protocol.ContentSearchResults{Results: []protocol.ContentSearchFile{}, Complete: true}, nil
	}
	if limit <= 0 || limit > contentSearchMatchLimit {
		limit = contentSearchMatchLimit
	}
	// ASCII literals can cheaply reject ASCII lines before Unicode-aware matching.
	// Non-ASCII lines still use regexp's SimpleFold semantics (for example ſ/s).
	foldedLiteral := ""
	if !useRegex && !caseSensitive && isASCII(query) {
		foldedLiteral = strings.ToLower(query)
	}
	pattern := query
	if !useRegex {
		pattern = regexp.QuoteMeta(pattern)
	}
	if !caseSensitive {
		pattern = `(?i)` + pattern
	}
	expression, err := regexp.Compile(pattern)
	if err != nil {
		return protocol.ContentSearchResults{}, err
	}
	a.startFileSearchIndex()
	a.search.mu.Lock()
	indexPath, publishedSize, complete := a.search.path, a.search.publishedSize, a.search.complete
	a.search.readers++
	a.search.mu.Unlock()
	defer a.releaseFileSearchReader()
	if indexPath == "" || publishedSize == 0 {
		return protocol.ContentSearchResults{Results: []protocol.ContentSearchFile{}, Complete: complete}, nil
	}
	repo := a.current()
	root, err := os.OpenRoot(repo.Root)
	if err != nil {
		return protocol.ContentSearchResults{}, err
	}
	defer root.Close()
	include = strings.TrimSpace(include)
	exclude = strings.TrimSpace(exclude)
	scanFile := func(path string, reader *bufio.Reader) ([]protocol.ContentSearchMatch, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		local, err := filepath.Localize(path)
		if err != nil {
			return nil, nil
		}
		file, err := root.Open(local)
		if err != nil {
			return nil, nil
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || info.IsDir() || info.Size() > contentSearchFileLimit {
			return nil, nil
		}
		reader.Reset(file)
		lineNumber := 0
		var matches []protocol.ContentSearchMatch
		for {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			line, readErr := reader.ReadString('\n')
			lineNumber++
			line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
			if len(line) > contentSearchLineLimit {
				if readErr != nil {
					break
				}
				continue
			}
			if strings.IndexByte(line, 0) >= 0 || !utf8.ValidString(line) {
				return nil, nil
			}
			mayMatch := useRegex || !caseSensitive || strings.Contains(line, query)
			if foldedLiteral != "" && isASCII(line) {
				mayMatch = strings.Contains(strings.ToLower(line), foldedLiteral)
			}
			if mayMatch {
				for _, match := range expression.FindAllStringIndex(line, -1) {
					if wholeWord && !contentSearchWordBoundary(line, match[0], match[1]) {
						continue
					}
					matches = append(matches, contentSearchExcerpt(line, lineNumber, match[0], match[1]))
					if len(matches) >= limit {
						break
					}
				}
			}
			if len(matches) >= limit || readErr != nil {
				break
			}
		}
		return matches, nil
	}

	// Batch small-file I/O to amortize channels and worker wakeups. Eight batches
	// bound in-flight results; collecting in index order preserves the
	// matches that survive the global limit regardless of worker completion order.
	const (
		batchSize   = 32
		workerCount = 8
	)
	type fileResult struct {
		path    string
		matches []protocol.ContentSearchMatch
		err     error
	}
	type fileJob struct {
		paths []string
		reply chan []fileResult
	}
	ctx, cancel := context.WithCancel(ctx)
	jobs := make(chan fileJob, workerCount)
	var workers sync.WaitGroup
	for range workerCount {
		workers.Go(func() {
			reader := bufio.NewReaderSize(nil, 32<<10)
			for job := range jobs {
				batch := make([]fileResult, 0, len(job.paths))
				count := 0
				for _, path := range job.paths {
					matches, err := scanFile(path, reader)
					// Validate each file with the original per-file limit before
					// trimming retention to the remaining batch budget.
					matches = matches[:min(len(matches), limit-count)]
					batch = append(batch, fileResult{path: path, matches: matches, err: err})
					count += len(matches)
					if err != nil || count >= limit {
						break
					}
				}
				job.reply <- batch
			}
		})
	}
	defer func() {
		cancel()
		close(jobs)
		workers.Wait()
	}()

	results := make([]protocol.ContentSearchFile, 0, 32)
	matchCount := 0
	pending := make([]fileJob, 0, workerCount)
	collect := func() error {
		job := pending[0]
		pending = pending[1:]
		var batch []fileResult
		select {
		case batch = <-job.reply:
		case <-ctx.Done():
			return ctx.Err()
		}
		for _, result := range batch {
			if result.err != nil {
				return result.err
			}
			matches := result.matches[:min(len(result.matches), limit-matchCount)]
			if len(matches) > 0 {
				file := protocol.ContentSearchFile{Path: result.path, Matches: matches}
				results = append(results, file)
				matchCount += len(matches)
				if emit != nil {
					if err := emit(file); err != nil {
						return err
					}
				}
			}
			if matchCount >= limit {
				return errSearchLimit
			}
		}
		return nil
	}
	var paths []string
	submitted := 0
	submit := func() error {
		if len(paths) == 0 {
			return nil
		}
		job := fileJob{paths: paths, reply: make(chan []fileResult, 1)}
		select {
		case jobs <- job:
		case <-ctx.Done():
			return ctx.Err()
		}
		pending = append(pending, job)
		paths = nil
		submitted++
		if len(pending) == workerCount {
			return collect()
		}
		return nil
	}
	err = scanFolderSearchIndex(ctx, indexPath, publishedSize, func(path string, ignored bool) error {
		if ignored && !includeIgnored || !matchesSearchPath(path, include, exclude) {
			return nil
		}
		paths = append(paths, path)
		size := batchSize
		// Let the initial streaming window emit without waiting for a batch.
		if emit != nil && submitted < workerCount {
			size = 1
		}
		if len(paths) == size {
			return submit()
		}
		return nil
	})
	if err == nil {
		err = submit()
	}
	for err == nil && len(pending) > 0 {
		err = collect()
	}
	truncated := errors.Is(err, errSearchLimit)
	if err != nil && !truncated {
		return protocol.ContentSearchResults{}, err
	}
	return protocol.ContentSearchResults{Results: results, Complete: complete, Truncated: truncated}, nil
}

var errSearchLimit = errors.New("content search limit reached")

func isASCII(value string) bool {
	for i := range len(value) {
		if value[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

func contentSearchExcerpt(line string, number, begin, end int) protocol.ContentSearchMatch {
	// Keep the actual hit visible, even on long lines, without splitting UTF-8.
	start := max(0, begin-24)
	for start > 0 && !utf8.RuneStart(line[start]) {
		start--
	}
	stop := min(len(line), start+contentSearchExcerptLimit)
	for stop < len(line) && !utf8.RuneStart(line[stop]) {
		stop--
	}
	prefix, suffix := "", ""
	if start > 0 {
		prefix = "…"
	}
	if stop < len(line) {
		suffix = "…"
	}
	return protocol.ContentSearchMatch{
		Line: number, Column: utf16Length(line[:begin]), Length: utf16Length(line[begin:end]),
		Excerpt:    prefix + line[start:stop] + suffix,
		MatchStart: utf16Length(prefix + line[start:begin]),
		MatchEnd:   utf16Length(prefix + line[start:min(end, stop)]),
	}
}

func utf16Length(value string) int {
	length := 0
	for _, r := range value {
		length++
		if r > 0xffff {
			length++
		}
	}
	return length
}

func contentSearchWordBoundary(value string, begin, end int) bool {
	isWord := func(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' }
	before, after := rune(-1), rune(-1)
	for _, r := range value[:begin] {
		before = r
	}
	for _, r := range value[end:] {
		after = r
		break
	}
	return (before < 0 || !isWord(before)) && (after < 0 || !isWord(after))
}

func matchesSearchPath(path, include, exclude string) bool {
	matches := func(patterns string) bool {
		for _, pattern := range strings.Split(patterns, ",") {
			pattern = strings.TrimSpace(pattern)
			if pattern == "" {
				continue
			}
			pattern = strings.TrimPrefix(strings.TrimSuffix(pattern, "/"), "./")
			if !strings.Contains(pattern, "/") {
				pattern = "**/" + pattern
			}
			// A directory match also includes its descendants.
			for candidate := path; candidate != "."; candidate = pathpkg.Dir(candidate) {
				if searchGlobMatch(pattern, candidate) {
					return true
				}
			}
		}
		return false
	}
	return (include == "" || matches(include)) && (exclude == "" || !matches(exclude))
}

func searchGlobMatch(pattern, path string) bool {
	patterns, parts := strings.Split(pattern, "/"), strings.Split(path, "/")
	// Dynamic programming keeps repeated ** segments from causing exponential work.
	previous := make([]bool, len(parts)+1)
	previous[0] = true
	for _, segment := range patterns {
		next := make([]bool, len(parts)+1)
		if segment == "**" {
			next[0] = previous[0]
		}
		for j, part := range parts {
			if segment == "**" {
				next[j+1] = previous[j+1] || next[j]
			} else {
				matched, _ := pathpkg.Match(segment, part)
				next[j+1] = previous[j] && matched
			}
		}
		previous = next
	}
	return previous[len(parts)]
}
