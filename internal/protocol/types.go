// Package protocol defines the JSON contract between the Go backend and the
// browser. Repository data crosses the wire as typed structures; the only raw
// Git output exposed is an explicitly bounded, sanitized patch for Pierre's
// review parser.
package protocol

import (
	"errors"
	"time"
)

// Sentinel errors returned by repository operations and classified by the API
// layer into HTTP status codes.
var (
	ErrInvalidPath          = errors.New("invalid repository path")
	ErrInvalidRef           = errors.New("invalid ref or oid")
	ErrNotInRepo            = errors.New("path escapes repository")
	ErrReviewTooLarge       = errors.New("review exceeds bounded response limits")
	ErrWorktreeBinary       = errors.New("binary worktree file")
	ErrWorktreeConflict     = errors.New("worktree file changed")
	ErrWorktreeEntryExists  = errors.New("worktree entry already exists")
	ErrWorktreeFileTooLarge = errors.New("worktree file exceeds edit limit")
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
// RepositoryFiles is a bounded filesystem view of the worktree used by the
// Explorer tree. Paths are repository-relative and always slash-separated.
type RepositoryFiles struct {
	Generation   uint64   `json:"generation"`
	Paths        []string `json:"paths"`
	IgnoredPaths []string `json:"ignoredPaths"`
	Truncated    bool     `json:"truncated"`
	NextCursor   string   `json:"nextCursor,omitempty"`
}

// WorktreeFile is an editable text file read directly from the worktree.
// Hash is an optimistic-concurrency token supplied again when saving.
type WorktreeFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Hash    string `json:"hash"`
}

type RepoSnapshot struct {
	AppVersion string          `json:"appVersion"`
	Root       string          `json:"root"`
	HeadOID    string          `json:"headOid,omitempty"`
	HeadBranch string          `json:"headBranch,omitempty"`
	Upstream   string          `json:"upstream,omitempty"`
	Ahead      int             `json:"ahead"`
	Behind     int             `json:"behind"`
	Operation  string          `json:"operation"`
	Staged     []FileChange    `json:"staged"`
	Unstaged   []FileChange    `json:"unstaged"`
	Conflicts  []ConflictEntry `json:"conflicts,omitempty"`
	Generation uint64          `json:"generation"`
}

// Operation names reported in RepoSnapshot.Operation.
const (
	OperationNone       = "none"
	OperationMerge      = "merge"
	OperationRebase     = "rebase"
	OperationCherryPick = "cherry-pick"
	OperationRevert     = "revert"
)

// DiffScope identifies which Git surfaces are compared for a diff.
type DiffScope string

const (
	DiffUnstaged DiffScope = "unstaged"
	DiffStaged   DiffScope = "staged"
	DiffCommit   DiffScope = "commit"
	DiffCompare  DiffScope = "compare"
	DiffConflict DiffScope = "conflict"
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

// ReviewIdentity identifies the repository surface represented by a bounded
// multi-file review. Commit and compare refs are populated only for their
// corresponding scope.
type ReviewIdentity struct {
	Scope       DiffScope `json:"scope"`
	Commit      string    `json:"commit,omitempty"`
	CompareFrom string    `json:"from,omitempty"`
	CompareTo   string    `json:"to,omitempty"`
}

// ReviewSupplement carries content that is not represented by the tracked Git
// patch, currently untracked worktree files. Binary and oversized entries keep
// empty content and are explained by FileDiff's flags.
type ReviewSupplement struct {
	Path string     `json:"path"`
	Kind ChangeKind `json:"kind"`
	Diff FileDiff   `json:"diff"`
}

// ReviewResponse is the bounded read model consumed by the continuous review
// surface. Patch contains tracked changes only; supplements complete the scope
// without issuing one HTTP request per untracked file.
type ReviewResponse struct {
	Generation  uint64             `json:"generation"`
	Identity    ReviewIdentity     `json:"identity"`
	Patch       string             `json:"patch"`
	Supplements []ReviewSupplement `json:"supplements"`
}

// ImageContent is a bounded raster image embedded in a single-file diff. Data
// is standard base64 without a data-URL prefix.
type ImageContent struct {
	MIME string `json:"mime"`
	Data string `json:"data"`
	Size int    `json:"size"`
}

// FileVersion is one side of a single-file diff.
type FileVersion struct {
	Path     string        `json:"path"`
	Language string        `json:"language,omitempty"`
	Content  string        `json:"content"`
	Image    *ImageContent `json:"image,omitempty"`
}

// FileDiff is the normalized before/after pair for one changed file. Binary and
// oversized files carry empty text content; supported raster images instead
// carry bounded image data. Binary/TooLarge explain why. Patch is
// the exact unified diff Git shows for this file in its scope, used to apply
// whole-hunk stages back through git apply; it is empty when unavailable.
type FileDiff struct {
	Before   FileVersion `json:"before"`
	After    FileVersion `json:"after"`
	Binary   bool        `json:"binary"`
	TooLarge bool        `json:"tooLarge"`
	Patch    string      `json:"patch,omitempty"`
	PatchID  string      `json:"patchId,omitempty"`
}

// CommitRequest carries the message and amend flag for a commit operation.
// The message is fed to git on stdin, so shell quoting never applies.
type CommitRequest struct {
	Message string `json:"message"`
	Amend   bool   `json:"amend"`
}

// OperationResult reports the outcome of a commit. Hooks run normally; when a
// hook rejects the commit the exit code and git's output are relayed so the
// browser can show the reason instead of a generic failure.
type OperationResult struct {
	OK       bool   `json:"ok"`
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout,omitempty"`
	Stderr   string `json:"stderr,omitempty"`
}

// CommitRef identifies one ref pointing at a commit. Kind values are the
// display categories the graph view renders as decorations.
type CommitRef struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
}

// Ref kind values carried by CommitRef.
const (
	RefKindHead         = "head"
	RefKindLocalBranch  = "local-branch"
	RefKindRemoteBranch = "remote-branch"
	RefKindTag          = "tag"
)

// GraphCommit is one row of the repository history graph. Parent OIDs are in
// git order (first parent first).
type GraphCommit struct {
	OID        string      `json:"oid"`
	Parents    []string    `json:"parents"`
	Subject    string      `json:"subject"`
	AuthorName string      `json:"authorName"`
	AuthorTime time.Time   `json:"authorTime"`
	Refs       []CommitRef `json:"refs"`
}

// CommitFile is one path changed by a commit. Kind uses the same ChangeKind
// vocabulary as the working-tree view so the frontend renders a single status
// vocabulary. OldPath is set for renames.
type CommitFile struct {
	Path    string     `json:"path"`
	OldPath string     `json:"oldPath,omitempty"`
	Kind    ChangeKind `json:"kind"`
}

// GraphPage is one page of history in topological order. HasMore reports
// whether the page was full and more history may be available after it.
type GraphPage struct {
	Commits []GraphCommit `json:"commits"`
	HasMore bool          `json:"hasMore"`
}

// CommitStats summarizes a commit against its first parent. BinaryFiles counts
// entries whose numstat line has no meaningful line totals.
type CommitStats struct {
	Files       int `json:"files"`
	Additions   int `json:"additions"`
	Deletions   int `json:"deletions"`
	BinaryFiles int `json:"binaryFiles"`
}

// CommitFiles is the changed-file list and lazy diff statistics for one commit.
type CommitFiles struct {
	Files []CommitFile `json:"files"`
	Stats CommitStats  `json:"stats"`
}

// Branch describes one local or remote branch with its upstream relationship.
// Ahead/Behind are only meaningful for local branches with an upstream.
type Branch struct {
	Name     string `json:"name"`
	OID      string `json:"oid"`
	Current  bool   `json:"current"`
	Remote   bool   `json:"remote"`
	Upstream string `json:"upstream,omitempty"`
	Ahead    int    `json:"ahead"`
	Behind   int    `json:"behind"`
}

// StashEntry describes one saved stash. Ref is the current stash@{n} reference
// used to address the stash in later operations; the list is re-read after
// every stash mutation so indices stay valid.
type StashEntry struct {
	Ref     string `json:"ref"`
	OID     string `json:"oid"`
	Message string `json:"message"`
	Branch  string `json:"branch,omitempty"`
}

// Tag describes one tag. OID is the commit the tag ultimately points at (the
// peeled object), so callers can resolve annotated and lightweight tags alike.
type Tag struct {
	Name      string `json:"name"`
	OID       string `json:"oid"`
	Annotated bool   `json:"annotated"`
}

// ConflictEntry describes one unmerged file during a merge, rebase, cherry-pick,
// or revert. Stages 1–3 carry the base, ours, and theirs OIDs from the index;
// empty means that side has no blob (e.g. an added file).
type ConflictEntry struct {
	Path           string `json:"path"`
	BaseOID        string `json:"baseOid,omitempty"`
	OursOID        string `json:"oursOid,omitempty"`
	TheirsOID      string `json:"theirsOid,omitempty"`
	Mode           string `json:"mode,omitempty"`
	CanResolveBoth bool   `json:"canResolveBoth"`
}
