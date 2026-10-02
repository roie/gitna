package watch

import (
	"context"
	"testing"
	"time"
)

func TestSlowRecoveryScanDoesNotBlockFileNotifications(t *testing.T) {
	root := trackedRepo(t)
	started := make(chan struct{})
	release := make(chan struct{})
	w := startWatcher(t, root, Options{
		Debounce: 10 * time.Millisecond,
		Fingerprint: func(context.Context) (string, error) {
			close(started)
			<-release
			return "same", nil
		},
	})
	defer close(release)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("recovery scan did not start")
	}
	writeFile(t, root, "tracked.txt", "changed during recovery scan\n")
	select {
	case kind := <-w.Events():
		if kind != InvalidateSnapshot {
			t.Fatalf("got %s, want %s", kind, InvalidateSnapshot)
		}
	case <-time.After(time.Second):
		t.Fatal("slow recovery scan blocked file notification")
	}
}

func TestDefaultFallbackKeepsFingerprintDutyCycleBelowIdleBudget(t *testing.T) {
	for _, cost := range []time.Duration{time.Millisecond, 100 * time.Millisecond, 350 * time.Millisecond, time.Second} {
		delay := defaultFallbackDelay(cost)
		if delay < 10*time.Second {
			t.Fatalf("cost %s: recovery interval %s is below the minimum", cost, delay)
		}
		if duty := float64(cost) / float64(cost+delay); duty > 0.01 {
			t.Errorf("cost %s: fingerprint duty cycle %.2f%% exceeds the 1%% idle budget", cost, duty*100)
		}
	}
}
