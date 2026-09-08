package gitx

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

func TestMutationQueueExecutesOneAtATime(t *testing.T) {
	q := NewMutationQueue()
	t.Cleanup(func() { q.Stop(); q.Wait() })
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
	t.Cleanup(func() { q.Stop(); q.Wait() })
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
	t.Cleanup(func() { q.Stop(); q.Wait() })
	gate := make(chan struct{})
	q.queue <- &queueJob{
		ctx:  context.Background(),
		fn:   func(context.Context) error { <-gate; return nil },
		done: make(chan error, 1),
	}

	cancelledCtx, cancel := context.WithCancel(context.Background())
	called := false
	skipped := make(chan error, 1)
	q.queue <- &queueJob{
		ctx: cancelledCtx,
		fn: func(context.Context) error {
			called = true
			return nil
		},
		done: skipped,
	}
	cancel()
	close(gate)

	select {
	case err := <-skipped:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("queued cancellation = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("queue stalled")
	}
	if called {
		t.Fatal("cancelled queued job executed")
	}
}

func TestMutationQueueDoCancelledBeforeStart(t *testing.T) {
	q := NewMutationQueue()
	t.Cleanup(func() { q.Stop(); q.Wait() })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := q.Do(ctx, func(context.Context) error { return nil }); err == nil {
		t.Fatal("Do with cancelled context = nil error, want ctx.Err")
	}
}

func TestMutationQueueCallerCancellationDoesNotInterruptRunningJob(t *testing.T) {
	q := NewMutationQueue()
	t.Cleanup(func() { q.Stop(); q.Wait() })
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

func TestMutationQueueStopDrainsAcceptedJobsAndExits(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := NewMutationQueue()
		gate := make(chan struct{})
		var order []int
		go func() {
			if err := q.Do(context.Background(), func(context.Context) error {
				<-gate
				return nil
			}); err != nil {
				t.Errorf("running job: %v", err)
			}
		}()
		synctest.Wait()
		for i := range cap(q.queue) {
			job := &queueJob{
				ctx: context.Background(),
				fn: func(context.Context) error {
					order = append(order, i)
					return nil
				},
				done: make(chan error, 1),
			}
			if err := q.enqueue(job); err != nil {
				t.Fatal(err)
			}
		}
		cancelCtx, cancel := context.WithCancel(context.Background())
		cancelled := make(chan error, 1)
		go func() {
			cancelled <- q.Do(cancelCtx, func(context.Context) error {
				t.Error("cancelled full-queue submission ran")
				return nil
			})
		}()
		synctest.Wait()
		cancel()
		if err := <-cancelled; !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled full-queue admission: %v", err)
		}
		const callers = 32
		results := make(chan error, callers)
		for range callers {
			go func() {
				results <- q.Do(context.Background(), func(context.Context) error {
					t.Error("full-queue submission ran after Stop")
					return nil
				})
			}()
		}
		synctest.Wait() // All submitters are blocked on the full queue.
		var stoppers sync.WaitGroup
		for range callers {
			stoppers.Go(q.Stop)
		}
		stoppers.Wait() // Stop must not wait for the gated running mutation.
		for range callers {
			if err := <-results; !errors.Is(err, ErrMutationQueueClosed) {
				t.Fatalf("blocked admission: %v", err)
			}
		}
		if err := q.Do(context.Background(), func(context.Context) error {
			t.Error("job submitted after Stop ran")
			return nil
		}); !errors.Is(err, ErrMutationQueueClosed) {
			t.Fatalf("stopped admission: %v", err)
		}
		waited := make(chan struct{})
		go func() { q.Wait(); close(waited) }()
		synctest.Wait()
		select {
		case <-waited:
			t.Fatal("worker exited before drain")
		default:
		}
		close(gate)
		<-waited
		want := make([]int, cap(q.queue))
		for i := range want {
			want[i] = i
		}
		if !slices.Equal(order, want) {
			t.Fatalf("drained order = %v, want %v", order, want)
		}
		q.Stop()
		q.Wait()
	})
}

func TestMutationQueueStopSkipsCancelledQueuedJob(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := NewMutationQueue()
		gate := make(chan struct{})
		go func() {
			_ = q.Do(context.Background(), func(context.Context) error { <-gate; return nil })
		}()
		synctest.Wait()
		ctx, cancel := context.WithCancel(context.Background())
		returned := make(chan error, 1)
		go func() {
			returned <- q.Do(ctx, func(context.Context) error {
				t.Error("cancelled queued job ran during drain")
				return nil
			})
		}()
		synctest.Wait()
		cancel()
		if err := <-returned; !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
		q.Stop()
		close(gate)
		q.Wait()
	})
}

func TestMutationQueueStopPreservesRunningDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := NewMutationQueue()
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		running := make(chan context.Context, 1)
		completed := make(chan error, 1)
		returned := make(chan error, 1)
		go func() {
			returned <- q.Do(ctx, func(runCtx context.Context) error {
				running <- runCtx
				<-runCtx.Done()
				completed <- runCtx.Err()
				return runCtx.Err()
			})
		}()
		runCtx := <-running
		cancel()
		if err := <-returned; !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
		q.Stop()
		if err := runCtx.Err(); err != nil {
			t.Fatalf("Stop interrupted running job: %v", err)
		}
		q.Wait() // Virtual time advances to the original deadline.
		if err := <-completed; !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("running result: %v", err)
		}
	})
}

func TestMutationQueueConcurrentAdmissionAndStop(t *testing.T) {
	for range 50 {
		q := NewMutationQueue()
		var workers sync.WaitGroup
		for range 32 {
			workers.Go(func() {
				err := q.Do(context.Background(), func(context.Context) error { return nil })
				if err != nil && !errors.Is(err, ErrMutationQueueClosed) {
					t.Errorf("Do racing Stop: %v", err)
				}
			})
		}
		workers.Go(q.Stop)
		workers.Go(q.Stop)
		workers.Wait()
		q.Wait()
	}
}

func TestMutationQueueStopExitsIdleWorker(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := NewMutationQueue()
		synctest.Wait()
		q.Stop()
		q.Wait()
		select {
		case <-q.done:
		default:
			t.Fatal("Wait returned before worker exit")
		}
	})
}
