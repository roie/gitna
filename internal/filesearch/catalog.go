// Package filesearch provides Gitna's bounded, progressive filename search index.
package filesearch

import (
	"context"
	"path"
	"runtime"
	"sort"
	"strings"
	"unicode/utf8"
	"unsafe"
)

const (
	// DefaultMemoryLimit bounds accounted retained arenas, records, basename
	// metadata, and default results in the hot catalog. The caller retains a disk
	// catalog as a correctness fallback when this limit is exceeded. Go allocator
	// size classes and the brief []byte-to-string copy during segment publication
	// are transient and intentionally not reported as retained catalog memory.
	DefaultMemoryLimit int64 = 256 << 20
	defaultSegmentSize       = 4096
	defaultResultLimit       = 100
)

var (
	recordBytes         = int64(unsafe.Sizeof(record{}))
	segmentBytes        = int64(unsafe.Sizeof(segment{}))
	segmentPointerBytes = int64(unsafe.Sizeof((*segment)(nil)))
)

type record struct {
	pathOffset uint32
	pathLength uint32
	nameOffset uint32
	nameLength uint32
	foldOffset uint32
	foldLength uint32
	foldName   uint32
	depth      uint16
	dependency bool
	ignored    bool
}

type segment struct {
	paths   string
	folded  string
	records []record
}

// Snapshot is an immutable catalog generation safe for concurrent searches.
type Snapshot struct {
	segments   []*segment
	duplicates map[string]uint32
	complete   bool
	overflow   bool
	memory     int64
	defaults   []Result
}

func (s Snapshot) Complete() bool { return s.complete }
func (s Snapshot) Overflow() bool { return s.overflow }

// MemoryBytes reports the builder's conservative retained-memory accounting;
// transient publication copies and runtime allocator slack are excluded.
func (s Snapshot) MemoryBytes() int64 { return s.memory }
func (s Snapshot) Len() int {
	total := 0
	for _, segment := range s.segments {
		total += len(segment.records)
	}
	return total
}

// Builder constructs immutable segments and publishes snapshots without
// mutating segments already visible to readers.
type Builder struct {
	limit           int64
	recordLimit     int64
	memory          int64
	overflow        bool
	segments        []*segment
	paths           []byte
	folded          []byte
	records         []record
	duplicates      map[string]uint32
	duplicateMemory int64
	defaults        candidateHeap
	defaultLimit    int64
	defaultMemory   int64
	segmentSize     int
	arenaCapacity   int
	recordCapacity  int
	sealed          bool
	final           Snapshot
}

func NewBuilder(limit int64) *Builder {
	if limit <= 0 {
		limit = DefaultMemoryLimit
	}
	candidateBytes := max(int64(unsafe.Sizeof(candidate{})), 1)
	defaultReserve := min(limit, int64(defaultResultLimit)*(candidateBytes+4096))
	recordLimit := limit - defaultReserve
	defaultCapacity := int(min(int64(defaultResultLimit), limit/candidateBytes))
	segmentSize := int(min(int64(defaultSegmentSize), max(int64(1), recordLimit/max(recordBytes, 1))))
	arenaCapacity := int(min(int64(256*1024), max(int64(0), recordLimit/4)))
	recordCapacity := segmentSize
	if recordLimit < recordBytes {
		recordCapacity = 0
	}
	return &Builder{
		limit:          limit,
		recordLimit:    recordLimit,
		paths:          make([]byte, 0, arenaCapacity),
		folded:         make([]byte, 0, arenaCapacity),
		records:        make([]record, 0, recordCapacity),
		duplicates:     make(map[string]uint32),
		defaults:       make(candidateHeap, 0, defaultCapacity),
		defaultLimit:   defaultReserve,
		segmentSize:    segmentSize,
		arenaCapacity:  arenaCapacity,
		recordCapacity: recordCapacity,
	}
}

// Add appends one slash-normalized relative file path. It returns false after
// the memory limit is reached; callers must continue writing their disk
// fallback even when the hot catalog stops accepting records.
func (b *Builder) Add(path string, ignored bool) bool {
	if b.overflow || b.sealed {
		return false
	}
	isIgnored := ignored
	folded := strings.ToLower(path)
	nameStart := strings.LastIndexByte(folded, '/') + 1
	foldedName := folded[nameStart:]
	_, knownName := b.duplicates[foldedName]
	nameMemory := int64(0)
	if !knownName {
		// Account conservatively for the cloned key and map bucket overhead.
		nameMemory = int64(len(foldedName) + 64)
	}
	projected := int64(len(b.paths)+len(path)+len(b.folded)+len(folded)) +
		int64(len(b.records)+1)*recordBytes + segmentBytes + segmentPointerBytes
	if b.memory+b.duplicateMemory+projected+nameMemory > b.recordLimit {
		b.overflow = true
		return false
	}
	pathOffset := len(b.paths)
	foldOffset := len(b.folded)
	nameOffset := strings.LastIndexByte(path, '/') + 1
	foldName := nameStart
	b.paths = append(b.paths, path...)
	b.folded = append(b.folded, folded...)
	b.records = append(b.records, record{
		pathOffset: uint32(pathOffset), pathLength: uint32(len(path)),
		nameOffset: uint32(pathOffset + nameOffset), nameLength: uint32(len(path) - nameOffset),
		foldOffset: uint32(foldOffset), foldLength: uint32(len(folded)),
		foldName: uint32(foldOffset + foldName), depth: uint16(min(strings.Count(path, "/"), 65535)),
		dependency: dependencyPath(folded), ignored: isIgnored,
	})
	if !knownName {
		foldedName = strings.Clone(foldedName)
		b.duplicateMemory += nameMemory
	}
	b.duplicates[foldedName]++
	b.addDefault(path, nameOffset, uint16(min(strings.Count(path, "/"), 65535)), dependencyPath(folded), isIgnored)
	if len(b.records) >= b.segmentSize {
		b.freeze()
	}
	return true
}

func candidateMemory(value candidate) int64 {
	return int64(unsafe.Sizeof(value)) + int64(len(value.result.Path))
}

func (b *Builder) addDefault(filePath string, nameOffset int, depth uint16, dependency, ignored bool) {
	name := filePath[nameOffset:]
	entry := candidate{
		result: Result{
			Path: filePath, Name: name,
			Parent:     strings.TrimSuffix(filePath[:nameOffset], "/"),
			Dependency: dependency, Ignored: ignored,
		},
		tier: 3, quality: int(depth),
	}
	if dependency {
		entry.tier = 5
	}
	entryMemory := candidateMemory(entry)
	if len(b.defaults) < defaultResultLimit && b.defaultMemory+entryMemory <= b.defaultLimit {
		b.defaults = append(b.defaults, entry)
		b.defaultMemory += entryMemory
		heapInit(b.defaults)
		return
	}
	if len(b.defaults) == 0 || !entry.betterThan(b.defaults[0]) {
		return
	}
	delta := entryMemory - candidateMemory(b.defaults[0])
	if b.defaultMemory+delta > b.defaultLimit {
		return
	}
	b.defaultMemory += delta
	b.defaults[0] = entry
	heapFix(b.defaults, 0)
}

func dependencyPath(path string) bool {
	return path == "node_modules" || strings.HasPrefix(path, "node_modules/") || strings.Contains(path, "/node_modules/")
}

func (b *Builder) freeze() {
	if len(b.records) == 0 {
		return
	}
	records := b.records
	if len(records) != cap(records) {
		records = make([]record, len(b.records))
		copy(records, b.records)
	}
	segment := &segment{
		paths: string(b.paths), folded: string(b.folded), records: records[:len(records):len(records)],
	}
	b.memory += int64(len(segment.paths)+len(segment.folded)) + int64(len(segment.records))*recordBytes +
		segmentBytes + segmentPointerBytes
	b.segments = append(b.segments, segment)
	b.paths = make([]byte, 0, b.arenaCapacity)
	b.folded = make([]byte, 0, b.arenaCapacity)
	b.records = make([]record, 0, b.recordCapacity)
}

// Snapshot freezes the current progressive batch and returns an immutable view.
func (b *Builder) Snapshot(complete bool) Snapshot {
	if complete && b.sealed {
		return b.final
	}
	b.freeze()
	segments := make([]*segment, len(b.segments))
	copy(segments, b.segments)
	var duplicates map[string]uint32
	if complete && !b.overflow {
		// Completion seals the builder, transferring the duplicate map rather than
		// sharing mutable state with an active builder.
		duplicates = b.duplicates
	}
	defaults := make([]candidate, len(b.defaults))
	copy(defaults, b.defaults)
	sort.Slice(defaults, func(left, right int) bool { return defaults[left].betterThan(defaults[right]) })
	defaultResults := make([]Result, len(defaults))
	for index := range defaults {
		defaultResults[index] = defaults[index].result
	}
	snapshot := Snapshot{
		segments: segments, duplicates: duplicates, complete: complete,
		overflow: b.overflow, memory: b.memory + b.duplicateMemory + b.defaultMemory,
		defaults: defaultResults,
	}
	if complete {
		b.sealed = true
		b.final = snapshot
	}
	return snapshot
}

// Result is one ranked file returned to the API layer.
type Result struct {
	Path          string
	Name          string
	Parent        string
	MatchIndices  []int
	DuplicateName bool
	Dependency    bool
	Ignored       bool
}

type queryPlan struct {
	value      string
	terms      []string
	pathIntent bool
}

func newQueryPlan(query string) queryPlan {
	value := strings.ToLower(strings.TrimSpace(query))
	if runtime.GOOS == "windows" {
		value = strings.ReplaceAll(value, "\\", "/")
	}
	return queryPlan{value: value, terms: strings.Fields(value), pathIntent: strings.Contains(value, "/")}
}

type candidate struct {
	result  Result
	tier    uint8
	quality int
}

func (c candidate) betterThan(other candidate) bool {
	return c.tier < other.tier || (c.tier == other.tier && (c.quality < other.quality || (c.quality == other.quality && c.result.Path < other.result.Path)))
}

type candidateHeap []candidate

func (h candidateHeap) Len() int           { return len(h) }
func (h candidateHeap) Less(i, j int) bool { return h[j].betterThan(h[i]) }
func (h candidateHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *candidateHeap) Push(value any)    { *h = append(*h, value.(candidate)) }
func (h *candidateHeap) Pop() any {
	old := *h
	last := len(old) - 1
	value := old[last]
	*h = old[:last]
	return value
}

// Search ranks a bounded result set without allocating per catalog entry.
func (s Snapshot) Search(ctx context.Context, query string, recentPaths []string, limit int, includeIgnored bool) ([]Result, error) {
	if limit <= 0 {
		return []Result{}, nil
	}
	allowIgnored := includeIgnored
	plan := newQueryPlan(query)
	if plan.value == "" {
		return s.emptyResults(recentPaths, limit, allowIgnored), nil
	}
	if len(s.segments) == 0 {
		return []Result{}, nil
	}
	recency := make(map[string]int, len(recentPaths))
	for index, recent := range recentPaths {
		if normalized, ok := normalizeRecentPath(recent); ok {
			recency[normalized] = index + 1
		}
	}
	matches := make(candidateHeap, 0, limit)
	seen := 0
	for _, segment := range s.segments {
		for _, record := range segment.records {
			if seen%256 == 0 {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
			}
			seen++
			if record.ignored && !allowIgnored {
				continue
			}
			path := segment.folded[record.foldOffset : record.foldOffset+record.foldLength]
			name := segment.folded[record.foldName : record.foldOffset+record.foldLength]
			tier, quality, ok := scorePath(path, name, int(record.depth), record.dependency, plan)
			if !ok {
				continue
			}
			originalPath := segment.paths[record.pathOffset : record.pathOffset+record.pathLength]
			quality -= min(recency[originalPath], 10)
			originalName := segment.paths[record.nameOffset : record.nameOffset+record.nameLength]
			parent := strings.TrimSuffix(originalPath[:len(originalPath)-len(originalName)], "/")
			entry := candidate{result: Result{
				Path: originalPath, Name: originalName, Parent: parent, Dependency: record.dependency, Ignored: record.ignored,
			}, tier: tier, quality: quality}
			addCandidate(&matches, entry, limit)
		}
	}
	sort.Slice(matches, func(i, j int) bool { return matches[i].betterThan(matches[j]) })
	for index := range matches {
		if s.duplicates != nil {
			matches[index].result.DuplicateName = s.duplicates[strings.ToLower(matches[index].result.Name)] > 1
		} else {
			for other := range matches {
				if other != index && strings.EqualFold(matches[index].result.Name, matches[other].result.Name) {
					matches[index].result.DuplicateName = true
					break
				}
			}
		}
	}
	results := make([]Result, len(matches))
	for index := range matches {
		results[index] = matches[index].result
	}
	addResultMatchIndices(results, plan)
	return results, nil
}

func addCandidate(values *candidateHeap, entry candidate, limit int) {
	if len(*values) < limit {
		*values = append(*values, entry)
		if len(*values) == limit {
			heapInit(*values)
		}
	} else if entry.betterThan((*values)[0]) {
		(*values)[0] = entry
		heapFix(*values, 0)
	}
}

// NormalizeRecentPath converts a user-supplied recent path to the platform's
// slash-canonical relative form. On Unix a backslash is a valid filename byte,
// not a separator.
func NormalizeRecentPath(value string) (string, bool) {
	normalized := value
	if runtime.GOOS == "windows" {
		normalized = strings.ReplaceAll(normalized, "\\", "/")
	}
	if normalized == "" || strings.IndexByte(normalized, 0) >= 0 || strings.HasPrefix(normalized, "/") ||
		(runtime.GOOS == "windows" && len(normalized) >= 2 && normalized[1] == ':') {
		return "", false
	}
	normalized = path.Clean(normalized)
	if normalized == "." || normalized == ".." || strings.HasPrefix(normalized, "../") {
		return "", false
	}
	return normalized, true
}

func normalizeRecentPath(value string) (string, bool) {
	return NormalizeRecentPath(value)
}

func (s Snapshot) emptyResults(recentPaths []string, limit int, includeIgnored bool) []Result {
	results := make([]Result, 0, min(limit, len(recentPaths)+len(s.defaults)))
	seen := make(map[string]struct{}, cap(results))
	appendPath := func(filePath string) {
		if len(results) >= limit {
			return
		}
		normalized, ok := normalizeRecentPath(filePath)
		if !ok {
			return
		}
		if _, exists := seen[normalized]; exists {
			return
		}
		seen[normalized] = struct{}{}
		nameOffset := strings.LastIndexByte(normalized, '/') + 1
		name := normalized[nameOffset:]
		results = append(results, Result{
			Path: normalized, Name: name,
			Parent:        strings.TrimSuffix(normalized[:nameOffset], "/"),
			DuplicateName: s.duplicates != nil && s.duplicates[strings.ToLower(name)] > 1,
			Dependency:    dependencyPath(strings.ToLower(normalized)),
		})
	}
	for index := len(recentPaths) - 1; index >= 0 && len(results) < limit; index-- {
		appendPath(recentPaths[index])
	}
	for _, fallback := range s.defaults {
		if len(results) >= limit {
			break
		}
		if fallback.Ignored && !includeIgnored {
			continue
		}
		appendPath(fallback.Path)
	}
	return results
}

// PathScanner enumerates slash-canonical relative paths. It may be invoked
// twice so disk-backed callers can compute duplicate-name metadata without
// retaining an unbounded map. Scanners must stop and return a visitor error.
type PathScanner func(visit func(string, bool) error) error

// RankPaths applies the same authoritative query plan and scorer used by
// Snapshot.Search to a bounded-memory external path stream.
func RankPaths(
	ctx context.Context,
	query string,
	recentPaths []string,
	limit int,
	scan PathScanner,
	includeIgnored bool,
) ([]Result, error) {
	if limit <= 0 {
		return []Result{}, nil
	}
	plan := newQueryPlan(query)
	if plan.value == "" {
		return rankDefaultPaths(ctx, recentPaths, limit, scan, includeIgnored)
	}
	recency := make(map[string]int, len(recentPaths))
	for index, recent := range recentPaths {
		if normalized, ok := normalizeRecentPath(recent); ok {
			recency[normalized] = index + 1
		}
	}
	matches := make(candidateHeap, 0, limit)
	seen := 0
	if err := scan(func(filePath string, ignored bool) error {
		if seen%256 == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		seen++
		if ignored && !includeIgnored {
			return nil
		}
		folded := strings.ToLower(filePath)
		nameOffset := strings.LastIndexByte(filePath, '/') + 1
		foldName := strings.LastIndexByte(folded, '/') + 1
		tier, quality, ok := scorePath(
			folded, folded[foldName:], strings.Count(filePath, "/"), dependencyPath(folded), plan,
		)
		if !ok {
			return nil
		}
		quality -= min(recency[filePath], 10)
		addCandidate(&matches, candidate{result: Result{
			Path: filePath, Name: filePath[nameOffset:],
			Parent:     strings.TrimSuffix(filePath[:nameOffset], "/"),
			Dependency: dependencyPath(folded), Ignored: ignored,
		}, tier: tier, quality: quality}, limit)
		return nil
	}); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	sort.Slice(matches, func(left, right int) bool { return matches[left].betterThan(matches[right]) })
	results := make([]Result, len(matches))
	for index := range matches {
		results[index] = matches[index].result
	}
	if err := markDuplicateNames(ctx, results, scan, includeIgnored); err != nil {
		return nil, err
	}
	addResultMatchIndices(results, plan)
	return results, nil
}

func rankDefaultPaths(
	ctx context.Context,
	recentPaths []string,
	limit int,
	scan PathScanner,
	includeIgnored bool,
) ([]Result, error) {
	recentOrder := make([]string, 0, len(recentPaths))
	recentSet := make(map[string]struct{}, len(recentPaths))
	for index := len(recentPaths) - 1; index >= 0; index-- {
		if normalized, ok := normalizeRecentPath(recentPaths[index]); ok {
			if _, exists := recentSet[normalized]; !exists {
				recentSet[normalized] = struct{}{}
				recentOrder = append(recentOrder, normalized)
			}
		}
	}
	foundRecent := make(map[string]Result, len(recentOrder))
	defaults := make(candidateHeap, 0, limit)
	seen := 0
	if err := scan(func(filePath string, ignored bool) error {
		if seen%256 == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		seen++
		if ignored && !includeIgnored {
			return nil
		}
		folded := strings.ToLower(filePath)
		nameOffset := strings.LastIndexByte(filePath, '/') + 1
		result := Result{
			Path: filePath, Name: filePath[nameOffset:],
			Parent:     strings.TrimSuffix(filePath[:nameOffset], "/"),
			Dependency: dependencyPath(folded), Ignored: ignored,
		}
		if _, recent := recentSet[filePath]; recent {
			foundRecent[filePath] = result
			return nil
		}
		tier, quality, _ := scorePath(
			folded, folded[strings.LastIndexByte(folded, '/')+1:], strings.Count(filePath, "/"), result.Dependency, queryPlan{},
		)
		addCandidate(&defaults, candidate{result: result, tier: tier, quality: quality}, limit)
		return nil
	}); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	sort.Slice(defaults, func(left, right int) bool { return defaults[left].betterThan(defaults[right]) })
	results := make([]Result, 0, limit)
	for _, recent := range recentOrder {
		if result, exists := foundRecent[recent]; exists {
			results = append(results, result)
			if len(results) == limit {
				break
			}
		}
	}
	for _, fallback := range defaults {
		if len(results) == limit {
			break
		}
		results = append(results, fallback.result)
	}
	if err := markDuplicateNames(ctx, results, scan, includeIgnored); err != nil {
		return nil, err
	}
	return results, nil
}

func addResultMatchIndices(results []Result, plan queryPlan) {
	if plan.value == "" {
		return
	}
	for index := range results {
		results[index].MatchIndices = pathMatchRuneIndices(results[index].Path, results[index].Name, plan)
	}
}

func pathMatchRuneIndices(filePath, name string, plan queryPlan) []int {
	foldedPath := strings.ToLower(filePath)
	foldedName := strings.ToLower(name)
	if foldedPath == plan.value || foldedName == plan.value {
		return singleTermMatchRuneIndices(foldedPath, foldedName, plan.value)
	}
	terms := plan.terms
	if len(terms) <= 1 {
		terms = []string{plan.value}
	}
	matched := make(map[int]struct{}, len(plan.value))
	for _, term := range terms {
		for _, index := range singleTermMatchRuneIndices(foldedPath, foldedName, term) {
			matched[index] = struct{}{}
		}
	}
	indices := make([]int, 0, len(matched))
	for index := range matched {
		indices = append(indices, index)
	}
	sort.Ints(indices)
	return indices
}

func singleTermMatchRuneIndices(filePath, name, query string) []int {
	nameStart := len(filePath) - len(name)
	if strings.HasPrefix(name, query) {
		return byteRangeRuneIndices(filePath, nameStart, nameStart+len(query))
	}
	if strings.HasPrefix(filePath, query) {
		return byteRangeRuneIndices(filePath, 0, len(query))
	}
	if index := strings.Index(name, query); index >= 0 {
		return byteRangeRuneIndices(filePath, nameStart+index, nameStart+index+len(query))
	}
	if index := strings.Index(filePath, query); index >= 0 {
		return byteRangeRuneIndices(filePath, index, index+len(query))
	}
	if len(query) < len(name) {
		if _, indices, ok := fuzzyMatch(name, query, true); ok {
			nameRuneStart := utf8.RuneCountInString(filePath[:nameStart])
			for index := range indices {
				indices[index] += nameRuneStart
			}
			return indices
		}
	}
	if _, indices, ok := fuzzyMatch(filePath, query, true); ok {
		return indices
	}
	return nil
}

func byteRangeRuneIndices(value string, start, end int) []int {
	indices := make([]int, 0, utf8.RuneCountInString(value[start:end]))
	runeIndex := 0
	for byteIndex := range value {
		if byteIndex >= end {
			break
		}
		if byteIndex >= start {
			indices = append(indices, runeIndex)
		}
		runeIndex++
	}
	return indices
}

func markDuplicateNames(ctx context.Context, results []Result, scan PathScanner, _ bool) error {
	candidateNames := make(map[string]uint32, len(results))
	for _, result := range results {
		candidateNames[strings.ToLower(result.Name)] = 0
	}
	seen := 0
	if len(candidateNames) > 0 {
		if err := scan(func(filePath string, _ bool) error {
			if seen%256 == 0 {
				if err := ctx.Err(); err != nil {
					return err
				}
			}
			seen++
			folded := strings.ToLower(filePath)
			name := folded[strings.LastIndexByte(folded, '/')+1:]
			if _, exists := candidateNames[name]; exists {
				candidateNames[name]++
			}
			return nil
		}); err != nil {
			return err
		}
	}
	for index := range results {
		results[index].DuplicateName = candidateNames[strings.ToLower(results[index].Name)] > 1
	}
	return nil
}

// Tiny local heap helpers avoid exposing heap implementation details.
func heapInit(values candidateHeap) {
	for index := len(values)/2 - 1; index >= 0; index-- {
		heapDown(values, index)
	}
}
func heapFix(values candidateHeap, index int) { heapDown(values, index) }
func heapDown(values candidateHeap, root int) {
	for {
		child := root*2 + 1
		if child >= len(values) {
			return
		}
		if child+1 < len(values) && values.Less(child+1, child) {
			child++
		}
		if !values.Less(child, root) {
			return
		}
		values.Swap(root, child)
		root = child
	}
}

func scorePath(path, name string, depth int, dependency bool, plan queryPlan) (uint8, int, bool) {
	if plan.value == "" {
		if dependency {
			return 5, depth, true
		}
		return 3, depth, true
	}
	if path == plan.value {
		return 0, depth, true
	}
	dependencyPenalty := dependency && !plan.pathIntent
	if name == plan.value {
		if dependencyPenalty {
			return 4, depth, true
		}
		if depth == 0 {
			return 1, 0, true
		}
		return 2, depth, true
	}
	quality, ok := fuzzyQuality(path, name, plan)
	if !ok {
		return 0, 0, false
	}
	if dependencyPenalty {
		return 5, quality + depth, true
	}
	return 3, quality + depth, true
}

func fuzzyQuality(path, name string, plan queryPlan) (int, bool) {
	if len(plan.terms) > 1 {
		total := 0
		for _, term := range plan.terms {
			score, ok := singleTermQuality(path, name, term)
			if !ok {
				return 0, false
			}
			total += score
		}
		return total, true
	}
	return singleTermQuality(path, name, plan.value)
}

func singleTermQuality(path, name, query string) (int, bool) {
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
	if len(query) < len(name) {
		if score, ok := fuzzyScore(name, query); ok {
			return 100 + score, true
		}
	}
	score, ok := fuzzyScore(path, query)
	if !ok {
		return 0, false
	}
	return 120 + score, true
}

func fuzzyScore(value, query string) (int, bool) {
	score, _, ok := fuzzyMatch(value, query, false)
	return score, ok
}

func fuzzyMatch(value, query string, collectIndices bool) (int, []int, bool) {
	position, nextStart, gap, run, bestRun := -1, 0, 0, 0, 0
	var indices []int
	if collectIndices {
		indices = make([]int, 0, utf8.RuneCountInString(query))
	}
	for _, queryRune := range query {
		nextRelative := -1
		if queryRune == utf8.RuneError {
			nextRelative = indexValidReplacementRune(value[nextStart:])
		} else {
			nextRelative = strings.IndexRune(value[nextStart:], queryRune)
		}
		if nextRelative < 0 {
			return 0, nil, false
		}
		next := nextStart + nextRelative
		if next == nextStart {
			run++
		} else {
			gap += next - nextStart
			run = 1
		}
		if run > bestRun {
			bestRun = run
		}
		position = next
		nextStart = next + utf8.RuneLen(queryRune)
		if collectIndices {
			indices = append(indices, utf8.RuneCountInString(value[:next]))
		}
	}
	return gap + position - bestRun*2, indices, true
}

func indexValidReplacementRune(value string) int {
	searchStart := 0
	for searchStart < len(value) {
		index := strings.IndexRune(value[searchStart:], utf8.RuneError)
		if index < 0 {
			return -1
		}
		index += searchStart
		_, size := utf8.DecodeRuneInString(value[index:])
		if size > 1 {
			return index
		}
		searchStart = index + 1
	}
	return -1
}
