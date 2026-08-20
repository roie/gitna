package server

import "time"

// Request body limits.
const (
	// MaxRequestBody bounds ordinary mutation bodies (stage, unstage,
	// discard, delete, commit, branch, stash, tag operations).
	MaxRequestBody int64 = 1 << 20 // 1 MiB
	// MaxPatchRequestBody allows bounded unified patches carried in JSON.
	MaxPatchRequestBody int64 = 20 << 20 // 20 MiB
)

// Per-route timeouts applied via context.WithTimeout on the server side.
// These protect against hanging Git commands (e.g. a fetch to a dead remote).
const (
	// Read timeouts.
	SnapshotTimeout = 30 * time.Second
	DiffTimeout     = 10 * time.Second
	ReviewTimeout   = 30 * time.Second
	GraphTimeout    = 15 * time.Second
	ReadTimeout     = 15 * time.Second // branches, stashes, tags, conflicts, compare, commit-files

	// Mutation timeouts.
	LocalMutationTimeout = 60 * time.Second  // stage, unstage, discard, delete, commit, branch, stash, tag, history ops
	NetworkTimeout       = 120 * time.Second // fetch, pull, push, push-upstream, push-tag

	// Commit timeout (hooks may take a while).
	CommitTimeout = 60 * time.Second
)

// pathBatchLimit bounds one path-level mutation before it reaches Git.
const pathBatchLimit = 1_000

// snapshotFileLimit bounds serialized entries returned in one snapshot.
const snapshotFileLimit = 10_000

func operationRequestBodyLimit(op string) int64 {
	if op == OpPatch {
		return MaxPatchRequestBody
	}
	return MaxRequestBody
}

// graphMaxPage is the hard maximum for a single history page. The default
// page size is 100; this caps pathological skip values.
const graphMaxPage = 500
