package conversations

import (
	"bytes"
	"cmp"
	"context"
	"fmt"
	"io/fs"
	"os"
	"strings"
	"unicode"
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

// Sources reads what conversations are anchored to. Renames, Changed, Head
// and Deleted are nil outside a Git repository. Head returns the current
// commit. Deleted returns the last commit that had path before a commit in
// HEAD's history deleted it, or "".
type Sources struct {
	Content Content
	Renames Renames
	Changed Changed
	Head    func(ctx context.Context) string
	Deleted func(ctx context.Context, path string) string
}

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
// side. Content holding neither the code nor any of its recorded context is a
// different file and reports missing. Anything else keeps the original lines,
// clamped to the file, and is reported as outdated so the stored code stays
// authoritative.
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
	if matches == 0 && !containsBlock(lines, before) && !containsBlock(lines, after) {
		location.Status = LocationMissing
	}
	return clamp(location, len(lines))
}

// containsBlock reports whether lines hold block in a row. A block without a
// letter or digit, such as blank lines or braces, proves nothing.
func containsBlock(lines, block []string) bool {
	if !strings.ContainsFunc(strings.Join(block, ""), func(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }) {
		return false
	}
	for start := 0; start+len(block) <= len(lines); start++ {
		if matchAt(lines, block, start) {
			return true
		}
	}
	return false
}

// Locate computes where each conversation's code is now. Commit content never
// changes. Index and worktree content is read through sources; a file that
// disappeared, or was replaced by unrelated content, is followed through Git
// rename detection and through changed files holding the code with all of its
// context, and a found move is recorded so later lookups by path see it. When
// the file cannot be followed, the code is looked up where Git still has it:
// the index, then HEAD, then the commit the conversation was started at. The
// location then names that source and revision. Code that Git never recorded
// is reported missing. A non-empty only keeps conversations currently at that
// path.
func (s *Store) Locate(ctx context.Context, list []Conversation, sources Sources, only string) []Conversation {
	content := sources.Content
	if content == nil {
		return list
	}
	only = cleanPath(only)
	type file struct {
		data []byte
		ok   bool
	}
	files := make(map[string]file)
	read := func(source, revision, path string) ([]byte, bool) {
		key := source + "\x00" + revision + "\x00" + path
		cached, seen := files[key]
		if !seen {
			data, err := content(ctx, source, revision, path)
			cached = file{data, err == nil && len(data) <= maxLocateBytes}
			files[key] = cached
		}
		return cached.data, cached.ok
	}
	head, headLoaded := "", false
	currentHead := func() string {
		if !headLoaded && sources.Head != nil {
			head = sources.Head(ctx)
		}
		headLoaded = true
		return head
	}
	renamesAt := make(map[string]map[string]string)
	var candidates []string
	candidatesLoaded := false
	// movedTo returns the one changed worktree file, other than from, that
	// holds the anchor's code with all of its recorded context.
	movedTo := func(anchor Anchor, from string) string {
		if sources.Changed == nil || anchor.Source != SourceWorktree || anchor.Code == "" {
			return ""
		}
		if !candidatesLoaded {
			candidates, _ = sources.Changed(ctx)
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
			data, ok := read(SourceWorktree, "", path)
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
			locate := func() {
				location = Location{Path: conversation.Path, StartLine: anchor.StartLine, EndLine: anchor.EndLine, Status: LocationMissing}
				if data, ok := read(anchor.Source, "", conversation.Path); ok {
					location = Locate(anchor, conversation.Path, data)
				}
			}
			// follow records a move only to content that is this file.
			follow := func(next string) bool {
				if next == "" {
					return false
				}
				moved, found := read(anchor.Source, "", next)
				if !found || Locate(anchor, next, moved).Status == LocationMissing || s.Relocate(conversation.ID, next) != nil {
					return false
				}
				conversation.Path = next
				locate()
				return true
			}
			locate()
			if _, present := read(anchor.Source, "", conversation.Path); !present && sources.Renames != nil {
				revision := cmp.Or(anchor.Revision, "HEAD")
				key := anchor.Source + "\x00" + revision
				moved, cached := renamesAt[key]
				if !cached {
					moved, _ = sources.Renames(ctx, anchor.Source, revision)
					renamesAt[key] = moved
				}
				follow(moved[conversation.Path])
			}
			if location.Status == LocationOutdated || location.Status == LocationMissing {
				follow(movedTo(anchor, conversation.Path))
			}
			if location.Status == LocationMissing {
				location = fromGit(ctx, sources, anchor, conversation.Path, location, read, currentHead)
			}
		}
		conversation.Location = &location
		if only == "" || conversation.Path == only {
			out = append(out, *conversation)
		}
	}
	return out
}

// fromGit finds code whose file is gone where Git still has it unchanged:
// the index, HEAD, the commit the conversation started at, or the last commit
// before the file was deleted. It returns missing when none of them holds the
// code, as for code that was never staged or committed.
func fromGit(ctx context.Context, sources Sources, anchor Anchor, path string, missing Location, read func(source, revision, path string) ([]byte, bool), head func() string) Location {
	type place struct{ source, revision, path string }
	var places []place
	if anchor.Source == SourceWorktree {
		places = append(places, place{SourceIndex, "", path})
	}
	if commit := head(); commit != "" {
		places = append(places, place{SourceCommit, commit, path})
	}
	if anchor.Revision != "" && anchor.Revision != head() {
		places = append(places, place{SourceCommit, anchor.Revision, anchor.Path})
	}
	try := func(at place) (Location, bool) {
		data, ok := read(at.source, at.revision, at.path)
		if !ok {
			return Location{}, false
		}
		location := Locate(anchor, at.path, data)
		location.Source, location.Revision = at.source, at.revision
		return location, location.Status == LocationCurrent || location.Status == LocationMoved
	}
	for _, at := range places {
		if location, ok := try(at); ok {
			return location
		}
	}
	if sources.Deleted != nil {
		if commit := sources.Deleted(ctx, path); commit != "" {
			if location, ok := try(place{SourceCommit, commit, path}); ok {
				return location
			}
		}
	}
	return missing
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
