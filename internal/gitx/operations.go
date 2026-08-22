package gitx

import (
	"context"
	"errors"
	"sync"
)

// MutationQueue serializes repository mutations so concurrent requests cannot
// interleave Git operations. Jobs run in FIFO order; work whose context is
// cancelled while still queued is skipped rather than executed.
type MutationQueue struct {
	queue chan *queueJob
	once  sync.Once
}

type queueJob struct {
	ctx  context.Context
	fn   func(context.Context) error
	done chan error
}

// NewMutationQueue starts a queue that executes jobs one at a time.
func NewMutationQueue() *MutationQueue {
	q := &MutationQueue{queue: make(chan *queueJob, 64)}
	go q.run()
	return q
}

func (q *MutationQueue) run() {
	for j := range q.queue {
		if err := j.ctx.Err(); err != nil {
			j.done <- err
			continue
		}

		// Once a mutation starts, a disconnected caller must not interrupt Git
		// midway through changing the index or worktree. Keep the server-assigned
		// deadline, but detach execution from request cancellation.
		runCtx := context.WithoutCancel(j.ctx)
		cancel := func() {}
		if deadline, ok := j.ctx.Deadline(); ok {
			runCtx, cancel = context.WithDeadline(runCtx, deadline)
		}
		j.done <- j.fn(runCtx)
		cancel()
	}
}

// Do enqueues fn for exclusive execution and blocks until it completes. If ctx
// is cancelled before the job starts, fn does not run and ctx.Err() is
// returned. If the caller gives up while a job is running, the job still
// finishes (mutations are never left half-applied) but the caller sees
// ctx.Err().
func (q *MutationQueue) Do(ctx context.Context, fn func(context.Context) error) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	j := &queueJob{ctx: ctx, fn: fn, done: make(chan error, 1)}
	select {
	case q.queue <- j:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-j.done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// ErrAlreadyInProgress is returned when a new merge or rebase is attempted
// while another operation is already in progress.
var ErrAlreadyInProgress = errors.New("gitx: another operation is already in progress")
