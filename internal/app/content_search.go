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
	if query == "" {
		return protocol.ContentSearchResults{Results: []protocol.ContentSearchFile{}, Complete: true}, nil
	}
	if limit <= 0 || limit > contentSearchMatchLimit {
		limit = contentSearchMatchLimit
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
	results := make([]protocol.ContentSearchFile, 0, 32)
	matchCount := 0
	err = scanFolderSearchIndex(ctx, indexPath, publishedSize, func(path string, ignored bool) error {
		if ignored && !includeIgnored || !matchesSearchPath(path, include, exclude) {
			return nil
		}
		local, err := filepath.Localize(path)
		if err != nil {
			return nil
		}
		file, err := root.Open(local)
		if err != nil {
			return nil
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || info.IsDir() || info.Size() > contentSearchFileLimit {
			return nil
		}
		reader := bufio.NewReaderSize(file, 32<<10)
		lineNumber := 0
		fileMatches := make([]protocol.ContentSearchMatch, 0, 4)
		for {
			if err := ctx.Err(); err != nil {
				return err
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
				return nil
			}
			for _, match := range expression.FindAllStringIndex(line, -1) {
				if wholeWord && !contentSearchWordBoundary(line, match[0], match[1]) {
					continue
				}
				fileMatches = append(fileMatches, contentSearchExcerpt(line, lineNumber, match[0], match[1]))
				matchCount++
				if matchCount >= limit {
					break
				}
			}
			if matchCount >= limit {
				break
			}
			if errors.Is(readErr, os.ErrClosed) || readErr != nil {
				break
			}
		}
		if len(fileMatches) > 0 {
			results = append(results, protocol.ContentSearchFile{Path: path, Matches: fileMatches})
		}
		if matchCount >= limit {
			return errSearchLimit
		}
		return nil
	})
	truncated := errors.Is(err, errSearchLimit)
	if err != nil && !truncated {
		return protocol.ContentSearchResults{}, err
	}
	return protocol.ContentSearchResults{Results: results, Complete: complete, Truncated: truncated}, nil
}

var errSearchLimit = errors.New("content search limit reached")

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
