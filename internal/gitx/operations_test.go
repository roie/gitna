package gitx

import (
	"context"
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
