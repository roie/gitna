package gitx

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"
)

func TestMutationQueueExecutesOneAtATime(t *testing.T) {
	q := NewMutationQueue()
	var mu sync.Mutex
	active := 0
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := q.Do(context.Background(), func(context.Context) error {
				mu.Lock()
				active++
				overlap := active != 1
				mu.Unlock()

				time.Sleep(2 * time.Millisecond)

				mu.Lock()
				active--
				mu.Unlock()
				if overlap {
					t.Error("jobs executed concurrently")
				}
				return nil
			})
			if err != nil {
				t.Errorf("Do: %v", err)
			}
		}()
	}
	wg.Wait()
}

func TestMutationQueueFifo(t *testing.T) {
	q := NewMutationQueue()
	var mu sync.Mutex
	var order []int
	done := make(chan struct{}, 5)
	for i := 0; i < 5; i++ {
		i := i
		q.queue <- &queueJob{
			ctx: context.Background(),
			fn: func(context.Context) error {
				mu.Lock()
				order = append(order, i)
				mu.Unlock()
				done <- struct{}{}
				return nil
			},
			done: make(chan error, 1),
		}
	}
	for range 5 {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("job did not run")
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(order, []int{0, 1, 2, 3, 4}) {
		t.Fatalf("execution order = %v, want FIFO [0 1 2 3 4]", order)
	}
}

func TestMutationQueueSkipsCancelledQueuedWork(t *testing.T) {
	q := NewMutationQueue()
	gate := make(chan struct{})
	q.queue <- &queueJob{
		ctx:  context.Background(),
		fn:   func(context.Context) error { <-gate; return nil },
		done: make(chan error, 1),
	}

	cancelledCtx, cancel := context.WithCancel(context.Background())
	called := false
	q.queue <- &queueJob{
		ctx: cancelledCtx,
		fn: func(context.Context) error {
			called = true
			return nil
		},
		done: make(chan error, 1),
	}
	cancel()
	close(gate)

	select {
	case <-time.After(200 * time.Millisecond):
	case <-time.After(5 * time.Second):
		t.Fatal("queue stalled")
	}
	if called {
		t.Fatal("cancelled queued job executed")
	}
}

func TestMutationQueueDoCancelledBeforeStart(t *testing.T) {
	q := NewMutationQueue()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := q.Do(ctx, func(context.Context) error { return nil }); err == nil {
		t.Fatal("Do with cancelled context = nil error, want ctx.Err")
	}
}

func TestMutationQueueCallerCancellationDoesNotInterruptRunningJob(t *testing.T) {
	q := NewMutationQueue()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	deadline, hasDeadline := ctx.Deadline()
	if !hasDeadline {
		t.Fatal("test context has no deadline")
	}
	started := make(chan context.Context, 1)
	finish := make(chan struct{})
	completed := make(chan struct{})

	doReturned := make(chan error, 1)
	go func() {
		doReturned <- q.Do(ctx, func(runCtx context.Context) error {
			started <- runCtx
			<-finish
			close(completed)
			return nil
		})
	}()

	runCtx := <-started
	cancel()
	if err := <-doReturned; !errors.Is(err, context.Canceled) {
		t.Fatalf("Do after caller cancellation = %v, want context.Canceled", err)
	}
	if err := runCtx.Err(); err != nil {
		t.Fatalf("running job context after caller cancellation = %v, want nil", err)
	}
	if runDeadline, ok := runCtx.Deadline(); !ok || !runDeadline.Equal(deadline) {
		t.Fatalf("running job deadline = %v, %t; want %v, true", runDeadline, ok, deadline)
	}

	close(finish)
	select {
	case <-completed:
	case <-time.After(5 * time.Second):
		t.Fatal("running job did not complete")
	}
}
