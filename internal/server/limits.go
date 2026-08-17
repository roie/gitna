package server

import "time"

// Request body limits.
const (
	// MaxRequestBody bounds ordinary mutation bodies (stage, unstage,
	// discard, delete, commit, branch, stash, tag operations).
	MaxRequestBody int64 = 1 << 20 // 1 MiB
)

// Per-route timeouts applied via context.WithTimeout on the server side.
// These protect against hanging Git commands (e.g. a fetch to a dead remote).
const (
	// Read timeouts.
	SnapshotTimeout = 30 * time.Second
	DiffTimeout     = 10 * time.Second
	GraphTimeout    = 15 * time.Second
	ReadTimeout     = 15 * time.Second // branches, stashes, tags, conflicts, compare, commit-files

	// Mutation timeouts.
	LocalMutationTimeout = 60 * time.Second  // stage, unstage, discard, delete, commit, branch, stash, tag, history ops
	NetworkTimeout       = 120 * time.Second // fetch, pull, push, push-upstream, push-tag

	// Commit timeout (hooks may take a while).
	CommitTimeout = 60 * time.Second
)

// snapshotFileLimit bounds the number of files returned in a snapshot to avoid
// shipping enormous payloads. This is a soft limit enforced by the gitx layer;
// the server returns an error if it is exceeded.
const snapshotFileLimit = 10_000

// graphMaxPage is the hard maximum for a single history page. The default
// page size is 100; this caps pathological skip values.
const graphMaxPage = 500
