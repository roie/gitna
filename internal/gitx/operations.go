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
	queue     chan *queueJob
	admission sync.RWMutex
	stopping  chan struct{}
	done      chan struct{}
	once      sync.Once
}

type queueJob struct {
	ctx  context.Context
	fn   func(context.Context) error
	done chan error
}

// NewMutationQueue starts a queue that executes jobs one at a time. Its owner
// must Stop and Wait before releasing or replacing the repository backend.
func NewMutationQueue() *MutationQueue {
	q := &MutationQueue{
		queue:    make(chan *queueJob, 64),
		stopping: make(chan struct{}),
		done:     make(chan struct{}),
	}
	go q.run()
	return q
}

// ErrMutationQueueClosed is returned when a mutation is submitted after admission stops.
var ErrMutationQueueClosed = errors.New("gitx: mutation queue closed")

// Stop ends admission without interrupting accepted work. In-flight submissions
// may be accepted until Stop returns. Blocked submissions wake even if the queue
// is full and its running mutation cannot yet finish.
func (q *MutationQueue) Stop() {
	q.once.Do(func() {
		close(q.stopping)
		q.admission.Lock()
		close(q.queue)
		q.admission.Unlock()
	})
}

// Wait waits for the worker to drain accepted work and exit after Stop.
func (q *MutationQueue) Wait() {
	<-q.done
}

func (q *MutationQueue) run() {
	defer close(q.done)
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
// ctx.Err(). Submissions after Stop return ErrMutationQueueClosed.
func (q *MutationQueue) Do(ctx context.Context, fn func(context.Context) error) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	j := &queueJob{ctx: ctx, fn: fn, done: make(chan error, 1)}
	if err := q.enqueue(j); err != nil {
		return err
	}
	select {
	case err := <-j.done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (q *MutationQueue) enqueue(j *queueJob) error {
	q.admission.RLock()
	defer q.admission.RUnlock()
	select {
	case <-q.stopping:
		return ErrMutationQueueClosed
	default:
	}
	select {
	case q.queue <- j:
		return nil
	case <-q.stopping:
		return ErrMutationQueueClosed
	case <-j.ctx.Done():
		return j.ctx.Err()
	}
}

// ErrAlreadyInProgress is returned when a new merge or rebase is attempted
// while another operation is already in progress.
var ErrAlreadyInProgress = errors.New("gitx: another operation is already in progress")
