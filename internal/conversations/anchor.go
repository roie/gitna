package conversations

import (
	"bytes"
	"context"
	"fmt"
	"io/fs"
	"os"
	"strings"
)

const (
	LocationCurrent  = "current"
	LocationMoved    = "moved"
	LocationOutdated = "outdated"
	LocationMissing  = "missing"

	maxLocateBytes = 8 << 20
	contextLines   = 3
)

// Content reads the file at path from a source. Revision names the commit for
// SourceCommit and is ignored otherwise. A file that does not exist there
// reports fs.ErrNotExist.
type Content func(ctx context.Context, source, revision, path string) ([]byte, error)

// WorktreeContent reads regular worktree files below root. Other sources do
// not exist there.
func WorktreeContent(root string) Content {
	return func(_ context.Context, source, _, path string) ([]byte, error) {
		if source != SourceWorktree {
			return nil, fs.ErrNotExist
		}
		tree, err := os.OpenRoot(root)
		if err != nil {
			return nil, err
		}
		defer tree.Close()
		info, err := tree.Stat(path)
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() || info.Size() > maxLocateBytes {
			return nil, fmt.Errorf("%s is not a readable text file", path)
		}
		return tree.ReadFile(path)
	}
}

// Renames reports old→new paths changed between revision and source, the
// worktree or the index.
type Renames func(ctx context.Context, source, revision string) (map[string]string, error)

// Changed lists worktree files that differ from HEAD or are untracked: the
// places code can have moved to without Git recording a rename.
type Changed func(ctx context.Context) ([]string, error)

// maxMoveCandidates bounds how many changed files are searched for code that
// left its file.
const maxMoveCandidates = 500

// Capture records the anchored lines of content, and the lines around them,
// in anchor.
func Capture(anchor *Anchor, content []byte) error {
	lines := splitLines(string(content))
	if anchor.StartLine < 1 || anchor.EndLine < anchor.StartLine || anchor.EndLine > len(lines) {
		return fmt.Errorf("%w: lines %d-%d are outside %s (%d lines)", ErrInvalid, anchor.StartLine, anchor.EndLine, anchor.Path, len(lines))
	}
	start, end := anchor.StartLine-1, anchor.EndLine
	anchor.Code = strings.Join(lines[start:end], "\n")
	anchor.Before = strings.Join(lines[max(0, start-contextLines):start], "\n")
	anchor.After = strings.Join(lines[end:min(len(lines), end+contextLines)], "\n")
	return nil
}

// Locate finds the anchor's original code in content. Identical text alone is
// not proof: code that is still at its original lines is trusted when nothing
// else matches or its surroundings agree, and code found elsewhere is followed
// only when exactly one match still has all of its recorded context on one
// side. Anything less keeps the original lines, clamped to the file, and is
// reported as outdated so the stored code stays authoritative.
func Locate(anchor Anchor, path string, content []byte) Location {
	location := Location{Path: path, StartLine: anchor.StartLine, EndLine: anchor.EndLine, Status: LocationCurrent}
	lines := splitLines(string(content))
	code := strings.Split(strings.ReplaceAll(anchor.Code, "\r\n", "\n"), "\n")
	if len(code) != anchor.EndLine-anchor.StartLine+1 {
		// No usable original code was recorded, so only the range can be checked.
		if anchor.EndLine > len(lines) {
			location.Status = LocationOutdated
		}
		return clamp(location, len(lines))
	}
	before, after := contextOf(anchor.Before), contextOf(anchor.After)
	original := anchor.StartLine - 1
	matches, confirmed, target := 0, 0, -1
	atOriginal, originalConfirmed := false, false
	for start := 0; start+len(code) <= len(lines); start++ {
		if !matchAt(lines, code, start) {
			continue
		}
		matches++
		ok := len(before)+len(after) == 0 ||
			(len(before) > 0 && matchAt(lines, before, start-len(before))) ||
			(len(after) > 0 && matchAt(lines, after, start+len(code)))
		if ok {
			confirmed++
			target = start
		}
		if start == original {
			atOriginal, originalConfirmed = true, ok
		}
	}
	switch {
	case originalConfirmed || (atOriginal && matches == 1):
		return location
	case confirmed == 1:
		location.StartLine, location.EndLine, location.Status = target+1, target+len(code), LocationMoved
		return location
	}
	location.Status = LocationOutdated
	return clamp(location, len(lines))
}

// Locate computes where each conversation's code is now. Commit content never
// changes. Index and worktree content is read through content; a worktree file
// that disappeared is followed through Git rename detection, and a found
// rename is recorded so later lookups by path see the new location. A
// non-empty only keeps conversations currently at that path.
func (s *Store) Locate(ctx context.Context, list []Conversation, content Content, renames Renames, changed Changed, only string) []Conversation {
	if content == nil {
		return list
	}
	only = cleanPath(only)
	type file struct {
		data []byte
		ok   bool
	}
	files := make(map[string]file)
	read := func(source, path string) ([]byte, bool) {
		key := source + "\x00" + path
		cached, seen := files[key]
		if !seen {
			data, err := content(ctx, source, "", path)
			cached = file{data, err == nil && len(data) <= maxLocateBytes}
			files[key] = cached
		}
		return cached.data, cached.ok
	}
	renamesAt := make(map[string]map[string]string)
	var candidates []string
	candidatesLoaded := false
	// movedTo returns the one changed worktree file, other than from, that
	// holds the anchor's code with all of its recorded context.
	movedTo := func(anchor Anchor, from string) string {
		if changed == nil || anchor.Source != SourceWorktree || anchor.Code == "" {
			return ""
		}
		if !candidatesLoaded {
			candidates, _ = changed(ctx)
			candidatesLoaded = true
		}
		if len(candidates) > maxMoveCandidates {
			return ""
		}
		found := ""
		first, _, _ := strings.Cut(anchor.Code, "\n")
		for _, path := range candidates {
			if path == from {
				continue
			}
			data, ok := read(SourceWorktree, path)
			if !ok || !bytes.Contains(data, []byte(first)) {
				continue
			}
			switch count := strictMatches(anchor, data); {
			case count > 1 || (count == 1 && found != ""):
				return ""
			case count == 1:
				found = path
			}
		}
		return found
	}
	out := list[:0]
	for index := range list {
		conversation := &list[index]
		anchor := conversation.Anchor
		location := Location{Path: conversation.Path, StartLine: anchor.StartLine, EndLine: anchor.EndLine, Status: LocationCurrent}
		if anchor.Source != SourceCommit {
			data, ok := read(anchor.Source, conversation.Path)
			follow := func(next string) {
				if next == "" {
					return
				}
				if moved, found := read(anchor.Source, next); found && s.Relocate(conversation.ID, next) == nil {
					conversation.Path, data, ok = next, moved, true
				}
			}
			if !ok && renames != nil {
				revision := anchor.Revision
				if revision == "" {
					revision = "HEAD"
				}
				key := anchor.Source + "\x00" + revision
				moved, cached := renamesAt[key]
				if !cached {
					moved, _ = renames(ctx, anchor.Source, revision)
					renamesAt[key] = moved
				}
				follow(moved[conversation.Path])
			}
			if !ok {
				follow(movedTo(anchor, conversation.Path))
			}
			location.Path, location.Status = conversation.Path, LocationMissing
			if ok {
				location = Locate(anchor, conversation.Path, data)
				if location.Status == LocationOutdated {
					if next := movedTo(anchor, conversation.Path); next != "" {
						follow(next)
						location = Locate(anchor, conversation.Path, data)
					}
				}
			}
		}
		conversation.Location = &location
		if only == "" || conversation.Path == only {
			out = append(out, *conversation)
		}
	}
	return out
}

// strictMatches counts places in content holding the anchor's code with all
// of its recorded context around it. Following code into another file needs
// this stronger evidence than a move within the same file.
func strictMatches(anchor Anchor, content []byte) int {
	lines := splitLines(string(content))
	code := strings.Split(strings.ReplaceAll(anchor.Code, "\r\n", "\n"), "\n")
	before, after := contextOf(anchor.Before), contextOf(anchor.After)
	count := 0
	for start := 0; start+len(code) <= len(lines); start++ {
		if matchAt(lines, code, start) && matchAt(lines, before, start-len(before)) && matchAt(lines, after, start+len(code)) {
			count++
		}
	}
	return count
}

// ParseChanged parses `git status --porcelain=v1 -z` output into the current
// paths of changed and untracked files.
func ParseChanged(output []byte) []string {
	var paths []string
	fields := bytes.Split(output, []byte{0})
	for index := 0; index < len(fields); index++ {
		entry := fields[index]
		if len(entry) < 4 {
			continue
		}
		if entry[0] != 'D' && entry[1] != 'D' {
			paths = append(paths, string(entry[3:]))
		}
		if entry[0] == 'R' || entry[0] == 'C' {
			index++
		}
	}
	return paths
}

// ParseRenames parses `git diff --name-status -z` output into old→new paths.
func ParseRenames(output []byte) map[string]string {
	renames := make(map[string]string)
	fields := bytes.Split(output, []byte{0})
	for index := 0; index < len(fields); index++ {
		status := string(fields[index])
		if strings.HasPrefix(status, "R") && index+2 < len(fields) {
			renames[string(fields[index+1])] = string(fields[index+2])
			index += 2
		} else if strings.HasPrefix(status, "C") {
			index += 2
		} else if status != "" {
			index++
		}
	}
	return renames
}

func splitLines(text string) []string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.TrimSuffix(text, "\n")
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}

func matchAt(lines, code []string, start int) bool {
	if start < 0 || start+len(code) > len(lines) {
		return false
	}
	for offset, line := range code {
		if lines[start+offset] != line {
			return false
		}
	}
	return true
}

func contextOf(text string) []string {
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}

func clamp(location Location, lineCount int) Location {
	lineCount = max(lineCount, 1)
	location.StartLine = min(location.StartLine, lineCount)
	location.EndLine = min(max(location.EndLine, location.StartLine), lineCount)
	return location
}
