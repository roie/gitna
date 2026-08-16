// Package protocol defines the JSON contract between the Go backend and the
// browser. All repository data crosses the wire as these typed structures;
// raw Git CLI text never reaches the frontend.
package protocol

import "errors"

// Sentinel errors returned by repository operations and classified by the API
// layer into HTTP status codes.
var (
	ErrInvalidPath = errors.New("invalid repository path")
	ErrInvalidRef  = errors.New("invalid ref or oid")
	ErrNotInRepo   = errors.New("path escapes repository")
)

// ChangeKind enumerates the change types a file can carry.
type ChangeKind string

const (
	KindModified   ChangeKind = "modified"
	KindAdded      ChangeKind = "added"
	KindDeleted    ChangeKind = "deleted"
	KindRenamed    ChangeKind = "renamed"
	KindUntracked  ChangeKind = "untracked"
	KindIgnored    ChangeKind = "ignored"
	KindConflicted ChangeKind = "conflicted"
)

// ChangeScope identifies which Git index surface a change belongs to.
type ChangeScope string

const (
	ScopeStaged   ChangeScope = "staged"
	ScopeUnstaged ChangeScope = "unstaged"
)

// FileChange describes one file's status in the index or worktree.
type FileChange struct {
	Path       string      `json:"path"`
	OldPath    string      `json:"oldPath,omitempty"`
	Kind       ChangeKind  `json:"kind"`
	Scope      ChangeScope `json:"scope"`
	Staged     bool        `json:"staged"`
	Conflicted bool        `json:"conflicted"`
}

// RepoSnapshot is a point-in-time view of the repository's source-control
// state, produced from git status and the worktree metadata.
type RepoSnapshot struct {
	Root       string       `json:"root"`
	HeadOID    string       `json:"headOid,omitempty"`
	HeadBranch string       `json:"headBranch,omitempty"`
	Upstream   string       `json:"upstream,omitempty"`
	Ahead      int          `json:"ahead"`
	Behind     int          `json:"behind"`
	Operation  string       `json:"operation"`
	Staged     []FileChange `json:"staged"`
	Unstaged   []FileChange `json:"unstaged"`
	Generation uint64       `json:"generation"`
}

// Operation names reported in RepoSnapshot.Operation.
const (
	OperationNone        = "none"
	OperationMerge       = "merge"
	OperationRebase      = "rebase"
	OperationCherryPick  = "cherry-pick"
	OperationRevert      = "revert"
)

// DiffScope identifies which Git surfaces are compared for a diff.
type DiffScope string

const (
	DiffUnstaged DiffScope = "unstaged"
	DiffStaged   DiffScope = "staged"
	DiffCommit   DiffScope = "commit"
	DiffCompare  DiffScope = "compare"
)

// DiffOptions carries the path and ref inputs for a diff request. Paths are
// repository-relative and always placed after -- when used with Git.
type DiffOptions struct {
	// Path is the canonical change path (the new path for renames).
	Path string
	// OldPath is set for renames.
	OldPath string
	// Commit is required for DiffCommit scope.
	Commit string
	// CompareFrom and CompareTo are required for DiffCompare scope.
	CompareFrom string
	CompareTo   string
}

// FileVersion is one side of a single-file diff.
type FileVersion struct {
	Path     string `json:"path"`
	Language string `json:"language,omitempty"`
	Content  string `json:"content"`
}

// FileDiff is the normalized before/after pair for one changed file. Binary and
// oversized files carry empty content; Binary/TooLarge explain why.
type FileDiff struct {
	Before   FileVersion `json:"before"`
	After    FileVersion `json:"after"`
	Binary   bool        `json:"binary"`
	TooLarge bool        `json:"tooLarge"`
}
