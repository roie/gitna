// Package protocol defines the JSON contract between the Go backend and the
// browser. All repository data crosses the wire as these typed structures;
// raw Git CLI text never reaches the frontend.
package protocol

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
